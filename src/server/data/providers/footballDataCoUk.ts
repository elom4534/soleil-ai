/**
 * ============================================================================
 * Fournisseur — football-data.co.uk
 * ============================================================================
 * Source : https://www.football-data.co.uk/
 * Conditions d'utilisation : données publiées librement pour un usage
 * statistique et analytique. Aucune clé API requise.
 *
 * Ce que ce fournisseur sait fournir :
 *   ✔ résultats finaux et scores à la mi-temps
 *   ✔ tirs, tirs cadrés, corners, cartons (selon compétition/saison)
 *   ✘ xG            → déclaré `false` dans les capacités, jamais simulé
 *   ✘ matchs à venir → déclaré `false`
 */

import { cached } from "../cache";
import { ProviderError, type DataProvider, type NormalizedFixture } from "./types";
import { num, parseCsv } from "./csv";
import { HISTORICAL_LEAGUES } from "@/lib/constants";

const BASE_URL = "https://www.football-data.co.uk/mmz4281";

/** Convertit une saison « 2026/2027 » ou « 2026 » en code source « 2627 ». */
export function toSeasonCode(season: string): string {
  const years = season.match(/\d{4}/g);
  if (!years || years.length === 0) throw new ProviderError("football-data-co-uk", `Saison invalide : ${season}`, false);
  if (years.length === 1) {
    const start = Number(years[0]);
    return `${String(start).slice(2)}${String(start + 1).slice(2)}`;
  }
  return `${years[0].slice(2)}${years[1].slice(2)}`;
}

/** Parse une date `DD/MM/YYYY` (format source) en Date UTC. */
function parseSourceDate(date: string, time: string | undefined): Date | null {
  const m = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const [hh, min] = (time && /^\d{1,2}:\d{2}$/.test(time) ? time : "15:00").split(":");
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min)));
}

export const footballDataCoUkProvider: DataProvider = {
  name: "football-data-co-uk",
  displayName: "football-data.co.uk",
  priority: 1,
  rateLimitPerMinute: 20,
  capabilities: {
    results: true,
    fixtures: false,
    matchStats: true,
    xg: false,
    halfTimeScores: true,
  },

  isConfigured() {
    return true; // aucune clé requise
  },

  async fetchCompetition({ competitionCode, season }) {
    const league = HISTORICAL_LEAGUES.find((l) => l.code === competitionCode);
    if (!league) {
      throw new ProviderError(
        "football-data-co-uk",
        `Compétition non couverte par cette source : ${competitionCode}`,
        false,
      );
    }

    const seasonCode = toSeasonCode(season);
    const cacheKey = `fdcouk:${seasonCode}:${competitionCode}`;
    // Un fichier de saison terminée ne change plus : TTL long.
    const ttl = 6 * 60 * 60;

    const { value, fromCache, stale } = await cached<NormalizedFixture[]>(
      cacheKey,
      ttl,
      async () => {
        const url = `${BASE_URL}/${seasonCode}/${competitionCode}.csv`;
        let response: Response;
        try {
          response = await fetch(url, {
            headers: { "User-Agent": "SOLEIL/1.0 (plateforme d'analyse statistique)" },
            cache: "no-store",
            signal: AbortSignal.timeout(30_000),
          });
        } catch (e) {
          throw new ProviderError(
            "football-data-co-uk",
            `Échec réseau sur ${url} : ${(e as Error).message}`,
          );
        }
        if (response.status === 404) {
          // La saison n'existe pas encore côté source : ce n'est PAS une erreur.
          return [];
        }
        if (!response.ok) {
          throw new ProviderError(
            "football-data-co-uk",
            `Réponse HTTP ${response.status} sur ${url}`,
          );
        }
        const csv = await response.text();
        return parseFixtures(csv, league);
      },
    );

    void stale;
    return { data: value, requestCount: fromCache ? 0 : 1, fromCache, fetchedAt: new Date() };
  },
};

function parseFixtures(
  csv: string,
  league: { code: string; name: string; country: string },
): NormalizedFixture[] {
  const rows = parseCsv(csv);
  const fixtures: NormalizedFixture[] = [];

  for (const row of rows) {
    const home = row.HomeTeam;
    const away = row.AwayTeam;
    const date = row.Date;
    if (!home || !away || !date) continue;

    const utcDate = parseSourceDate(date, row.Time);
    if (!utcDate) continue;

    const homeScore = num(row.FTHG);
    const awayScore = num(row.FTAG);

    fixtures.push({
      externalId: `fdcouk:${league.code}:${utcDate.toISOString()}:${home}-${away}`,
      sourceRef: `fdcouk:${league.code}`,
      competition: { code: league.code, name: league.name, country: league.country },
      utcDate,
      status: homeScore !== null && awayScore !== null ? "finished" : "scheduled",
      homeTeamName: home,
      awayTeamName: away,
      homeScore,
      awayScore,
      halfTimeHomeScore: num(row.HTHG),
      halfTimeAwayScore: num(row.HTAG),
        // football-data.co.uk publie `HxG`/`AxG` sur les saisons récentes, et pas
        // sur les anciennes. `num()` renvoie `null` quand la colonne est absente,
        // vide ou vaut « - » : une saison sans xG reste sans xG, rien n'est inventé.
        // (Le commentaire précédent affirmait à tort que la source n'en publie
        // jamais : c'est ce `null` codé en dur qui laissait le modèle xG à poids 0
        // en Bundesliga, Ligue 1 et Serie A.)
        homeXg: num(row.HxG),
        awayXg: num(row.AxG),
      homeShots: num(row.HS),
      awayShots: num(row.AS),
      homeShotsOnTarget: num(row.HST),
      awayShotsOnTarget: num(row.AST),
      homeCorners: num(row.HC),
      awayCorners: num(row.AC),
      homeYellowCards: num(row.HY),
      awayYellowCards: num(row.AY),
      // `HR`/`AR` étaient publiés par la source mais jamais lus : c'est ce qui
      // laissait les cartons rouges à 0 en Premier League et en La Liga.
      homeRedCards: num(row.HR),
      awayRedCards: num(row.AR),
      venue: null,
      referee: row.Referee || null,
    });
  }

  return fixtures.sort((a, b) => a.utcDate.getTime() - b.utcDate.getTime());
}

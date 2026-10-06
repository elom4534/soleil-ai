/**
 * ============================================================================
 * SOLEIL AI — Boîte à outils de recherche interne (lecture seule)
 * ============================================================================
 * Chaque outil répond à une question précise de l'agent et renvoie des FAITS
 * traçables : toute valeur citée dans une réponse vient d'ici et porte sa
 * source (`db`) et sa référence (requête). Un outil ne renvoie jamais une
 * estimation : une information absente est renvoyée absente (§34).
 *
 * 🔒 Lecture seule — aucune écriture, aucun secret, aucune donnée du futur
 *    utilisée pour décrire le passé (le tri temporel est explicite partout).
 */

import { prisma } from "@/lib/prisma";

export interface Fact {
  /** Phrase courte, chiffrée quand c'est possible. */
  label: string;
  value: string;
  source: "db" | "web" | "inference";
  /** Origine vérifiable : nom d'outil (db) ou URL (web). */
  ref: string;
}

export function fact(label: string, value: string, ref: string, source: Fact["source"] = "db"): Fact {
  return { label, value, source, ref };
}

/* -------------------------------------------------------------------------- */
/* Équipes et matchs                                                          */
/* -------------------------------------------------------------------------- */

/** Alias français → noms de la base (clubs et sélections). */
const TEAM_ALIASES: Record<string, string> = {
  // Sélections nationales
  angleterre: "england", ecosse: "scotland", paysdegalles: "wales", irlande: "ireland",
  irlandedunord: "northern ireland", france: "france", espagne: "spain", italie: "italy",
  allemagne: "germany", portugal: "portugal", paysbas: "netherlands", belgique: "belgium",
  suisse: "switzerland", autriche: "austria", grece: "greece", turquie: "turkey",
  turkiye: "turkey", tchequie: "czech republic", tcheque: "czech republic", slovaquie: "slovakia",
  slovenie: "slovenia", hongrie: "hungary", roumanie: "romania", bulgarie: "bulgaria",
  serbie: "serbia", croatie: "croatia", bosnie: "bosnia", albanie: "albania",
  ukraine: "ukraine", pologne: "poland", suede: "sweden", norvege: "norway",
  danemark: "denmark", finlande: "finland", islande: "iceland",
  russie: "russia", israel: "israel", kazakhstan: "kazakhstan",
  georgie: "georgia", armenie: "armenia", azerbaidjan: "azerbaijan",
  feroe: "faroe islands", ilesferoe: "faroe islands",
  luxembourg: "luxembourg", moldavie: "moldova", bielorussie: "belarus",
  estonie: "estonia", lettonie: "latvia", lituanie: "lithuania", chypre: "cyprus",
  macedoine: "north macedonia",
  kosovo: "kosovo", montenegro: "montenegro", andorre: "andorra",
  saintmarin: "san marino", liechtenstein: "liechtenstein", gibraltar: "gibraltar",
  malte: "malta",
  // Sélections CONCACAF
  mexique: "mexico", etatsunis: "united states", usa: "united states", canada: "canada",
  jamaique: "jamaica", honduras: "honduras", costarica: "costa rica", panama: "panama",
  salvador: "el salvador", guatemala: "guatemala", haiti: "haiti", cuba: "cuba",
  trinite: "trinidad", suriname: "suriname", barbade: "barbados", bermudes: "bermuda",
  grenade: "grenada", guyane: "guyana", martinique: "martinique", guadeloupe: "guadeloupe",
  saintvinsaintvincent: "saint vincent", vincent: "saint vincent", maarten: "sint maarten",
  bahamas: "bahamas", bonaire: "bonaire", caicos: "turks and caicos", montserrat: "montserrat",
  dominican: "dominican", dominique: "dominica", nicaragua: "nicaragua", belize: "belize",
  antigua: "antigua", kitts: "saint kitts", lucia: "saint lucia",
  // Clubs (base EN/DE/IT/ES) — complément de la table d'alias historique
  barcelone: "barcelona", real: "real madrid", madrid: "madrid", seville: "sevilla",
  valence: "valencia", rome: "roma", naples: "napoli", turin: "torino",
  munich: "munchen", francfort: "frankfurt", cologne: "koln", arsenal: "arsenal",
  chelsea: "chelsea", liverpool: "liverpool", tottenham: "tottenham", mancity: "manchester city",
  manunited: "manchester united", manchester: "manchester", newcastle: "newcastle",
  bournemouth: "bournemouth", brighton: "brighton", everton: "everton", fulham: "fulham",
  leeds: "leeds", leicester: "leicester", westham: "west ham", wolves: "wolves",
  astonvilla: "aston villa", brentford: "brentford", crystalpalace: "crystal palace",
  nottingham: "nottingham", ipswich: "ipswich", southampton: "southampton",
  luton: "luton", sheffield: "sheffield", burnley: "burnley", malaga: "málaga",
  espanyol: "espanyol", vallecano: "rayo vallecano", bilbao: "athletic bilbao",
  alaves: "deportivo alavés", atletico: "atlético madrid",
};

function normKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Clés d'alias normalisées une fois pour toutes. */
const ALIAS_NORM = new Map(Object.entries(TEAM_ALIASES).map(([k, v]) => [normKey(k), v]));

export async function findTeam(name: string) {
  const clean = name.trim();
  if (!clean) return null;
  const norm = normKey;
  const target = norm(clean);
  // 1. Alias français explicites → on cherche le nom cible.
  const alias = ALIAS_NORM.get(target);
  const all = await prisma.team.findMany({ select: { id: true, name: true, shortName: true } });
  const searchFor = alias ? norm(alias) : target;
  const exact = all.find((t) => norm(t.name) === searchFor || norm(t.shortName ?? "") === searchFor);
  if (exact) return exact;
  if (alias) {
    const aliasPartial = all.filter((t) => norm(t.name).includes(searchFor) || searchFor.includes(norm(t.name)));
    if (aliasPartial.length === 1) return aliasPartial[0];
    if (aliasPartial.length > 1) {
      // Plusieurs variantes (équipes jeunes/féminines, graphies) : on garde le
      // nom principal — le plus court, le moins qualifié — jamais deviné au hasard.
      aliasPartial.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
      return aliasPartial[0];
    }
  }
  // 2. Correspondance souple sur le nom donné.
  const partial = all.filter((t) => norm(t.name).includes(target) || target.includes(norm(t.name)));
  if (partial.length === 1) return partial[0];
  return partial.length > 1 ? { ambiguous: partial } : null;
}

export async function findMatchBetween(teamAId: string, teamBId: string, upcoming = true) {
  return prisma.match.findFirst({
    where: {
      OR: [
        { homeTeamId: teamAId, awayTeamId: teamBId },
        { homeTeamId: teamBId, awayTeamId: teamAId },
      ],
      ...(upcoming ? { status: "SCHEDULED", utcDate: { gt: new Date() } } : { status: "FINISHED" }),
    },
    orderBy: { utcDate: upcoming ? "asc" : "desc" },
    include: { league: true, homeTeam: true, awayTeam: true, season: true },
  });
}

export async function getMatchById(id: string) {
  return prisma.match.findUnique({
    where: { id },
    include: { league: true, homeTeam: true, awayTeam: true, season: true },
  });
}

export async function upcomingMatches(limit = 15, from = new Date()) {
  const rows = await prisma.match.findMany({
    where: { status: "SCHEDULED", utcDate: { gte: from } },
    orderBy: { utcDate: "asc" },
    take: limit,
    include: { league: true, homeTeam: true, awayTeam: true },
  });
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Forme, domicile/extérieur, H2H                                             */
/* -------------------------------------------------------------------------- */

export interface FormSummary {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  xgFor: number | null;
  xgAgainst: number | null;
  results: string; // ex. "V V N D V"
  lastDate: string | null;
}

async function summarize(
  rows: { homeTeamId: string; awayTeamId: string; homeScore: number | null; awayScore: number | null; utcDate: Date; liveData: { homeXg: number | null; awayXg: number | null } | null }[],
  teamId: string,
): Promise<FormSummary> {
  let wins = 0, draws = 0, losses = 0, gf = 0, ga = 0, xgf = 0, xga = 0, xgCount = 0;
  const results: string[] = [];
  for (const m of rows) {
    const home = m.homeTeamId === teamId;
    const us = home ? m.homeScore : m.awayScore;
    const them = home ? m.awayScore : m.homeScore;
    if (us === null || them === null) continue;
    gf += us;
    ga += them;
    if (us > them) { wins++; results.push("V"); } else if (us === them) { draws++; results.push("N"); } else { losses++; results.push("D"); }
    const xg = m.liveData;
    if (xg) {
      const xu = home ? xg.homeXg : xg.awayXg;
      const xt = home ? xg.awayXg : xg.homeXg;
      if (xu !== null && xt !== null) { xgf += xu; xga += xt; xgCount++; }
    }
  }
  const played = wins + draws + losses;
  return {
    played,
    wins,
    draws,
    losses,
    goalsFor: gf,
    goalsAgainst: ga,
    xgFor: xgCount ? Math.round((xgf / xgCount) * 100) / 100 : null,
    xgAgainst: xgCount ? Math.round((xga / xgCount) * 100) / 100 : null,
    results: results.slice(0, 8).join(" "),
    lastDate: rows.length ? rows[0].utcDate.toISOString().slice(0, 10) : null,
  };
}

/** Forme récente : les `limit` derniers matchs TERMINÉS avant `asOf` (jamais le futur). */
export async function teamForm(teamId: string, limit = 8, asOf = new Date()): Promise<FormSummary & { facts: Fact[] }> {
  const rows = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: { lt: asOf },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
    orderBy: { utcDate: "desc" },
    take: limit,
    select: {
      homeTeamId: true,
      awayTeamId: true,
      homeScore: true,
      awayScore: true,
      utcDate: true,
      liveData: { select: { homeXg: true, awayXg: true } },
    },
  });
  const s = await summarize(rows, teamId);
  const perGame = s.played ? Math.round((s.goalsFor / s.played) * 100) / 100 : null;
  const facts = [
    fact(`Forme (${s.played} derniers matchs)`, s.results || "aucun match terminé", "tools.teamForm"),
    fact("Bilan", `${s.wins}V-${s.draws}N-${s.losses}D · buts ${s.goalsFor}-${s.goalsAgainst}`, "tools.teamForm"),
  ];
  if (perGame !== null) facts.push(fact("Moyenne de buts marqués", `${perGame} / match`, "tools.teamForm"));
  if (s.xgFor !== null) facts.push(fact("xG moyen (échantillon dispo.)", `${s.xgFor} pour · ${s.xgAgainst} contre`, "tools.teamForm"));
  if (s.lastDate) facts.push(fact("Dernier match joué", s.lastDate, "tools.teamForm"));
  return { ...s, facts };
}

/** Répartition domicile / extérieur sur les matchs TERMINÉS. */
export async function homeAwaySplit(teamId: string, limit = 20, asOf = new Date()) {
  const rows = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: { lt: asOf },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
    orderBy: { utcDate: "desc" },
    take: limit,
    select: {
      homeTeamId: true,
      awayTeamId: true,
      homeScore: true,
      awayScore: true,
      utcDate: true,
      liveData: { select: { homeXg: true, awayXg: true } },
    },
  });
  const homeRows = rows.filter((r) => r.homeTeamId === teamId);
  const awayRows = rows.filter((r) => r.awayTeamId === teamId);
  const home = await summarize(homeRows, teamId);
  const away = await summarize(awayRows, teamId);
  const facts = [
    fact("À domicile", `${home.played} matchs · ${home.wins}V-${home.draws}N-${home.losses}D · buts ${home.goalsFor}-${home.goalsAgainst}`, "tools.homeAwaySplit"),
    fact("À l'extérieur", `${away.played} matchs · ${away.wins}V-${away.draws}N-${away.losses}D · buts ${away.goalsFor}-${away.goalsAgainst}`, "tools.homeAwaySplit"),
  ];
  return { home, away, facts };
}

/** Face-à-face : les `limit` dernières rencontres TERMINÉES entre deux équipes. */
export async function headToHead(teamAId: string, teamBId: string, limit = 8, asOf = new Date()) {
  const rows = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: { lt: asOf },
      OR: [
        { homeTeamId: teamAId, awayTeamId: teamBId },
        { homeTeamId: teamBId, awayTeamId: teamAId },
      ],
    },
    orderBy: { utcDate: "desc" },
    take: limit,
    include: { homeTeam: true, awayTeam: true },
  });
  const facts = rows.map((m) =>
    fact(
      `H2H ${m.utcDate.toISOString().slice(0, 10)}`,
      `${m.homeTeam.name} ${m.homeScore}-${m.awayScore} ${m.awayTeam.name}`,
      "tools.headToHead",
    ),
  );
  if (facts.length === 0) facts.push(fact("H2H", "aucune rencontre terminée entre ces deux équipes", "tools.headToHead"));
  return { rows, facts };
}

/* -------------------------------------------------------------------------- */
/* Statistiques détaillées et agrégats                                        */
/* -------------------------------------------------------------------------- */

export async function matchStats(matchId: string) {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    include: { liveData: true, homeTeam: true, awayTeam: true, league: true, season: true },
  });
  if (!m) return { match: null, facts: [fact("Match", "introuvable", "tools.matchStats")] };
  const ld = m.liveData;
  const facts: Fact[] = [];
  if (ld) {
    const pair = (label: string, h: number | null, a: number | null) => {
      if (h === null && a === null) return;
      facts.push(fact(label, `${h ?? "—"} / ${a ?? "—"}`, "tools.matchStats"));
    };
    pair("xG (domicile / extérieur)", ld.homeXg, ld.awayXg);
    pair("Tirs", ld.homeShots, ld.awayShots);
    pair("Tirs cadrés", ld.homeShotsOnTarget, ld.awayShotsOnTarget);
    pair("Corners", ld.homeCorners, ld.awayCorners);
    pair("Cartons jaunes", ld.homeYellowCards, ld.awayYellowCards);
    pair("Cartons rouges", ld.homeRedCards, ld.awayRedCards);
    pair("Possession (%)", ld.homePossession, ld.awayPossession);
  } else {
    facts.push(fact("Statistiques détaillées", "absentes de la base pour ce match", "tools.matchStats"));
  }
  return { match: m, facts };
}

/** Moyennes sur une fenêtre glissante d'un an — signaux de style de jeu. */
export async function teamAverages(teamId: string, asOf = new Date()) {
  const rows = await prisma.match.findMany({
    where: {
      status: "FINISHED",
      utcDate: { gte: new Date(asOf.getTime() - 365 * 86_400_000), lt: asOf },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
    select: {
      homeTeamId: true,
      liveData: { select: { homeShots: true, awayShots: true, homeShotsOnTarget: true, awayShotsOnTarget: true, homeCorners: true, awayCorners: true, homeYellowCards: true, awayYellowCards: true, homeXg: true, awayXg: true } },
    },
  });
  let n = 0, shots = 0, sot = 0, corners = 0, yell = 0, xg = 0, xgN = 0;
  for (const r of rows) {
    const ld = r.liveData;
    if (!ld) continue;
    const home = r.homeTeamId === teamId;
    const s = home ? ld.homeShots : ld.awayShots;
    const t = home ? ld.homeShotsOnTarget : ld.awayShotsOnTarget;
    const c = home ? ld.homeCorners : ld.awayCorners;
    const y = home ? ld.homeYellowCards : ld.awayYellowCards;
    const x = home ? ld.homeXg : ld.awayXg;
    n++;
    if (s !== null) shots += s;
    if (t !== null) sot += t;
    if (c !== null) corners += c;
    if (y !== null) yell += y;
    if (x !== null) { xg += x; xgN++; }
  }
  const per = (v: number) => (n ? Math.round((v / n) * 100) / 100 : null);
  const facts: Fact[] = [];
  if (n === 0) {
    facts.push(fact("Statistiques moyennes (12 mois)", "aucune donnée exploitable", "tools.teamAverages"));
  } else {
    facts.push(
      fact(
        `Moyennes (12 mois, ${n} matchs avec stats)`,
        `tirs ${per(shots)} · cadrés ${per(sot)} · corners ${per(corners)} · jaunes ${per(yell)}` +
          (xgN ? ` · xG ${Math.round((xg / xgN) * 100) / 100} (${xgN} matchs)` : ""),
        "tools.teamAverages",
      ),
    );
  }
  return { sample: n, facts };
}

/* -------------------------------------------------------------------------- */
/* Compétitions, prédictions, contexte de prédiction                           */
/* -------------------------------------------------------------------------- */

export async function competitionInfo(leagueId: string) {
  const league = await prisma.league.findUnique({ where: { id: leagueId }, include: { seasons: true } });
  if (!league) return { league: null, facts: [fact("Compétition", "introuvable", "tools.competitionInfo")] };
  const finished = await prisma.match.count({ where: { leagueId, status: "FINISHED" } });
  const scheduled = await prisma.match.count({ where: { leagueId, status: "SCHEDULED" } });
  return {
    league,
    facts: [
      fact("Compétition", `${league.name} · ${finished} matchs joués · ${scheduled} à venir`, "tools.competitionInfo"),
    ],
  };
}

export async function predictionInfo(matchId: string) {
  const pred = await prisma.prediction.findFirst({
    where: { matchId },
    orderBy: { generatedAt: "desc" },
  });
  if (!pred) {
    return { pred: null, facts: [fact("Prédiction du moteur", "aucune prédiction enregistrée pour ce match", "tools.predictionInfo")] };
  }
  const c = pred.confidenceScore as unknown;
  const facts = [
    fact(
      "Prédiction du moteur",
      `${pred.status} · confiance ${typeof c === "object" && c !== null ? JSON.stringify(c) : String(c)} · qualité ${pred.dataQuality} · version ${pred.modelVersion}`,
      "tools.predictionInfo",
    ),
    fact("Générée le", pred.generatedAt.toISOString().slice(0, 16), "tools.predictionInfo"),
  ];
  return { pred, facts };
}

/**
 * Contexte réellement exploitable par une prédiction : combien de matchs
 * terminés chaque équipe avait-elle avant la date du match (les données du
 * futur ne comptent jamais), et la référence de compétition disponible.
 */
export async function predictionContext(matchId: string) {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { utcDate: true, leagueId: true, seasonId: true, homeTeamId: true, awayTeamId: true },
  });
  if (!m) return { facts: [fact("Contexte", "match introuvable", "tools.predictionContext")], priorHome: 0, priorAway: 0, leagueRef: 0 };
  const prior = { status: "FINISHED" as const, utcDate: { lt: m.utcDate } };
  const [priorHome, priorAway, leagueRef] = await Promise.all([
    prisma.match.count({ where: { ...prior, OR: [{ homeTeamId: m.homeTeamId }, { awayTeamId: m.homeTeamId }] } }),
    prisma.match.count({ where: { ...prior, OR: [{ homeTeamId: m.awayTeamId }, { awayTeamId: m.awayTeamId }] } }),
    prisma.match.count({ where: { ...prior, leagueId: m.leagueId, seasonId: m.seasonId } }),
  ]);
  return {
    priorHome,
    priorAway,
    leagueRef,
    facts: [
      fact(
        "Contexte exploitable (avant la date du match)",
        `${priorHome} match(s) pour l'équipe à domicile · ${priorAway} pour l'équipe à l'extérieur · ${leagueRef} dans la compétition/saison`,
        "tools.predictionContext",
      ),
    ],
  };
}

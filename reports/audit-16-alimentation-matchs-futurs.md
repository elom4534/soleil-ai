# SOLEIL — Phase 16 · AUDIT DE L'EXISTANT (ÉTAPES 1 à 5)

**Date :** 30/09/2026 · **Mode :** audit seul — **aucune modification, aucun appel payant, 0 crédit consommé**
**Périmètre :** alimentation en matchs futurs · logos · prédictions · affichage

> Ce document répond aux ÉTAPES 1 à 5 du §33. Il décrit **ce qui existe déjà**, ce qui est
> réutilisable tel quel, ce qui manque, et s'arrête net avant toute action (§34).
> Les appels payants proposés sont en fin de document, sous forme de tableau §5, **non exécutés**.

---

## 0. Résumé exécutif

| Question | Réponse courte |
|---|---|
| Un synchroniseur existe-t-il ? | **Oui** — `src/server/jobs/sync.ts` (347 lignes), pipeline complet ingestion → prédiction → règlement |
| Une source de matchs futurs est-elle branchée ? | **Oui, partiellement** — TheSportsDB (gratuit) déclare `fixtures: true` ; le connecteur LiveFootballApi sait le faire mais **n'est pas branché au pipeline** |
| Des tâches cron existent-elles ? | **Non — aucune.** Ni crontab, ni timer systemd, ni route planifiée, ni ordonnanceur applicatif. C'est un élément de feuille de route, jamais implémenté |
| La base contient-elle des matchs futurs ? | **Aucun** — 8 360 rencontres, **100 % terminées**, plage 2015-08-08 → 2026-05-24 |
| Les logos des équipes existent-ils ? | **Non** — `Team.crest` est vide sur les 65 équipes ; `League.logo`/`flag` vides ; `AssetCache` vide |
| Que peut-on faire avec 0 crédit ? | Ingérer les calendriers de TheSportsDB (gratuit) + badges TheSportsDB (gratuit) ; tout le reste du travail (filtre, pipeline, cache logos, tests) est hors réseau |
| Coût minimal pour des matchs futurs réels via LiveFootballApi | **1 crédit** = une journée complète de rencontres (786 à venir observées le 03/10/2026 lors de la sonde du 29/09) |
| Le moteur doit-il changer ? | **Non.** Rien dans cet audit ne touche au moteur, au poids xG, au 1X2 ni aux backtests |

---

## 1. ÉTAPE 1 — Le synchroniseur existant

### 1.1 `src/server/jobs/sync.ts` — pipeline quotidien (§25 du cahier initial)

Douze étapes déclarées en tête de fichier, toutes implémentées :

```
1-4   récupérer → nettoyer → valider → ingérer      (par compétition × fournisseur × saison)
5-11  statistiques → modèles → probabilités → consensus → confiance → sélection
12    publier automatiquement
```

Points vérifiés dans le code :

| Élément | État |
|---|---|
| Verrou d'exécution | **Oui** — `running` : deux synchronisations simultanées impossibles |
| Multi-source avec repli | **Oui** — boucle sur `PROVIDERS`, un échec n'interrompt pas le suivant |
| Idempotence | **Oui** — `upsert` par `externalId` unique + fusion prudente (`patch` champ par champ) |
| Déduplication | **Oui** — `externalId` fournisseur, plus une clé de secours `homeTeamId\|awayTeamId\|jour±1` |
| Journalisation | **Oui** — `DataSyncLog` (STARTED/SUCCESS/PARTIAL/FAILED, durée, erreur) |
| Prédiction des matchs à venir | **Oui** — `generateUpcomingPredictions(max)` sur `status=SCHEDULED AND utcDate > now` |
| Règlement des prédictions passées | **Oui** — `settlePredictions(800)` |
| Historique (backfill honnête) | **Oui** — `backfillHistory()` avec `asOf` par rencontre |
| Rétention / purge | Non présente (hors périmètre Phase 16) |

**Ce que ce pipeline ne fait pas :** il n'écrit **aucun logo**, **aucun identifiant fournisseur
d'équipe**, et ne mappe pas les statuts au-delà de cinq valeurs (`mapStatus`).

### 1.2 Le registre des fournisseurs — `src/server/data/providers/index.ts`

```ts
export const PROVIDERS = [footballDataCoUk, theSportsDb, footballDataOrg].sort(by priority);
```

| Fournisseur | Priorité | `results` | `fixtures` | `matchStats` | `xg` | `halfTime` | Clé requise |
|---|---|---|---|---|---|---|---|
| football-data.co.uk | 1 | ✔ | **✘** | ✔ | ✘ | ✔ | aucune |
| TheSportsDB | 2 | ✔ | **✔** | ✘ | ✘ | ✘ | aucune (clé publique `3`) |
| football-data.org | 1 | ✔ | ✔ | ✘ | ✘ | ✔ | `FOOTBALL_DATA_API_KEY` — **vide** |

- **TheSportsDB** est donc, à ce jour, la **seule source de calendrier réellement utilisable à
  coût nul** du pipeline. Elle est déjà implémentée : `eventsnextleague.php` (15 prochains
  matchs) + `eventspastleague.php`, avec déduplication et lecture de `strTimestamp` puis
  normalisation du fuseau en UTC (`new Date(raw.endsWith("Z") || raw.includes("+") ? raw : raw + "Z")`).
  12 compétitions sont mappées (`TSDB_LEAGUE_IDS`), dont `E0 = 4328` et `SP1 = 4335`.
- **football-data.co.uk** ne fournit **aucun** calendrier (`fixtures: false`) : c'est la source de
  l'historique, pas celle du futur.

### 1.3 Le connecteur LiveFootballApi — présent, puissant, **non branché**

`src/server/data/providers/apiFootballLive/` (1 893 lignes) — **hors registre**, utilisé
uniquement par des scripts (`probe-api`, `compare-*`, `backtest/xg-enrich`).

| Brique | Contenu | Réutilisable pour la Phase 16 ? |
|---|---|---|
| `client.ts` | Cache, single-flight, budget quotidien, rotation de clé, timeout 25 s, back-off, journalisation | **Oui, tel quel** |
| `credentials.ts` | `KeyRing` : lecture des 18 clés, compteurs `usedToday`/`usedTotal`, écriture `ApiCallLog`, remise à zéro quotidienne | Oui, **mais voir §7.1 (rotation à restreindre)** |
| `adapter.ts` | `getMatches(date)`, `getCompetitionFixtures`, `getAvailableCompetitions`, `getMatch`, `getMatchStatistics`, `getEvents`, `getStandings`, `getH2H`, `getTeamMatches` | **Oui** — c'est le socle direct de la Phase 16 |
| `normalize.ts` | `normalizeStatus` (preGame/inPlay/postGame/FT/… → 7 statuts internes), `normalizeMatch` (**lit le logo d'équipe**), `normalizeStats`, `normalizeEvents` | **Oui** |

**Fait notable :** `normalizeMatch` extrait déjà `home.logo` / `away.logo`, et `normalizeStatus`
couvre `preGame`, `postponed`, `cancelled`, `inPlay`, `postGame`, `half-time`. La matière
première du §9 et du §15 est **déjà écrite** ; il manque le branchement et la persistance.

### 1.4 Cache — `src/server/data/cache.ts`

- Persistant en base (`SystemConfig`, clés `cache:*`), avec `expiresAt`, réhydratation des
  dates, **single-flight**, et repli sur valeur périmée en cas d'échec réseau (`stale: true`).
- Purge des entrées expirées disponible (`cachePurgeExpired`).
- **État actuel en base : 0 entrée.** Rien n'a encore été mis en cache sur cette machine.

### 1.5 Journalisation

| Table | Rôle | Lignes en base |
|---|---|---|
| `DataSyncLog` | une ligne par couple fournisseur × compétition × saison | 0 |
| `ApiCallLog` | un appel : coût, statut HTTP, durée, cache, **solde après appel** | 0 |
| `ApiCredential` | une ligne par clé : quota, consommation, erreurs consécutives, usage par endpoint | 0 |
| `DataSource` | registre des sources (priorité, dernier sync, compteur d'erreurs) | 0 |
| `AdminLog` | journal des actions d'administration | 0 |

**§26 (journal des crédits) est donc structurellement prêt mais vide** : il se remplira dès le
premier appel réel via le `KeyRing`.

### 1.6 Tâches planifiées — **AUCUNE**

Vérifications faites sur cette machine :

```
crontab -l                 → command not found
/etc/cron.daily            → apt-compat, dpkg (système uniquement)
routes Next src/app/api/** → une seule route : /api/ai/chat
ordonnanceur applicatif    → aucun setInterval / scheduler dans src/server ou scripts
fichiers de déploiement    → aucun (pas de Procfile, vercel.json, ecosystem.config)
```

**Conclusion :** les « trois tâches cron » attendues **n'existent pas**. Le seul document qui en
parle est `ARCHITECTURE.md`, ligne 249, et il les présente comme un objectif de **moyen terme**
(« Synchronisation planifiée (cron ou tâche planifiée) plutôt que déclenchée manuellement »).

→ **Signalement §27 effectué avant toute création.** Voir décision demandée en fin de document.

---

## 2. ÉTAPE 2 — Source actuelle des matchs futurs : état réel

| Chemin | État aujourd'hui |
|---|---|
| Base locale | **0 rencontre future** — 8 360 rencontres, toutes `FINISHED` |
| TheSportsDB (gratuit) | Écrit, mappé pour 12 compétitions, **jamais exécuté sur cette machine** (0 ligne en base, 0 entrée de cache) |
| LiveFootballApi (payant) | Écrit, **hors registre**, jamais branché au pipeline |
| football-data.org | Clé vide → `isConfigured()` faux |
| Fichiers locaux | `data/normalized/fdcouk/**` = historique joué uniquement ; `data/features/live-football-api/**` = xG 2024-2025 |

**Preuves déjà collectées** (rapports de sonde du 29/09, **0 crédit supplémentaire**) :

| Endpoint | Résultat observé | Coût |
|---|---|---|
| `GET /matches?date=2026-10-03` | **786 rencontres à venir** (748 `preGame`, 35 `postponed`, 3 `cancelled`), ligue + pays + **logos des deux équipes** | 1 crédit |
| `GET /matches?date=2026-09-29` | 193 rencontres du jour : 162 terminées, 27 à venir, 4 en direct | 1 crédit |
| `GET /matches?date=2026-09-26` | 819 rencontres : 802 terminées, 17 à venir | 1 crédit |
| `GET /league_fixtures` | saison entière en **1 appel** : 495 rencontres, 90 à venir, dates couvertes 2026-01-22 → 2026-11-08 | 1 crédit |
| `GET /leagues` | 159 pays, **1 416 compétitions**, avec identifiant, nom, pays et **logo** | 1 crédit |
| `GET /live_match_details` | 32 statistiques dont **`Expected Goals (xG)`** ; logos des équipes ; événements horodatés | 1 crédit / match |

**Ce que cela signifie pour la Phase 16 :** un seul appel `[/matches?date=…]` fournit, pour une
journée entière, **tout ce qu'exige le §7** (identifiants fournisseur, horaire, statut, logos,
compétition, pays). Le chemin est donc réaliste et peu coûteux — mais il consomme des crédits,
d'où le §5 ci-dessous.

---

## 3. ÉTAPE 4 — Tables existantes et ce qu'elles couvrent

| Besoin Phase 16 | Table / champ existant | Verdict |
|---|---|---|
| Matchs futurs | `Match` (`utcDate`, `status`, `externalId` unique) | ✔ suffisant |
| Statut normalisé (§9) | `enum MatchStatus` : SCHEDULED, LIVE, IN_PLAY, PAUSED, FINISHED, POSTPONED, CANCELLED, SUSPENDED | ✔ suffisant — `upcoming.ts` sait déjà le projeter en `UPCOMING/LIVE/FINISHED/POSTPONED/CANCELLED/UNKNOWN` |
| Horodatage non ambigu (§8) | `utcDate DateTime` (UTC) + fournisseur qui renvoie `timezone: "UTC"` | ✔ suffisant |
| Déduplication (§10) | `Match.externalId @unique` + clé de secours `home|away|jour±1` | ✔ suffisant pour un seul fournisseur ; **à étendre** pour un identifiant fournisseur stable |
| Identité d'équipe (§17) | `Team.externalId @unique` (aujourd'hui `slug:<nom>`), `resolveTeamId` (canonique + similarité, seuil 0,72, **refus en cas de doute**) | ⚠ **pas d'identifiant fournisseur** conservé ; `Ath Madrid`/`Atl. Madrid` déjà traités par la table d'alias — mais un id fournisseur serait plus sûr |
| Logos (§15, §16) | `Team.crest`, `League.logo`, `League.flag`, `AssetCache` (source, `lastVerified`, `reachable`) | ⚠ tables prêtes, **toutes vides** ; aucune écriture dans le pipeline |
| Pays (§15) | `League.country` + `countryCode` ; `Team.country` **vide sur les 65 équipes** | ⚠ à alimenter depuis la source, jamais depuis le nom |
| Fraîcheur (§20) | `Match.lastDataUpdate`, `Match.dataSources[]`, `DataSource.lastSync`, `AssetCache.lastVerified` | ✔ suffisant |
| Journal des crédits (§26) | `ApiCallLog` + `ApiCredential` | ✔ suffisant |
| Traçabilité d'apprentissage (§21) | `Prediction.modelVersion`, `ModelVersion`, `PredictionError`, `assets` | ✔ déjà en place (Phase 15) |
| Séparation test / production (§31) | — | ✘ **rien n'existe** : à prévoir explicitement |

---

## 4. ÉTAPE 5 — Ce qui est exploitable sans aucun appel

| Ressource locale | Contenu | Usage Phase 16 |
|---|---|---|
| `data/normalized/fdcouk/{E0,SP1}/<saison>.json` | 8 360 rencontres, 22 saisons (2015-2016 → 2025-2026), scores et mi-temps | Construire et **tester** tout le pipeline sans réseau |
| `data/features/live-football-api/{E0,SP1}/2024-2025.json` | 460 xG réels | Vérifier que le modèle xG reste applicable |
| `reports/probe-2026-09-29T21-46-25-457Z.json` (et 5 autres) | **14 endpoints réels documentés**, échantillons bruts, soldes 499 → 476 | Maquettes et tests d'intégration à partir de **réponses réelles**, sans appel |
| Base locale | 8 360 rencontres + 780 prédictions + 460 xG | Référence de non-régression |

**Conséquence pratique :** les tests §28 (dates, statuts, doublons, logos, API, affichage) peuvent
être écrits et exécutés **intégralement hors réseau**, en s'appuyant sur ces réponses réelles.

---

## 5. Ce qui manque — écarts à combler (aucun ne touche le moteur)

| # | Écart | Nature |
|---|---|---|
| 1 | **Ordonnancement** : aucune tâche planifiée | Infrastructure |
| 2 | **Branchement du connecteur LiveFootballApi au pipeline** (aujourd'hui réservé aux scripts) | Pipeline |
| 3 | **Identifiants fournisseur** (`provider_team_id`, `provider_match_id`, `provider_league_id`) non conservés | Modèle de données |
| 4 | **Récupération et cache des logos** : le normaliseur extrait les URL, personne ne les écrit | Pipeline + §15/§16 |
| 5 | **`Team.country` et `Team.crest` vides**, `League.logo`/`flag` vides | Données |
| 6 | **Aucune saison marquée courante** (`Season.isCurrent = 0`) | Données (corrigé par `refreshSeasonFlags()`, à exécuter) |
| 7 | **Séparation test / production** absente | Règle §31 |
| 8 | **Garde-fou de rotation des clés** : le `KeyRing` peut sélectionner les clés 2 à 18 automatiquement | Sécurité (voir §7.1) |
| 9 | Tests §28/§29/§30 absents (dates, statuts, doublons, logos, robustesse API, « aucun match terminé affiché ») | Qualité |
| 10 | Filtre utilisateur par jour (§18 : « Aujourd'hui / Demain / 2 octobre ») non implémenté | Interface |

---

## 6. État réel mesuré de la base (30/09/2026, 21 h 21 UTC)

```
Rencontres            8 360   · 100 % FINISHED  · 2015-08-08 → 2026-05-24  · futurs : 0
  · par compétition    Premier League 4 180 (11 saisons) · La Liga 4 180 (11 saisons)
  · source             football-data-co-uk (100 %)
  · qualité            EXCELLENT (8 360 / 8 360)
Équipes                  65   · crest : 0 · country : 0 · externalId « slug:… » (100 %)
Compétitions              2   · logo : 0 · flag : 0 · pays : England (GB), Spain (ES)
Saisons                  22   · isCurrent : 0
Prédictions             780   · (dont 776 réglées) — toutes historiques
xG réel                 460   · saison 2024-2025 uniquement
Cache (SystemConfig)      0 entrée
AssetCache                0   · ApiCallLog 0 · ApiCredential 0 · DataSource 0 · DataSyncLog 0
ModelVersion              0   · PredictionError 0
```

> Note d'environnement : le bac à sable a été **recyclé** en début de phase (node, `node_modules`
> et PostgreSQL détruits, `data/` intact). La base a été reconstruite avec `scripts/restore.sh`.
> Le script de restauration ne rejoue ni `learning-build.ts` ni les migrations de la Phase 15 sur
> les tables dérivées : `ModelVersion` et `PredictionError` sont vides **par construction**, pas
> par perte de données. Le moteur, lui, est intact.

---

## 7. Risques identifiés (à traiter avant d'écrire du code)

### 7.1 ⚠ Rotation automatique vers les clés 2 à 18

`readKeysFromEnv()` charge **les 18 clés** et `KeyRing.pick()` sélectionne la première clé non
épuisée : si la clé 1 tombe à 0 crédit, **le client basculera automatiquement sur la clé 2**.
Cela contredit la règle absolue en vigueur (« clés 2–18 : jamais utilisées automatiquement »).

**Correctif proposé (non appliqué) :** un plafond explicite du nombre de clés actives
(`SOLEIL_MAX_ACTIVE_KEYS=1`), les clés au-delà restant déclarées mais inutilisables, avec le
même journal dans `ApiCredential`.

### 7.2 ⚠ Prédiction impossible hors E0 / SP1

`buildMatchContext` exige une référence de compétition exploitable
(`computeLeagueBaseline`, ≥ 40 rencontres jouées). Un match future argent ou togolais importé
depuis une source ouverte serait donc **ingéré mais non prédit** — ce qui est le comportement
honnête attendu (§13 : « Données insuffisantes »), mais doit être **expliqué à l'utilisateur**,
pas découvert par lui.

### 7.3 ⚠ Volume des rencontres futures

Une seule journée mondiale = **786 rencontres**. À 3 jours importés, la base grandit de ~2 000
lignes, dont l'immense majorité n'est pas prédictible (pas d'historique). Le pipeline doit donc
**importer parcimonieusement** (compétitions ciblées) plutôt que « tout ce que renvoie la source ».

### 7.4 Le statut `SUSPENDED` et l'état `preGame`

`upcoming.ts` mappe `SUSPENDED` → `CANCELLED` (jamais affiché) et `SCHEDULED` → `UPCOMING`. Le
`preGame` du fournisseur est correctement classé `scheduled` par `normalizeStatus` (§1.3). **Ce
point est donc déjà couvert**, mais il sera couvert par le test §29 demandé.

---

## 8. STOP — plan d'appels payants proposé (§5), **non exécuté**

Rappel de la règle en vigueur : la clé 1 ne doit pas être touchée sans autorisation explicite ;
les clés 2 à 18 ne doivent jamais être utilisées.

### Option A — 0 crédit (TheSportsDB, gratuit)

| ENDPOINT | NOMBRE D'APPELS | COÛT ESTIMÉ | CLÉ UTILISÉE | DONNÉES RÉCUPÉRÉES | RAISON |
|---|---|---|---|---|---|
| `eventsnextleague.php?id=4328` (E0) | 1 | **0** | clé publique `3` | ≤ 15 prochains matchs anglais, horodatés | calendrier futur E0 |
| `eventsnextleague.php?id=4335` (SP1) | 1 | **0** | clé publique `3` | ≤ 15 prochains matchs espagnols | calendrier futur SP1 |
| `lookupteam.php?id=<équipe>` | ≤ 65 | **0** | clé publique `3` | badge officiel + pays de l'équipe | logos §15 + pays §17 |

**Limites honnêtes :** 15 rencontres maximum par compétition, quota de la clé publique partagée
(risque de limitation), aucune garantie de continuité. Ce n'est **pas** une solution de
production — c'est une solution de mise en route et de test, à coût nul.

### Option B — 1 crédit (LiveFootballApi, journée ciblée)

| ENDPOINT | NOMBRE D'APPELS | COÛT ESTIMÉ | CLÉ UTILISÉE | DONNÉES RÉCUPÉRÉES | RAISON |
|---|---|---|---|---|---|
| `GET /matches?date=<jour avec E0/SP1>` | **1** | **1 crédit** | **clé 1 uniquement** | toutes les rencontres de la journée : identifiants fournisseur, horaire UTC, statut, **logos des 2 équipes**, compétition, pays | matérialiser le pipeline complet sur des données réelles |

Sortie attendue : `provider_match_id`, `provider_league_id`, `provider_team_id`, logos, horaires.
Les rencontres retenues seraient **filtrées sur les compétitions où un historique existe**
(E0, SP1), seules candidates à une prédiction valide.

**Solde après opération : ≈ 1 crédit restant** (si 2 crédits confirmés), ou 15 si le solde réel
est celui reconstitué par la sonde (476 − 460 de Phase 11). **Le solde exact n'est pas
connaissable sans un appel** — c'est précisément pourquoi l'autorisation est demandée.

### Option C — report

Aucun appel : construire et tester l'ensemble du pipeline hors réseau (fixtures de réponses
réelles), livrer le code prêt, et laisser l'import réel à une phase ultérieure autorisée.

---

## 9. Ce que la Phase 16 peut livrer **sans aucun crédit**

1. Filtre `UPCOMING` durci + classification interne de statuts + tests §28/§29.
2. Pipeline d'ingestion des calendriers **avec logos et identifiants fournisseur**, idempotent,
   testé sur les réponses réelles archivées.
3. Branchement du connecteur LiveFootballApi au pipeline, **avec 0 appel** (le client est prêt).
4. Cache des logos (`AssetCache`) + repli monogramme/drapeau, jamais d'URL inventée.
5. Garde-fou « clé 1 uniquement » (§7.1).
6. Ordonnanceur : les 3 tâches manquantes, créées **désactivées** jusqu'à validation.
7. Filtre utilisateur « Aujourd'hui / Demain / … » (§18).
8. **Aucune modification du moteur** — l'empreinte doit rester identique.

---

## 10. Décisions demandées avant de poursuivre (§34)

| # | Question | Options |
|---|---|---|
| 1 | Autorisation d'appel payant | Option A (0 crédit) · Option B (1 crédit) · Option C (report) |
| 2 | Compétitions ciblées | E0 + SP1 uniquement · les 12 de football-data.co.uk · tout ce que renvoie la source |
| 3 | Tâches planifiées inexistantes | créer les 3 (désactivées) · créer et activer · ne rien créer |
| 4 | Test gratuit TheSportsDB (0 crédit) | autoriser · refuser |

**Aucune ligne de code ne sera écrite avant ces réponses**, conformément au §34.

---

## 11. Garanties de cet audit

```
Moteur modifié      : NON
Poids xG modifié    : NON
1X2 modifié         : NON
Backtest modifié    : NON
Crédits consommés   : 0
Appels réseau       : 0
Fichiers applicatifs modifiés : 0
```

Seule opération technique effectuée : **restauration de l'environnement** (`scripts/restore.sh`),
rendue nécessaire par le recyclage du bac à sable — aucune donnée projet perdue, `data/` intact.

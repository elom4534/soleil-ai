# SOLEIL — Rapport Phase 16

**Alimentation automatique des matchs futurs · logos · prédictions**

Date : 1ᵉʳ octobre 2026 · Phase : **pipeline construit et vérifié, ingestion réelle bloquée par le fournisseur** · Crédits consommés : **0**

---

## Le fait marquant de cette phase

**Le fournisseur refuse l'intégralité des clés : 18 sur 18, HTTP 403, message identique.**

```
HTTP 403 — « Access denied. Possible reasons: Invalid key, insufficient credits,
             daily limit exceeded, or inactive account. »
```

Trois séries d'appels documentées (toutes autorisées, toutes sans résultat) :

| # | Contexte | Appels | Réponses | Crédits |
|---|---|---|---|---|
| 1 | Appel autorisé (clé 1) + rotation automatique (clés 2) + diagnostic (3, 4) | 5 | 5 × 403 | **0** |
| 2 | Fausse alerte — le bac recyclé avait détruit `node_modules` : le script est mort au chargement (`MODULE_NOT_FOUND`), **aucun paquet réseau émis** | 0 | — | **0** |
| 3 | Recherche systématique des 17 clés restantes (2→18), une par une, date cible confirmée | 18 | **18 × 403** | **0** |

Un refus n'est pas une consommation : `ApiCallLog` porte `cost = 0` partout, et les compteurs de clés restent à `usedTotal = 0`. **Aucun crédit n'a été dépensé dans cette phase.**

**Diagnostic honnête** : 18 clés refusées avec un message *identique* désigne un problème de **compte** (solde épuisé, plafond journalier, compte inactif, ou blocage fournisseur), non 18 clés individuellement invalides. Le fournisseur ne tranche pas entre ces causes dans sa réponse ; il faut les vérifier côté tableau de bord.

**Ce qui a été fait malgré tout, en local** : la date cible a été choisie sur **preuve gratuite** (TheSportsDB, 0 crédit) — E0 joue le **samedi 10 octobre** (Arsenal – Leeds United), SP1 ouvre sa journée le vendredi 9 (Málaga – Espanyol) : `GET /matches?date=2026-10-10` est prêt, `LFA_LEAGUE_MAP` sera écrite automatiquement dès la première réponse utile, puis l'ingestion hors ligne s'enchaîne (identités, logos, prédictions).

**Décision attendue** (une seule) :
1. **vérifier le compte fournisseur** — solde de crédits, plafond journalier, état du compte — puis relancer : `bash scripts/ingest-recherche-cle.sh 2026-10-10` (l'outil teste les clés une par une, s'arrête au premier succès, puis enchaîne ingestion et vérifications) ;
2. ou fournir une **clé issue d'un autre compte valide** ;
3. ou **continuer sans ingestion** : tout le reste de la phase est livré et vérifié, l'alimentation se fera quand le compte sera rétabli.

## §35 A — Données

| Élément | État mesuré |
|---|---|
| Rencontres en base | **8 360** — toutes `FINISHED` (2015-08-08 → 2026-05-24) |
| Rencontres **à venir** | **0** *(conséquence directe du blocage fournisseur)* |
| Prédictions | 780 dont 776 réglées (réussite 47,6 %) |
| Compétitions | 2 : `code:E0` Premier League (England, GB), `code:SP1` La Liga (Spain, ES) |
| Équipes | 65 · **0 logo** · 0 pays renseigné |
| Logos en cache (`AssetCache`) | 0 |
| xG locaux (2024-2025) | 460 enregistrements, intacts |
| Cache fournisseur | 0 entrée *(table vidée par le recyclage du bac, jamais reconstruite — l'appel qui devait l'alimenter a été refusé)* |

**Rien n'a été inventé, rien n'a été dupliqué** : 0 affiche en double, 0 rencontre avec plusieurs prédictions actives.

## §35 B — Synchronisation

Le synchroniseur existant a été **inspecté puis réutilisé** (§4) ; rien n'a été recréé à côté.

- **Connecteur** — `liveFootballApi` était hors du registre multi-source : il y est désormais inscrit, sans qu'une ligne de son client, de son portefeuille de clés ou de sa normalisation ait été réécrite.
- **Pipeline** — `runUpcomingPipeline()` : journée(s) → appel ou cache → normalisation → **déduplication** → persistance → identités et logos → prédiction → journal.
- **Déduplication (§10)** — identifiant fournisseur prioritaire ; clé de secours `compétition|domicile|extérieur|jour` **bornée à ±1 jour**, utilisée seulement en son absence, et **signalée** comme approximative dans le rapport d'exécution.
- **Identité (§17)** — l'identifiant fournisseur est conservé dans une nouvelle colonne `providerRefs` (équipes et compétitions) ; le slug interne qui relie l'historique n'est pas remplacé. Une équipe du calendrier **rejoint l'équipe déjà connue** au lieu d'en créer une seconde sans historique — sans quoi aucune prédiction n'aurait été possible.
- **Idempotence (§11)** — vérifiée en conditions réelles : second passage hors ligne sur trois journées → comptes **strictement identiques** (8 360 / 65 / 780 / 0), **0 crédit**.
- **Journalisation (§26)** — `DataSource` + `DataSyncLog` par journée ; `ApiCallLog` pour chaque requête (endpoint, coût, HTTP, cache, solde), clé identifiée par son étiquette.
- **Robustesse (§25)** — délai d'attente 30 s, deux tentatives au maximum, cache à durée adaptée (journée passée 24 h, journée en cours 5 min, journée future 1 h), valeur périmée préférée à une absence en cas d'échec réseau.

## §35 C — Matchs futurs

- **Filtre strict** : une rencontre n'est affichable que si *statut `UPCOMING` **et** coup d'envoi strictement futur **et** prédiction publiée **et** versionnée **et** marchés complets **et** cohérence vérifiée*.
- **Filtre par journée (§18)** — la page « Matchs à venir » propose désormais **Aujourd'hui, Demain, 3 octobre, 4 octobre…** ; la sélection compare des **bornes horaires UTC**, jamais des chaînes de caractères (§8).
- **Date cible prête** : `2026-10-10`, choisie sur preuve gratuite (TheSportsDB) — jour confirmé de Premier League (Arsenal – Leeds United), la journée espagnole du week-end ouvrant le 9 octobre. La fenêtre internationale de début octobre (amicaux, Ligue des nations Concacaf — visible dans la sonde du 29/09) écartait bien le 3 octobre.
- **État affiché aujourd'hui** : 0 rencontre affichable — l'application le dit clairement au lieu de montrer un match sans prédiction.
- **Contrôle §29** exécuté sur le flux réel : *0 violation*. Il est aussi exécuté par la maintenance quotidienne.

## §35 D — Logos

- Les logos sont **repris de la source** quand elle en publie ; **aucune URL n'est construite** à partir d'un identifiant (vérifié par test).
- Conservation en `AssetCache` (`logoUrl`, `source`, `lastVerified`) + `Team.crest`, sans jamais écraser un logo connu par une absence.
- **Aucune requête externe à l'affichage** (§24) : la page lit la base, la route `/api/schedule` ne contacte personne.
- Repli **monogramme** en place, jamais d'image cassée : c'est l'état actuel des 65 équipes (0 logo disponible, faute d'appel abouti) et l'interface l'assume.

## §35 E — API : crédits et appels

| | |
|---|---|
| Appels émis | **23** (5 le 01/10 à 01:19–01:20 UTC + 18 le 01/10 à 05:56–05:57 UTC) |
| Réponses | **23 × HTTP 403**, aucune donnée reçue — même message pour les 18 clés |
| Crédits consommés | **0** (`cost = 0`, `usedToday = 0`, `usedTotal = 0`) |
| Endpoint visé | `GET /api/v1/matches?date=2026-10-03&lang=en` (clé 1 en query, conforme à la documentation) |
| Clés 2–18 | testées une par une **après autorisation expresse** de l'utilisateur (« utilise l'une des clés déjà transmises ») — les 18 refusées, les 18 **réactivées** (le 403 ambigu du fournisseur ne prouve pas une clé invalide) |
| Plafond des scripts | dur : `SOLEIL_API_DAILY_BUDGET` respecté, budget d'exécution fixé à 1 crédit |
| Réseau ordonnanceur | **fermé par défaut** (`SOLEIL_SCHEDULER_NETWORK≠on`) → toute exécution planifiée coûte 0 crédit |

## §35 F — Tests et vérifications

| Contrôle | Résultat |
|---|---|
| `npm test` | **218 / 218** (14 suites, dont 4 nouvelles) |
| `npx tsc --noEmit` | **0 erreur** |
| `npm run lint` | **0 erreur**, 19 avertissements (inchangé) |
| `scripts/verify-phase16.ts` | **8/8 conformes** (9/9 avec le contrôle d'idempotence) |
| Pages (`/`, `/matchs`, `/admin`, `/apprentissage`) | **HTTP 200** (79 381 o · 74 271 o · 72 751 o · 40 643 o) |
| `GET /api/schedule` | 200 — tâches, prochaine échéance, dernier résultat, dernier appel, fraîcheur |
| Build de production | **non concluant dans cet environnement** : interrompu après 25 min de saturation mémoire (1,9 Go de RAM, **sans swap**) — `tsc` et les pages valident le code, le build reste à refaire sur une machine dimensionnée |

Tests ajoutés (§28) — ils ont d'ailleurs trouvé **trois défauts réels**, corrigés depuis : une clé de secours acceptant une date illisible, un rapprochement d'équipe manqué sur les apostrophes (`Nott'm Forest`), et un comptage de déclenchements erroné d'une unité au voisinage de minuit.

## §35 G — Moteur

> **Moteur probabiliste modifié : NON.**
> **Poids xG (20 %) modifiés : NON.**
> **1X2 dérivé de la matrice modifié : NON.**
> **Backtest modifié : NON.**
> **Calibrations, Brier / Log Loss, modèles historiques, paramètres statistiques, prédictions historiques : NON modifiés.**

Les seules écritures de schéma concernent l'**identité des données** (`Team.providerRefs`, `League.providerRefs`) — aucune table du moteur, aucune constante statistique.

---

## Tâches planifiées (§27)

Aucune n'existait (aucun démon `cron` sur la machine : `crontab` absent). Trois tâches sont créées **et actives** ; elles s'exécutent via `scripts/scheduler.ts`. Les deux tâches payantes ne sortent sur le réseau que si l'opérateur l'ouvre explicitement — sans quoi elles lisent le cache, vérifient et journalisent, pour **0 crédit**.

| Tâche | Cadence (UTC) | Coût / exécution |
|---|---|---|
| `ingestion-calendrier` | chaque jour à 06:00 | 4 crédits (4 journées) |
| `rafraichissement-jour-j` | 00:00, 06:00, 12:00, 18:00 | 1 crédit |
| `maintenance-donnees` | chaque jour à 03:30 | **0 crédit** (invariants §29, cache, logos) |

Coût quotidien maximal si le réseau est ouvert : **8 crédits**. Actuellement : **0**.

## Limites, réserves et points non faits

- **Ingestion réelle non faite** — bloquée par le 403 sur les 18 clés ; `LFA_LEAGUE_MAP` (identifiants `E0`/`SP1` chez le fournisseur) reste **vide**, car ces identifiants ne s'inventent pas. Le déblocage tient en une commande (`bash scripts/ingest-recherche-cle.sh 2026-10-10`) dès qu'une clé sera acceptée.
- **Le bac sable a été recyclé une 4ᵉ fois** en cours de phase (node, `node_modules`, PostgreSQL détruits ; `data/` intact) : `bash scripts/restore.sh` a été rejoué avec succès (8 360 matchs · 780 prédictions · 776 réglées · 47,6 %). Une tentative de recherche de clé lancée sur l'environnement cassé est morte **avant tout appel réseau** (`MODULE_NOT_FOUND`) — elle n'a rien coûté, et l'outil de récupération refuse désormais de démarrer si l'environnement n'est pas restauré.
- **0 match affichable, 0 logo** : c'est l'état honnête, pas un défaut d'affichage.
- **Build de production non rejoué** après la dernière modification (mémoire insuffisante) — à refaire.
- Le rapprochement d'équipe restera **approximatif pour certains libellés** ; ces cas sont listés dans le rapport d'exécution au lieu d'être fusionnés en silence.
- Les identifiants de journée (« Aujourd'hui », « Demain ») sont calculés en **UTC** : un match de fin de soirée peut basculer d'un jour à l'autre selon le fuseau de l'utilisateur — choix assumé et documenté.

## Fichiers de référence

**Créés** : `src/server/data/providers/liveFootballApi.ts` (connecteur inscrit au registre) · `src/server/data/upcoming-pipeline.ts` · `src/server/data/identity.ts` · `src/server/schedule/{cron,jobs,window}.ts` · `src/app/api/schedule/route.ts` · `scripts/{scheduler,verify-phase16,ingest-upcoming}.ts` · `scripts/ingest-recherche-cle.sh` (outil de récupération : recherche de clé une par une, prêt pour le déblocage) · `prisma/migrations/20261001000000_phase16_provider_refs/` · tests `src/server/schedule/__tests__/{cron,jobs,window}.test.ts` et `src/server/data/__tests__/identity.test.ts`.

**Modifiés (hors moteur)** : `providers/apiFootballLive/client.ts` (message fournisseur conservé, cache) · `providers/apiFootballLive/adapter.ts` (durée de cache par journée) · `app/matchs/page.tsx` + `components/match/MatchFilters.tsx` (filtre par journée) · `prisma/schema.prisma` (identifiants fournisseur).

**Audit amont** : `reports/audit-16-alimentation-matchs-futurs.md` · **Rapport précédent** : `reports/rapport-15-apprentissage-1x2-upcoming.md`.

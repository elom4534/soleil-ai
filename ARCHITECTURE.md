# SOLEIL — Architecture & état du système

> Document de référence technique. Dernière vérification : après synchronisation
> complète et exécution des tests.

---

## 1. Vue d'ensemble

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          SOLEIL — APPLICATION                            │
└──────────────────────────────────────────────────────────────────────────┘

  INTERFACE (Next.js App Router, React 19, Tailwind 4)
  ┌────────────┬────────────┬────────────┬────────────┬────────────┐
  │  Accueil   │   Matchs   │ Top Picks  │  Soleil AI │ Performance│
  │  Analyses  │  Match Ctr │  Profil    │   Admin    │  API /ai   │
  └─────┬──────┴─────┬──────┴─────┬──────┴─────┬──────┴─────┬──────┘
        │            │            │            │            │
        └────────────┴────────────┴─────┬──────┴────────────┘
                                        │  (lecture seule, aucune donnée recalculée)
  ┌─────────────────────────────────────▼──────────────────────────────────┐
  │  COUCHE DE LECTURE      server/predictions/queries.ts + presenter.ts   │
  └─────────────────────────────────────┬──────────────────────────────────┘
                                        │
  ┌─────────────────────────────────────▼──────────────────────────────────┐
  │  PERSISTANCE            PostgreSQL via Prisma (client paresseux)        │
  │  League · Season · Team · Match · Prediction · ModelOutput · SyncLog    │
  └──────┬──────────────────────────────────────────────┬──────────────────┘
         │                                              │
         │ écriture                                     │ lecture
  ┌──────▼──────────────────────┐          ┌────────────▼──────────────────┐
  │  PIPELINE (server/jobs)     │          │  MOTEUR (server/engine)       │
  │  sync · backfill · settle   │◄─────────┤  code pur, sans I/O           │
  └──────┬──────────────────────┘   appel  └───────────────────────────────┘
         │
  ┌──────▼──────────────────────────────────────────────────────────────────┐
  │  DONNÉES (server/data)   providers · cache · teams · ingest             │
  └──────┬──────────────────────┬────────────────────────┬─────────────────┘
         │                      │                        │
  ┌──────▼───────┐   ┌──────────▼────────┐   ┌───────────▼───────────────┐
  │ football-    │   │   TheSportsDB     │   │  football-data.org        │
  │ data.co.uk   │   │   (calendrier)    │   │  (clé facultative)        │
  │  (primaire)  │   │                   │   │                           │
  └──────────────┘   └───────────────────┘   └───────────────────────────┘
```

**Principe directeur :** le moteur ne connaît ni la base de données ni le framework.
Il transforme un `MatchContext` en `PredictionResult` — deux structures pures. C'est ce qui
le rend testable sans base, remplaçable sans refonte et vérifiable par des tests unitaires.

---

## 2. Chaîne de traitement d'une prédiction

```
 Match à venir
      │
      ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ buildMatchContext(matchId, asOf)                            │
 │ · matchs antérieurs à `asOf` UNIQUEMENT  ← anti-fuite futur │
 │ · historique des 2 équipes (60 matchs max)                  │
 │ · confrontations directes (12 max)                          │
 │ · moyenne de compétition + repli saison précédente          │
 └──────────────────────────┬──────────────────────────────────┘
                            ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ computeTeamRatings()                                        │
 │ · attaque/défense domicile & extérieur en multiple de 1,00   │
 │ · repli bayésien (shrink k=6) sur petit échantillon          │
 │ · forme pondérée par récence · régularité · taux dérivés      │
 └──────────────────────────┬──────────────────────────────────┘
                            ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ CINQ MODÈLES → chacun produit le contrat ModelPrediction     │
 │  poisson · statistique · xg · home_away · form · (+ ml=exclu)│
 └──────────────────────────┬──────────────────────────────────┘
                            ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ runEnsemble()                                               │
 │ poids = base × confiance intrinsèque × convergence          │
 │ plafond : aucun modèle > 45 % du poids total                │
 │ accord = 1 − 4 × divergence JS moyenne                      │
 └──────────────────────────┬──────────────────────────────────┘
                            ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Matrice conjointe de scores (11 × 11)                       │
 │ Poisson bivarié + correction Dixon–Coles (ρ ajusté)         │
 │            ↓  source unique de tous les marchés             │
 │ 1X2 · O/U 0.5-4.5 · buts/équipe · mi-temps · BTTS · exact   │
 └──────────────────────────┬──────────────────────────────────┘
                            ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ assessDataQuality() → detectAnomalies() → computeConfidence()│
 │ confiance < 45  →  PRÉDICTION NON PUBLIÉE                    │
 └──────────────────────────┬──────────────────────────────────┘
                            ▼
              persistPrediction()  (transaction unique)
              · colonnes relationnelles indexables
              · vue complète sérialisée dans `factors.view`
                            ▼
         settlePredictions() après le match → Brier · Log Loss
```

---

## 3. Décisions techniques et leurs justifications

| Décision | Raison |
|----------|--------|
| **Moteur pur, sans I/O** | Testable sans base ; 15 tests couvrent la cohérence interne des marchés sans aucun mock |
| **Matrice de scores unique** | Garantit que Over/Under, BTTS, score exact et buts par équipe ne se contredisent jamais |
| **Méthode des ratios + shrinkage** | Interprétable et robuste sur petit échantillon, contrairement à un MLE lourd ; chaque valeur est explicable à l'utilisateur |
| **ρ Dixon–Coles ajusté** | La dépendance des scores serrés est un fait empirique documenté, pas un réglage arbitraire |
| **Plafond de 45 % par modèle** | Empêche un indicateur unique de dominer l'ensemble |
| **Vue sérialisée au moment de la génération** | L'interface n'approxime jamais : elle affiche exactement ce qui a été publié |
| **Filtre `utcDate < asOf` systématique** | Sans cela, un backtest serait faux : c'est la condition d'une évaluation honnête |
| **Client Prisma paresseux** | Permet d'importer le moteur, les fournisseurs ou le présentateur sans exiger une base active |
| **Cache persistant + single-flight** | Deux requêtes simultanées sur la même clé ne déclenchent qu'un appel réseau |
| **Rapprochement d'équipes prudent** | En cas de doute, on crée une nouvelle équipe plutôt que de risquer une fusion erronée |
| **Agent IA déterministe** | Chaque phrase est traçable jusqu'à un champ de la base ; aucun risque d'hallucination |

---

## 4. Mesures réelles obtenues

> **Note de traçabilité (29/09/2026).** Les mesures ci-dessous proviennent du premier
> backtest (556 prédictions). Les phases 11 et 12 ont depuis mesuré le moteur sur
> **2 280 rencontres** avec validation temporelle et tests automatisés d'étanchéité. Elles
> ne remplacent pas ce tableau — qui reste la trace de l'état antérieur — mais elles le
> complètent et **précisent son diagnostic de sous-confiance** : la température ajustée
> vaut 0,66 (le moteur aplatit bien ses probabilités) et le coefficient du nul vaut 1,28.
> Voir `reports/rapport-11-backtest-xg.md`, `reports/rapport-12-architecture-hybride.md`
> et la spécification `docs/architecture-probabiliste-v2.md`.

Sur **556 prédictions réglées**, générées sans aucune fuite d'information future :

| Métrique | SOLEIL | Référence aléatoire |
|----------|--------|--------------------|
| Exactitude 1X2 | **49,3 %** | 33,3 % |
| Brier Score | **0,6083** | 0,6667 |
| Log Loss | **1,0169** | 1,0986 |
| Over/Under 2.5 | **55,2 %** | 50 % |
| Les deux équipes marquent | **51,4 %** | 50 % |

**Calibration** (probabilité annoncée → fréquence observée) :

| Intervalle | Annoncé | Observé | n |
|-----------|---------|---------|---|
| 30-40 % | 38,0 % | 36,7 % | 139 |
| 40-50 % | 44,5 % | 45,5 % | 246 |
| 50-60 % | 54,0 % | 59,5 % | 131 |
| 60-70 % | 64,2 % | 81,3 % | 32 |
| 70-80 % | 74,1 % | 87,5 % | 8 |

Les intervalles principaux sont bien calibrés. Les intervalles hauts sont **sous-confiants**
(le modèle annonce moins qu'il n'obtient) — un biais mesuré, visible dans l'application, et
traitable par la recalibration prévue en feuille de route. C'est précisément le genre
d'observation que SOLEIL doit rendre visible plutôt que masquer.

**Performance par modèle, sur un échantillon strictement identique :**

| Modèle | n | Exactitude | Brier |
|--------|---|-----------|-------|
| Domicile / Extérieur | 493 | 48,9 % | 0,6063 |
| Poisson (Dixon–Coles) | 556 | 49,1 % | 0,6077 |
| **Consensus SOLEIL** | 556 | **49,3 %** | **0,6083** |
| Statistique | 530 | 47,5 % | 0,6152 |
| Forme récente | 556 | 42,4 % | 0,6511 |
| Expected Goals | 0 | — | — *(données xG absentes à cette date ; 460 rencontres enrichies depuis, voir la spécification v2)* |
| Machine Learning | 0 | — | — *(non entraîné)* |

Le consensus n'est jamais pire que la moyenne de ses composants — c'est sa fonction.

---

## 5. Couverture des données vérifiée

| Élément | Volume |
|---------|--------|
| Compétitions | 12 (Angleterre ×2, Espagne, Allemagne, Italie, France, Pays-Bas, Portugal, Belgique, Turquie, Grèce, Écosse) |
| Équipes | 252 |
| Rencontres | 4 676 (4 664 terminées, 12 à venir) |
| Prédictions générées | 667 |

Champs réellement disponibles depuis football-data.co.uk : score final, score à la mi-temps,
tirs, tirs cadrés, corners, cartons, arbitre.
Champs **absents et déclarés comme tels** : xG, possession.

---

## 6. Couverture de tests

```
src/server/engine/__tests__/math.test.ts     19 tests  ✔
src/server/engine/__tests__/engine.test.ts   15 tests  ✔
src/server/data/__tests__/teams.test.ts       9 tests  ✔
src/server/ai/__tests__/intent.test.ts       16 tests  ✔
                                             ─────────
                                             59 tests
```

Propriétés vérifiées, entre autres :

- Normalisation exacte des matrices de probabilité (somme = 1 à 10⁻⁹)
- Complémentarité Over/Under sur toutes les lignes
- Monotonie : Over 0,5 ≥ Over 1,5 ≥ … ≥ Over 4,5
- Cohérence mi-temps : buts attendus 1ʳᵉ + 2ᵉ = buts attendus du match
- Le score exact le plus probable **ne peut jamais dépasser 50 %**
- Aucun modèle ne dépasse 45 % du poids
- Une prédiction sur historique insuffisant n'est **pas** publiée, avec un motif explicite
- Le modèle xG est exclu et pèse 0 % quand les données manquent
- Le modèle ML est déclaré non entraîné, jamais simulé
- Aucune formulation interdite (« pari sûr », « 100 % », « garanti »…) dans les textes générés
- Déterminisme : deux appels identiques produisent le même résultat
- Un ajustement de ρ doit battre la valeur par défaut en vraisemblance

---

## 7. Ce qui reste à faire

> **Point de situation (29/09/2026).** Les points 1 et 3 ci-dessous ne sont plus des
> inconnues : ils ont été **mesurés** par les phases 11 et 12, sans dépense supplémentaire,
> et leur solution est spécifiée dans `docs/architecture-probabiliste-v2.md`. **Aucun de ces
> changements n'a été appliqué au moteur** — l'implémentation attend une décision explicite.
>
> | Point | État |
> | --- | --- |
> | Recalibration (temperature scaling) | **Mesurée** : T = 0,66 · c(nul) = 1,28, stables sur trois découpes. Gain hors échantillon : 1X2 0,6122 → 0,6098 avec l'architecture cohérente. |
> | Intégration d'un fournisseur xG | **Faite** : 460 rencontres enrichies (462 crédits). Le xG améliore les marchés de buts de façon établie ; il détériorait le 1X2 **brut**, ce que la calibration annule. |
> | Architecture des marchés | **Mesurée** : le 1X2 dérivé de la distribution des scores est meilleur que le 1X2 moyenné à tous les poids testés, et rend la cohérence mathématique gratuite. |

**Court terme**
1. ~~Recalibration (temperature scaling)~~ → **spécifiée**, non implémentée (voir
   `docs/architecture-probabiliste-v2.md` §3.2 et §5).
2. Authentification complète + protection des routes `/admin` par contrôle de rôle.
3. ~~Intégration d'un fournisseur xG~~ → **fait**, modèle xG désormais applicable là où le
   xG existe (460 rencontres, deux championnats, une saison). Couverture à étendre pour que
   le modèle cesse d'être inapplicable sur le reste.
4. **Nouveau — 1X2 dérivé de la distribution des scores**, avec les 9 tests de cohérence
   portés sur le moteur lui-même. C'est le repli sûr de la spécification v2 : gain mesuré à
   tous les poids, cohérence totale par construction, aucun paramètre ajusté, aucune donnée
   payante nouvelle.

**Moyen terme**
4. Entraînement d'un modèle ML et branchement dans l'ensemble avec poids appris — **et non plus un modèle ML simulé** : le moteur déclare aujourd'hui `ml` avec un poids nul et l'annonce comme non entraîné.
5. Synchronisation planifiée (cron ou tâche planifiée) plutôt que déclenchée manuellement.
6. Notifications et alertes sur les Top Picks.

**Long terme**
7. Marchés étendus : corners, cartons, handicaps, tirs.
8. Prédictions live.
9. API publique et abonnement premium.

---

## 8. Comment lancer le projet

```bash
# 1. Base de données
npm run db:up          # démarre PostgreSQL localement et met à jour .env
npm run db:migrate     # applique le schéma

# 2. Données réelles (aucune clé API requise pour cette étape)
npm run sync                                  # ~5 min pour 12 compétitions
npm run sync:backfill                         # historique évaluable

# 3. Application
npm run dev            # http://localhost:3000

# 4. Vérifications
npm run test           # 137 tests (dont 10 d'étanchéité temporelle et 9 de cohérence des marchés)
npm run typecheck      # 0 erreur
npx eslint src         # 0 problème
```

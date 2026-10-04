# ☀️ SOLEIL — L'intelligence qui lit le football

**Analysez. Comprenez. Anticipez.**

SOLEIL est une plateforme d'analyse footballistique fondée sur les données. Elle collecte
automatiquement les rencontres de plusieurs sources, construit des ratings d'équipes, exécute
cinq modèles complémentaires, en tire un consensus pondéré et publie des **probabilités
calibrées** — jamais des certitudes.

> **SOLEIL ne promet pas de connaître le futur.**
> **SOLEIL calcule les probabilités du futur à partir des données.**

---

## État d'avancement

| Phase | Contenu | Statut |
|-------|---------|--------|
| 1 | Architecture, base de données, authentification, interface | ✅ |
| 2 | Sources de données, normalisation, cache | ✅ |
| 3 | Moteur statistique (ratings d'équipes) | ✅ |
| 4 | Over/Under, résultat, buts par équipe | ✅ |
| 5 | Mi-temps, BTTS, score exact | ✅ |
| 6 | Score de confiance, moteur de consensus | ✅ |
| 7 | Soleil AI (agent d'explication) | ✅ |
| 8 | Historique, évaluation réelle (Brier, Log Loss, calibration) | ✅ |
| 9 | Optimisation UX / mobile / performance | ✅ |
| 10 | Tests et validation | 🟡 59 tests unitaires en place, couverture à étendre |

---

## Démarrage rapide

### 1. Prérequis

- **Node.js ≥ 22** (certaines dépendances utilisent `node:sqlite`)
- PostgreSQL 14+ — ou la base locale fournie par Prisma en développement

### 2. Installation

```bash
npm install
cp .env.example .env      # puis renseignez DATABASE_URL
```

### 3. Base de données

En développement, si aucun PostgreSQL n'est disponible localement :

```bash
npm run db:up             # démarre une instance locale et met à jour .env
```

Puis appliquez le schéma :

```bash
npm run db:migrate        # prisma migrate dev
npm run db:generate       # génère le client typé
```

### 4. Collecte des données

```bash
npm run sync                            # toutes compétitions, saison en cours + précédente
npm run sync -- --competitions E0,SP1   # Premier League + Liga uniquement
npm run sync:backfill                   # reconstruit un historique évaluable
```

### 5. Application

```bash
npm run dev       # http://localhost:3000
```

### 6. Tests et vérifications

```bash
npm run test       # tests unitaires du moteur, des parseurs et de l'agent
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```

---

## Architecture

```
src/
├── app/                          # Routes Next.js (App Router)
│   ├── page.tsx                  # Accueil — hero, matchs, top picks, méthode
│   ├── matchs/                   # Liste filtrable (§19)
│   │   └── [id]/page.tsx         # Match Center (§17)
│   ├── top-picks/                # Sélection à critères objectifs (§20)
│   ├── analyses/                 # Vue comparative par compétition
│   ├── ai/                       # Interface de l'agent (§16)
│   ├── performance/              # Evaluation réelle des prédictions (§22, §24)
│   ├── profil/  admin/           # Préférences, dashboard (§28)
│   └── api/ai/chat/              # Endpoint de l'agent (validé + rate limité)
│
├── components/
│   ├── ui/                       # Design system (Card, Badge, Logo, ThemeToggle…)
│   ├── layout/AppShell.tsx       # Sidebar desktop + navigation basse mobile (§27)
│   ├── match/                    # MatchCard, ConfidenceRing, filtres
│   └── charts/                   # Distribution, calibration (SVG/CSS, sans canvas)
│
├── lib/
│   ├── prisma.ts                 # Client singleton paresseux
│   ├── constants.ts              # Version du moteur, seuils, formulations interdites
│   ├── rate-limit.ts             # Limitation de débit (§30)
│   └── utils.ts                  # Formatage, probabilités, tons sémantiques
│
└── server/
    ├── engine/                   # ☀️ SOLEIL PREDICTION ENGINE (pur, sans I/O)
    │   ├── types.ts              # Contrats du domaine
    │   ├── math.ts               # Poisson, Dixon–Coles, bivarié, matrice de scores
    │   ├── ratings.ts            # Forces offensives/défensives, moyenne de compétition
    │   ├── models.ts             # Les cinq modèles complémentaires
    │   ├── ensemble.ts           # Consensus pondéré avec plafonnement
    │   ├── quality.ts            # Qualité des données, anomalies, confiance
    │   └── index.ts              # Orchestrateur + évaluation (Brier, Log Loss)
    │
    ├── data/                     # Couche multi-source (§4, §29)
    │   ├── providers/            # football-data.co.uk, TheSportsDB, football-data.org
    │   ├── cache.ts              # Cache persistant + single-flight
    │   ├── teams.ts              # Normalisation et rapprochement des noms
    │   └── ingest.ts             # Déduplication, validation, persistance
    │
    ├── predictions/
    │   ├── context.ts            # Construction du contexte **sans fuite futur**
    │   ├── service.ts            # Génération, règlement, performance
    │   ├── presenter.ts          # Modèle d'affichage
    │   └── queries.ts            # Requêtes de lecture paginées
    │
    ├── ai/engine.ts              # SOLEIL AI — agent d'explication ancré sur les données
    └── jobs/sync.ts              # Pipeline quotidien en 12 étapes (§25)
```

### Séparation stricte des responsabilités

- **Le moteur ne connaît ni Prisma ni Next.js.** Il consomme des structures pures et produit
  des structures pures. Il est donc testable sans base de données et remplaçable sans
  toucher à l'application.
- **Les fournisseurs de données ne connaissent pas le métier.** Ils normalisent vers un
  contrat unique ; l'ingestion décide de ce qui est conservé.
- **L'interface ne calcule rien.** Elle affiche ce que le moteur a publié, via une vue
  persistée au moment de la génération.

---

## Le moteur de prédiction

### 1. Forces d'équipe

Pour chaque équipe, les attaques et défenses sont exprimées **en multiple de la moyenne de
la compétition** (1,00 = moyenne) :

```
λ_domicile = Attaque_dom(A) × Défense_ext(B) × moyenne_buts_domicile
λ_extérieur = Attaque_ext(B) × Défense_dom(A) × moyenne_buts_extérieur
```

Un **repli bayésien** (`shrink`) ramène toute estimation vers la moyenne lorsque
l'échantillon est faible : une équipe ayant joué deux matchs ne peut pas produire une force
aberrante.

### 2. Les cinq modèles

| Modèle | Principe | Poids de base |
|--------|----------|---------------|
| **Poisson (Dixon–Coles)** | Intensités issues des ratios attaque/défense, correction de dépendance sur les scores serrés (0-0, 1-0, 0-1, 1-1) | 28 % |
| **Statistique** | Distribution empirique des buts, capture la sur-dispersion | 22 % |
| **Expected Goals** | Poisson sur intensités xG — **exclu si les xG ne sont pas fournis** | 20 % |
| **Domicile / Extérieur** | Isole l'avantage du terrain | 18 % |
| **Forme récente** | Points pondérés par récence (décroissance exponentielle) | 12 % |
| **Machine Learning** | **Non entraîné dans cette version** — déclaré non applicable, poids nul | 0 % |

### 3. Consensus

Chaque modèle reçoit un poids = `poids de base × confiance intrinsèque × facteur de
convergence`, où le facteur de convergence pénalise les modèles qui s'écartent de la
distribution médiane (divergence de Jensen–Shannon).

**Aucun modèle ne peut dépasser 45 % du poids total.** Cela empêche un indicateur unique de
dominer artificiellement la prédiction.

### 4. Marchés calculés

Tout dérive d'une **matrice conjointe de scores** (11×11), ce qui garantit la cohérence
interne des marchés entre eux :

- **1X2** — victoire domicile / nul / victoire extérieur
- **Over/Under** — lignes 0.5 à 4.5, avec probabilité, confiance et explication textuelle
- **Buts par équipe** — distribution 0/1/2/3/4+ et lignes 0.5 à 2.5
- **Mi-temps** — intensités dérivées de la part de buts réellement observée en 1ʳᵉ période
- **BTTS** — oui/non avec indice de confiance
- **Score exact** — Top 10, accompagné d'un avertissement explicite sur son incertitude
- **Distribution des buts** — 0 à 5+

### 5. Score de confiance

```
confiance = 0,35 × qualité des données
          + 0,15 × volume de données
          + 0,25 × accord entre modèles
          + 0,12 × stabilité des statistiques
          + 0,13 × cohérence des indicateurs
          − pénalités d'anomalies (plafonnées à 45 points)
```

Sous **45/100**, la prédiction n'est pas publiée : l'interface affiche
« Prédiction non publiée — données insuffisantes ».

### 6. Détection d'anomalies

Historique insuffisant, données périmées, absence de xG, déséquilibre d'échantillon,
désaccord entre modèles, variance extrême, distribution inhabituelle, absence de
confrontations directes. Chaque anomalie porte une sévérité, un message lisible et une
pénalité chiffrée.

---

## Sources de données

| Fournisseur | Apport | Clé requise | Capacités |
|-------------|--------|-------------|-----------|
| **football-data.co.uk** | Résultats, scores mi-temps, tirs, corners, cartons | Non | ✔ résultats · ✔ stats · ✔ mi-temps · ✘ xG · ✘ calendrier |
| **TheSportsDB** | Calendrier des rencontres à venir | Non (clé publique) | ✔ calendrier · ✔ résultats · ✘ stats |
| **football-data.org** | Calendrier officiel, logos | Oui (`FOOTBALL_DATA_API_KEY`) | ✔ calendrier · ✔ résultats · ✔ mi-temps |

Un fournisseur absent n'est jamais interrogé ; un fournisseur en échec n'interrompt pas la
synchronisation — le suivant prend le relais.

**Déduplication** : une rencontre est identifiée par (compétition, date ±1 jour, paire
d'équipes résolue). Les champs manquants sont complétés par les autres sources ; une valeur
existante n'est jamais écrasée par une supposition.

**Cache** : persistant en base, horodaté, avec mécanisme *single-flight* (deux appels
simultanés sur la même clé ne déclenchent qu'une seule requête réseau). En cas d'échec
réseau, une valeur périmée est réutilisée et signalée comme telle plutôt que de priver
l'utilisateur de toute donnée.

---

## Règle fondamentale

> **Ne jamais fabriquer de données.**

- Une statistique absente reste `null` et s'affiche **« Donnée indisponible »**.
- Un modèle sans données est **exclu** de l'ensemble avec un poids nul — jamais simulé.
- Une prédiction sur données insuffisantes n'est **pas publiée**.
- Le modèle de Machine Learning **n'est pas entraîné** : il apparaît explicitement comme
  non applicable plutôt que de produire une sortie factice.
- Les formulations « pari sûr », « 100 % », « garanti », « certain » sont **interdites** et
  vérifiées par test automatisé.
- Le sous-titre d'aucune page ne laisse croire à une performance non mesurée.

---

## Mesurer la performance honnêtement

SOLEIL reconstruit son historique en générant chaque prédiction **avec les seules données
antérieures à la rencontre** (`buildMatchContext(matchId, asOf)`). Aucune information future
n'est utilisée : il n'y a pas de fuite temporelle, donc l'évaluation mesure une performance
réelle.

Les prédictions sont ensuite réglées contre le résultat effectif, et les métriques suivantes
sont calculées :

- **Taux de réussite** 1X2
- **Brier Score** multiclasse (référence aléatoire : 0,6667)
- **Log Loss** (référence aléatoire : 1,0986)
- **Calibration** par intervalle de probabilité
- Performance **par marché**, **par compétition** et **par bande de confiance**
- **Classement des modèles** sur un échantillon strictement identique

Les prédictions publiées ne sont jamais modifiées rétroactivement : seul le verdict et le
Brier Score sont ajoutés après la rencontre.

---

## Sécurité

- Les clés d'API sont lues **exclusivement côté serveur** via des variables d'environnement.
- L'endpoint de l'agent valide ses entrées avec Zod (longueur, format d'identifiant).
- Limitation de débit en mémoire, remplaçable par Redis via `REDIS_URL` sans changer les appels.
- Les routes d'administration sont destinées à être protégées par le contrôle de rôle
  (`ADMIN` / `SUPER_ADMIN`) — le schéma et le modèle de session sont en place.

---

## Limites déclarées

SOLEIL préfère annoncer ses limites plutôt que de les masquer :

- **Pas de modèle de machine learning entraîné.** Le point d'extension existe, il est déclaré
  inactif. Aucune métrique ne lui est attribuée.
- **Pas d'auto-apprentissage automatique.** La recalibration des probabilités à partir de
  l'historique n'est pas encore implémentée. Le scoring de confiance est déjà réglable par
  configuration, mais aucun ajustement automatique des poids n'a lieu.
- **Pas de prédictions live.** Les marchés live (corners, cartons, tirs) sont préparés dans
  le schéma mais non exploités.
- **Couverture des xG limitée.** Les sources sans clé utilisées ne publient pas de xG : le
  modèle correspondant est donc fréquemment exclu, ce que l'interface indique explicitement.
- **SOLEIL AI n'utilise pas de modèle de langage.** L'agent est déterministe et ancré sur la
  base : chaque phrase est traçable jusqu'à un champ. Un fournisseur de LLM peut être branché
  sur les mêmes fonctions d'accès aux données via la couche `server/ai/`.

---

## Feuille de route

1. Entraînement d'un modèle ML (gradient boosting sur les ratings dérivés) et branchement
   dans l'ensemble avec poids appris.
2. Recalibration automatique (temperature scaling / isotonique) sur les prédictions réglées.
3. Intégration d'un fournisseur xG (Understat, Opta) pour activer le modèle Expected Goals.
4. Marchés étendus : corners, cartons, handicaps, tirs.
5. Authentification complète et espace utilisateur (historique personnel, favoris, alertes).
6. API publique et abonnement premium.

---

## Licence et usage

Le contenu produit par SOLEIL est fourni **à titre informatif et analytique**. Il ne
constitue ni un conseil en investissement, ni une incitation à parier. Une probabilité de
70 % signifie 70 %, jamais 100 %.

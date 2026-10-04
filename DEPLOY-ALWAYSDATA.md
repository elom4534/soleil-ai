# SOLEIL — Déploiement sur Alwaysdata

Ce document accompagne l'archive `SOLEIL-2026-10-01.zip`. Il décrit comment mettre
l'application en ligne sur Alwaysdata. Aucune donnée n'est inventée par le logiciel :
au démarrage, l'application importe les **données locales réelles** fournies dans
`data/` (football-data.co.uk + TheSportsDB + historique d'appels API), puis génère
les prédictions avec le moteur calibré. **Aucun appel payant n'est nécessaire.**

---

## 1. Contenu de l'archive

| Dossier / fichier | Rôle |
|---|---|
| `src/` | Application Next.js (moteur, interface, API) |
| `prisma/` | Schéma + migrations (5 migrations) |
| `data/normalized/fdcouk/` | Saisons réelles E0 + SP1 (source de vérité) |
| `data/raw/`, `data/features/`, `data/learning/`, `data/ui-baseline/` | Données brutes, features, apprentissages, empreinte UI |
| `data/backtests/` | Preuves de backtest (17 dossiers) — **facultatif en production** |
| `scripts/` | Amorçage, vérifications, planificateur |
| `reports/` | Rapports de phases (preuves et audits) |
| `.env` | Vos clés et configuration — **à adapter (voir §4)** |
| `package.json` / `package-lock.json` | Dépendances (Prisma 7.10, Next.js, Tailwind) |

## 2. Prérequis sur Alwaysdata

- Une offre avec **Node.js** (idéalement Node 22) et **PostgreSQL**.
- SSH activé (pour les commandes d'installation).

## 3. Base de données

1. Espace client → **Bases de données** → créer une base **PostgreSQL**.
2. Noter : hôte, port, nom de base, utilisateur, mot de passe.

## 4. Variables d'environnement

Modifier `.env` (ou les variables du site dans le panneau) :

```
DATABASE_URL="postgresql://UTILISATEUR:MOT_DE_PASSE@HOTE:PORT/NOM_BASE"
NODE_ENV="production"
```

`API_FOOTBALL_LIVE_KEYS`, `THESPORTSDB_KEY`, `SOLEIL_API_DAILY_BUDGET` sont déjà dans
`.env`. ⚠️ **Ce fichier contient vos clés : ne le publiez jamais.**

## 5. Installation (SSH) — chemin réel : `/home/soleil-ai/soleil-app/`

```bash
cd /home/soleil-ai/soleil-app
npm ci                     # installe les dépendances
npx prisma generate        # génère le client de base
npx prisma migrate deploy  # crée les tables
./node_modules/.bin/next build --webpack   # compilation de production
rm -rf .next/cache
```

La commande de démarrage AlwaysData reste (ne pas la modifier) :

```bash
npm start -- -H :: -p $PORT
```

## 6. Import des données locales (≈ 20 min, 0 crédit, 0 appel API)

```bash
node_modules/.bin/tsx scripts/bootstrap-local.ts          # 8 360 matchs réels
node_modules/.bin/tsx scripts/bootstrap-predictions.ts --limit 780   # 780 prédictions publiées
node_modules/.bin/tsx scripts/ingest-upcoming-tsdb.ts     # matchs à venir (source gratuite, 0 crédit)
node_modules/.bin/tsx scripts/verify-phase16.ts --skip-idempotence   # vérifications
```

### 6bis. Matchs à venir — source gratuite (0 crédit)

`scripts/ingest-upcoming-tsdb.ts` alimente les matchs **à venir** (E0 + SP1) depuis
**TheSportsDB** (gratuit) : identifiants, équipes, logos officiels publiés par la
source, coup d'envoi, puis prédictions obligatoires (§19). À relancer
périodiquement (ex. 1 fois par jour) pour rafraîchir le calendrier.

⚠️ Les clés LiveFootballApi sont actuellement **refusées par le fournisseur
(HTTP 403 — compte bloqué : solde, plafond journalier ou compte inactif)** ;
quand le compte sera rétabli, `bash scripts/ingest-recherche-cle.sh AAAA-MM-JJ`
reprend la source payante (calendrier complet), et `ingest-upcoming-tsdb.ts`
reste disponible sans dépendre d'elle.

## 7. Démarrage

Commande AlwaysData à laisser **telle quelle** (ne pas modifier) :

```bash
npm start -- -H :: -p $PORT
```

(`$PORT` = 8100 fourni par AlwaysData ; l'application écoute en IPv6 sur `::`
comme l'exige la plateforme. `npm start` exécute `next start`.)

## 8. Tâches planifiées (Phase 16)

Quatre tâches existent dans l'application (`/api/schedule`) mais **ne s'exécutent pas
automatiquement** sur un hébergement mutualisé. Deux options :

- **Tâche planifiée Alwaysdata** (Espace client → Tâches planifiées), une par jour :

```bash
# LA PLUS IMPORTANTE — matchs à venir, source gratuite, 0 crédit (à programmer en priorité)
node_modules/.bin/tsx scripts/scheduler.ts --run alimentation-matchs-a-venir

# Les autres (utiles quand les clés payantes seront rétablies)
node_modules/.bin/tsx scripts/scheduler.ts --run ingestion-calendrier
node_modules/.bin/tsx scripts/scheduler.ts --run rafraichissement-jour-j
node_modules/.bin/tsx scripts/scheduler.ts --run maintenance-donnees
```

- **Ou** un processus permanent : `node_modules/.bin/tsx scripts/scheduler.ts --daemon`

⚠️ Laisser `SOLEIL_SCHEDULER_NETWORK=off` (valeur par défaut) : les 18 clés
LiveFootballApi sont actuellement **refusées par le fournisseur (HTTP 403, compte
bloqué, 0 crédit consommé)**. Les tâches locales fonctionnent sans réseau ;
l'ouverture automatique (`on`) n'a de sens qu'après déblocage du compte.

## 9. Économie d'espace (facultatif)

`data/backtests/` pèse 81 Mo : ce sont les preuves des backtests (Phase 11 à 15),
inutiles au fonctionnement. Elles restent dans l'archive de référence. Sur le
serveur, elles peuvent être supprimées.

## 10. Ce que fait l'application une fois en ligne

- `/` accueil · `/matchs` prédictions (filtre Aujourd'hui/Demain/date) · `/top-picks`
  · `/performance` (Brier/LogLoss/calibration) · `/apprentissage` · `/ai` (IA qui
  répond uniquement à partir des données disponibles).
- Moteur : 1X2 dérivé de la distribution de Poisson bivariée (`1.0.0-matrix-xg0.2`),
  xG sur marchés validés uniquement (poids 20 %), confiance 0–100 non arbitraire,
  grade de qualité des données, jamais de prédiction forcée.

## 11. Dépannage

| Symptôme | Cause / solution |
|---|---|
| « Can't reach database » | `DATABASE_URL` incorrecte ou base non créée (§3–4) |
| Pages vides de matchs | Import local non fait (§6) |
| `Prisma client out of date` | relancer `npx prisma generate` puis `npx next build` |
| Erreur `PORT` | adapter `-p ${PORT:-3000}` au port indiqué par Alwaysdata |

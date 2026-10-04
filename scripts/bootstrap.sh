#!/usr/bin/env bash
# ============================================================================
# SOLEIL — Amorçage complet de l'environnement de développement
# ============================================================================
# Enchaîne : Node 22 si nécessaire → PostgreSQL local → migrations →
# synchronisation des données → vérifications.
#
# Usage : bash scripts/bootstrap.sh [--skip-sync]
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$1"; }

say "Vérification de Node.js"
# shellcheck source=./ensure-node.sh
source ./scripts/ensure-node.sh
echo "  Node $(node -v) prêt"

say "Dépendances"
if [ ! -d node_modules ]; then
  # `npm ci` respecte strictement package-lock.json : deux remontages donnent
  # exactement le même arbre de dépendances.
  npm ci --no-audit --no-fund
fi

say "Base de données PostgreSQL locale"
bash scripts/dev-db.sh

say "Migrations Prisma"
npx prisma migrate deploy

say "Client Prisma"
# Le client Prisma est généré dans node_modules : il disparaît avec lui, donc
# il doit être régénéré à chaque remontage (sinon tous les types deviennent
# « any » et le typage ne prouve plus rien).
npx prisma generate

if [ "${1:-}" != "--skip-sync" ]; then
  say "Synchronisation des données réelles (~5 min)"
  npx tsx scripts/sync.ts --log
fi

say "Vérifications"
npx tsc --noEmit && echo "  TypeScript ✔"
npx tsx --test src/server/engine/__tests__/math.test.ts \
              src/server/engine/__tests__/engine.test.ts \
              src/server/data/__tests__/teams.test.ts \
              src/server/ai/__tests__/intent.test.ts >/dev/null && echo "  Tests ✔"

say "Terminé"
echo "  Lancez l'application : npm run dev"

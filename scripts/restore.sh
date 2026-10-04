#!/usr/bin/env bash
# Reconstruction complète du poste de travail après recyclage du bac à sable.
set -x
cd /home/user/soleil
source scripts/ensure-node.sh
node -v
npm ci --no-audit --no-fund
bash scripts/dev-db.sh
npx prisma migrate deploy
npx prisma generate
npx tsx scripts/bootstrap-local.ts
npx tsx scripts/bootstrap-predictions.ts --limit 780
echo "=== RESTAURATION TERMINÉE ==="

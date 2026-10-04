#!/usr/bin/env bash
# ============================================================================
# SOLEIL — Démarrage complet de l'application
# ============================================================================
# Une seule commande pour remettre l'application en marche après un recyclage
# du bac à sable. Elle fait au minimum nécessaire :
#
#   1. Node 22 (réinstallé si le recyclage l'a effacé) ;
#   2. `npm ci` si node_modules manque ;
#   3. base PostgreSQL locale (état dans soleil/.data — survivant aux
#      redémarrages de serveur, mais pas aux recyclages complets du bac,
#      l'instantané étant plafonné à ~128 Mo) ;
#   4. migrations + client Prisma ;
#   5. si la base est vide (premier lancement) : réimport des 8 360 matchs et
#      des 780 prédictions — sinon cette étape est SAUTÉE ;
#   6. le serveur de l'application.
#
# Usage :  bash scripts/start-app.sh
# ============================================================================
set -euo pipefail
cd /home/user/soleil

echo "── Mémoire (swap) ─────────────────────────────────"
# Le bac ne fournit que ~2 Go de RAM sans swap : la compilation de Next.js
# s'effondre sans ce filet. Recréé à chaque démarrage (hors dépôt, donc perdu
# au recyclage — 3 secondes à refaire).
if [ "$(free -m | awk '/^Swap:/{print $2}')" = "0" ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n fallocate -l 2G /swapfile 2>/dev/null || true
  sudo -n chmod 600 /swapfile 2>/dev/null || true
  sudo -n mkswap /swapfile >/dev/null 2>&1 || true
  sudo -n swapon /swapfile 2>/dev/null || true
fi
free -m | head -3

echo "── Node.js ─────────────────────────────────────────"
source ./scripts/ensure-node.sh
node -v

echo "── Dépendances ─────────────────────────────────────"
if [ ! -x node_modules/.bin/tsx ]; then
  echo "node_modules absent → npm ci…"
  npm ci --no-audit --no-fund
else
  echo "node_modules présent."
fi

echo "── Base de données ─────────────────────────────────"
bash scripts/dev-db.sh | tail -1
npx prisma migrate deploy | tail -2
npx prisma generate | tail -1

echo "── État de la base ─────────────────────────────────"
COUNTS=$(node_modules/.bin/tsx scripts/db-count.ts)
MATCHES=$(echo "$COUNTS" | grep -oE "\"m\":[0-9]+" | grep -oE "[0-9]+")
echo "matchs en base : ${MATCHES}"

if [ "${MATCHES:-0}" -lt 8000 ]; then
  echo "Base incomplète → réimport des données locales (≈ 20 min, 0 crédit)…"
  node_modules/.bin/tsx scripts/bootstrap-local.ts
  node_modules/.bin/tsx scripts/bootstrap-predictions.ts --limit 780
else
  echo "Base complète — réimport sauté."
fi

echo ""
echo "════════════════════════════════════════════════════"
echo "  SOLEIL démarre sur http://0.0.0.0:3000"
echo "  (ouvrir via l'aperçu en direct de l'interface)"
echo "════════════════════════════════════════════════════"
exec node_modules/.bin/next dev -H 0.0.0.0 -p 3000

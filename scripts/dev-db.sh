#!/usr/bin/env bash
# ============================================================================
# SOLEIL — Démarre la base PostgreSQL locale (prisma dev) et met à jour .env
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=./ensure-node.sh
source ./scripts/ensure-node.sh

if ! node -v | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  echo "❌ Node 22+ requis pour la base locale Prisma. Version actuelle : $(node -v)"
  exit 1
fi

# ---------------------------------------------------------------------------
# Persistance de la base : l'état de `prisma dev` vit dans ~/.local/share, qui
# est effacé à chaque recyclage. En le redirigeant vers le dépôt du projet, la
# base survit aux REDÉMARRAGES de serveur au sein d'une même session.
# Limite connue : un recyclage complet du bac restaure l'espace de travail via
# un instantané plafonné (~128 Mo) — la base (200 Mo et plus) n'y survit pas,
# et `start-app.sh` rejoue alors le réimport automatiquement.
# ---------------------------------------------------------------------------
mkdir -p /home/user/soleil/.data/prisma-dev-nodejs
mkdir -p "${HOME}/.local/share"
ln -sfn /home/user/soleil/.data/prisma-dev-nodejs "${HOME}/.local/share/prisma-dev-nodejs"

# Démarrer le serveur si nécessaire
# `prisma dev ls` affiche « not_running » : un `grep running` simple produit
# un faux positif et laisse la base éteinte. On exige le statut exact.
if ! npx prisma dev ls 2>/dev/null | grep -qE "^[[:space:]]*soleil[[:space:]]+running([[:space:]]|$)"; then
  echo "▶️  Démarrage de PostgreSQL local..."
  npx prisma dev -d --name soleil --db-port 5433 -p 5555 2>&1 | tail -3
  sleep 2
fi

# Récupérer l'URL TCP et l'écrire dans .env
URL=$(npx prisma dev ls 2>/dev/null \
  | grep -o 'postgres://postgres:postgres@localhost:[0-9]*/template1[^ ]*' \
  | head -1 | sed 's/&.*//')

if [ -z "$URL" ]; then echo "❌ Impossible de récupérer l'URL de la base"; exit 1; fi
echo "$URL"

python3 - "$URL" <<'PY'
import sys, re, pathlib
url = sys.argv[1]
p = pathlib.Path('.env')
s = p.read_text() if p.exists() else ''
line = f'DATABASE_URL="{url}"'
if 'DATABASE_URL=' in s:
    s = re.sub(r'^DATABASE_URL=.*$', line, s, flags=re.M)
else:
    s = line + '\n' + s
p.write_text(s)
print('✅ .env mis à jour')
PY

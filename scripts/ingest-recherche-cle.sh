#!/usr/bin/env bash
# ============================================================================
# SOLEIL — Phase 16 · Recherche de la clé LiveFootballApi opérationnelle
# ============================================================================
# Utilitaire de RÉCUPÉRATION : une seule clé par tentative, arrêt au premier
# succès, jamais deux appels en parallèle. Chaque refus (403) coûte 0 crédit ;
# le succès coûte 1 crédit. Les valeurs de clés ne sont JAMAIS affichées : seul
# l'index de la clé l'est.
#
# Garde-fous :
#   · environnement non restauré (node_modules absent) → STOP avant tout appel ;
#   · panne de module détectée dans la trace → STOP (ne jamais la confondre
#     avec un refus du fournisseur) ;
#   · plafond dur côté script : 1 crédit par exécution (ingest-upcoming.ts).
#
# Usage :  bash scripts/ingest-recherche-cle.sh [AAAA-MM-JJ]
# Sorties : CLE_OK=<n> · CLE_OK_SANS_COMPETITION=<n> · AUCUNE_CLE_VALIDE · exit 2
# ============================================================================
set -u
cd /home/user/soleil
export PATH=/home/user/.local/node22/bin:$PATH
DATE="${1:-2026-10-10}"

# Lecture des clés depuis .env sans jamais les imprimer.
mapfile -t KEYS < <(python3 - <<'PY'
import re
c = open('.env').read()
m = re.search(r'^API_FOOTBALL_LIVE_KEYS=(.*)$', c, re.M)
raw = m.group(1).strip().strip('"')
for k in re.split(r'[,\n;]+', raw):
    k = k.strip()
    if k:
        print(k)
PY
)
echo "Clés disponibles : ${#KEYS[@]}"

for i in $(seq 1 ${#KEYS[@]}); do
  idx=$((i - 1))
  echo ""
  echo "═══ TENTATIVE clé n°${i} / ${#KEYS[@]} (date ${DATE}) ═══"

  # tsx LOCAL uniquement (node22 + node_modules) : un fallback npx masquerait
  # une panne d'environnement derrière un faux « refus fournisseur ».
  if [ ! -x node_modules/.bin/tsx ]; then
    echo "✖ environnement non restauré (node_modules/.bin/tsx absent) — STOP, aucun appel émis."
    exit 2
  fi

  API_FOOTBALL_LIVE_KEYS="${KEYS[$idx]}" timeout 600 node_modules/.bin/tsx scripts/ingest-upcoming.ts --date "$DATE" --confirm-cost 1 > "/tmp/try-${i}.log" 2>&1

  if grep -q "rencontres      " "/tmp/try-${i}.log"; then
    if grep -q "Aucune compétition reconnue" "/tmp/try-${i}.log"; then
      echo "⚠ CLÉ ${i} acceptée mais aucune compétition ciblée ce jour-là (crédit dépensé) — voir /tmp/try-${i}.log"
      echo "CLE_OK_SANS_COMPETITION=${i}"
      exit 3
    fi
    echo "✔ CLÉ ${i} ACCEPTÉE — appel abouti, ingestion effectuée (voir /tmp/try-${i}.log)"
    tail -30 "/tmp/try-${i}.log"
    echo "CLE_OK=${i}"
    exit 0
  fi

  if grep -q "MODULE_NOT_FOUND\|Cannot find module" "/tmp/try-${i}.log"; then
    echo "✖ clé ${i} : PANNE D'ENVIRONNEMENT (module introuvable) — STOP pour ne pas confondre avec un refus fournisseur."
    exit 2
  fi

  err=$(grep -E "^✖" "/tmp/try-${i}.log" | tail -1)
  [ -z "$err" ] && err=$(grep -iE "refus|403|error" "/tmp/try-${i}.log" | tail -1)
  echo "✖ clé ${i} refusée — ${err:0:200}"
  sleep 1
done

echo "AUCUNE_CLE_VALIDE"
exit 1

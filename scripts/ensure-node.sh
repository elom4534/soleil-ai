#!/usr/bin/env bash
# ============================================================================
# SOLEIL — Garantit la présence de Node.js 22+
# ============================================================================
# Certaines dépendances (base PostgreSQL locale de Prisma) requièrent le module
# natif `node:sqlite`, disponible à partir de Node 22. Ce script installe une
# distribution locale dans ~/.local/node22 si la version système est trop
# ancienne, puis exporte le PATH pour la session courante.
#
# Usage : source scripts/ensure-node.sh
# ============================================================================
set -euo pipefail

NODE_VERSION="${SOLEIL_NODE_VERSION:-22.18.0}"
INSTALL_DIR="${HOME}/.local/node22"
ARCH="linux-x64"

current_major() { node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0; }

if [ "$(current_major)" -ge 22 ]; then
  echo "Node $(node -v) ✔" >&2
  return 0 2>/dev/null || exit 0
fi

if [ -x "${INSTALL_DIR}/bin/node" ]; then
  export PATH="${INSTALL_DIR}/bin:${PATH}"
  echo "Node local utilisé : $(node -v)" >&2
  return 0 2>/dev/null || exit 0
fi

echo "Node $(node -v 2>/dev/null || echo 'absent') détecté — installation de Node ${NODE_VERSION}…" >&2
mkdir -p "${HOME}/.local"
ARCHIVE="/tmp/soil-node.tar.xz"
if curl -sSL --max-time 300 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${ARCH}.tar.xz" -o "${ARCHIVE}"; then
  rm -rf "${INSTALL_DIR}"
  mkdir -p "${INSTALL_DIR}"
  tar -xJf "${ARCHIVE}" -C "${INSTALL_DIR}" --strip-components=1
  rm -f "${ARCHIVE}"
  export PATH="${INSTALL_DIR}/bin:${PATH}"
  echo "Node ${NODE_VERSION} installé : $(node -v)" >&2
else
  echo "❌ Téléchargement impossible. Installez Node 22+ manuellement." >&2
  exit 1
fi

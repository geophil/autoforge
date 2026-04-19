#!/bin/sh
set -e

DOCS_DIR="${QMD_DOCS_DIR:-/data/docs}"
COLLECTION_NAME="${QMD_COLLECTION_NAME:-autoforge}"
REINDEX_HOURS="${QMD_REINDEX_HOURS:-3}"
REINDEX_SECONDS=$((REINDEX_HOURS * 3600))

# QMD reads/writes everything under $XDG_CACHE_HOME/qmd. The Dockerfile sets
# XDG_CACHE_HOME=/data/.qmd, which is volume-mounted in docker-compose so
# the index persists across container restarts.
QMD_RUNTIME_DIR="${XDG_CACHE_HOME:-/data/.qmd}/qmd"
QMD_BUILD_CACHE="/opt/qmd-cache/qmd"

mkdir -p "${QMD_RUNTIME_DIR}"

# Symlink the baked embedding models from the image-layer cache into the
# runtime cache. The volume mount masks any image content at the runtime
# path, so we recreate the link on every boot (idempotent).
if [ ! -e "${QMD_RUNTIME_DIR}/models" ] && [ -d "${QMD_BUILD_CACHE}/models" ]; then
  ln -s "${QMD_BUILD_CACHE}/models" "${QMD_RUNTIME_DIR}/models"
  echo "[qmd] Linked baked models from ${QMD_BUILD_CACHE}/models"
fi

# QMD only embeds files inside registered collections — `qmd embed` is a
# no-op if no collection covers the docs dir. Register it on first boot.
if ! qmd collection list 2>/dev/null | grep -q "${COLLECTION_NAME}"; then
  echo "[qmd] Registering collection '${COLLECTION_NAME}' for ${DOCS_DIR}..."
  qmd collection add "${DOCS_DIR}" --name "${COLLECTION_NAME}"
fi

INDEX_FILE="${QMD_RUNTIME_DIR}/index.sqlite"
if [ ! -f "${INDEX_FILE}" ] || [ ! -s "${INDEX_FILE}" ]; then
  echo "[qmd] Index empty/missing at ${INDEX_FILE} — running initial embed of ${DOCS_DIR}..."
  qmd embed
  echo "[qmd] Initial embed complete."
else
  echo "[qmd] Existing index at ${INDEX_FILE} found — running incremental embed..."
  qmd embed
fi

# Background re-indexing loop — keeps the index fresh as docs are updated
# on the host (volume-mounted into ${DOCS_DIR}).
(
  while true; do
    sleep "${REINDEX_SECONDS}"
    echo "[qmd] Scheduled re-index of ${DOCS_DIR}..."
    qmd embed
    echo "[qmd] Re-index complete."
  done
) &

echo "[qmd] Starting HTTP MCP server on port 8181 (bound to 0.0.0.0)..."
exec qmd mcp --http

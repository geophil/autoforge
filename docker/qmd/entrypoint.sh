#!/bin/sh
set -e

DOCS_DIR="${QMD_DOCS_DIR:-/data/docs}"
REINDEX_HOURS="${QMD_REINDEX_HOURS:-3}"
REINDEX_SECONDS=$((REINDEX_HOURS * 3600))
INDEX_DIR="/data/.qmd"

# Run initial embed if the index volume is empty (first boot or fresh volume).
if [ ! -d "${INDEX_DIR}" ] || [ -z "$(ls -A "${INDEX_DIR}" 2>/dev/null)" ]; then
  echo "[qmd] Index not found — running initial embed of ${DOCS_DIR}..."
  qmd embed "${DOCS_DIR}"
  echo "[qmd] Initial embed complete."
else
  echo "[qmd] Existing index found, skipping initial embed."
fi

# Background re-indexing loop — keeps the index fresh as docs are updated.
(
  while true; do
    sleep "${REINDEX_SECONDS}"
    echo "[qmd] Scheduled re-index of ${DOCS_DIR}..."
    qmd embed "${DOCS_DIR}"
    echo "[qmd] Re-index complete."
  done
) &

echo "[qmd] Starting HTTP MCP server on port 8181..."
exec qmd mcp --http

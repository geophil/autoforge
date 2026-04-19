FROM node:22-slim

# SQLite with extension support (required by QMD)
RUN apt-get update && \
    apt-get install -y --no-install-recommends sqlite3 libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g @tobilu/qmd

# ─── QMD bind patch ────────────────────────────────────────────────────────
# Upstream `qmd mcp --http` hardcodes a `localhost`-only bind in
# dist/mcp/server.js, which makes it unreachable from the host (port mapping
# fails) and from sibling docker services. Patch the compiled JS at build
# time so the MCP server binds 0.0.0.0:8181 instead. Track an upstream
# request to expose a `--host` flag on `qmd mcp` and remove this patch.
RUN sed -i.bak \
      's|httpServer.listen(port, "localhost"|httpServer.listen(port, "0.0.0.0"|' \
      /usr/local/lib/node_modules/@tobilu/qmd/dist/mcp/server.js && \
    grep -q '"0.0.0.0"' /usr/local/lib/node_modules/@tobilu/qmd/dist/mcp/server.js

# ─── Model warmup ──────────────────────────────────────────────────────────
# QMD lazy-downloads its embedding model (Embeddinggemma 300M, ~330MB) on
# first real `qmd embed`. Bake it into a build-time cache at /opt/qmd-cache
# so runtime never has to download it. We use a separate cache dir from the
# runtime XDG_CACHE_HOME (which gets volume-mounted, masking image content);
# the entrypoint symlinks the models in at startup.
#
# QMD only embeds files inside a registered collection, so we add the
# warmup dir as a collection first, run embed, then drop the throwaway
# index. The 330MB GGUF stays in /opt/qmd-cache/qmd/models.
ENV XDG_CACHE_HOME=/opt/qmd-cache
RUN mkdir -p /tmp/warmup && \
    echo "# warmup" > /tmp/warmup/warmup.md && \
    qmd collection add /tmp/warmup --name warmup && \
    qmd embed && \
    rm -rf /tmp/warmup && \
    rm -f /opt/qmd-cache/qmd/index.sqlite \
          /opt/qmd-cache/qmd/index.sqlite-shm \
          /opt/qmd-cache/qmd/index.sqlite-wal && \
    ls /opt/qmd-cache/qmd/models/ >/dev/null

# Switch XDG_CACHE_HOME for the runtime so QMD reads/writes its index inside
# the volume-mounted /data/.qmd. The entrypoint symlinks the baked models
# from /opt/qmd-cache into this path on startup.
ENV XDG_CACHE_HOME=/data/.qmd

WORKDIR /data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8181
ENTRYPOINT ["/entrypoint.sh"]

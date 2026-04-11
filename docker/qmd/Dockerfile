FROM node:22-slim

# SQLite with extension support (required by QMD)
RUN apt-get update && \
    apt-get install -y --no-install-recommends sqlite3 libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g @tobilu/qmd

WORKDIR /data

# Bake GGUF models into the image by running a dummy embed during build.
# QMD downloads models on first use — doing it here means they're cached in
# the image layer and startup is instant regardless of network conditions.
RUN mkdir -p /tmp/warmup && \
    echo "# warmup" > /tmp/warmup/warmup.md && \
    qmd embed /tmp/warmup && \
    rm -rf /tmp/warmup

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8181
ENTRYPOINT ["/entrypoint.sh"]

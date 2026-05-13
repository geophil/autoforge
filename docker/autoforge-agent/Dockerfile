# Autoforge agent workspace image.
#
# This is the runtime that hosts agent tool calls when WORKSPACE_PROVIDER=docker.
# The orchestrator bind-mounts each task's git worktree at /workspace and runs
# `docker exec` against this image for read/write/exec tool calls, lifecycle
# hooks (`bun run lint/test`), and PR-gate test runs.
#
# Contract (do not break without updating src/runtime/container-workspace.ts):
# - A user named `agent` exists with uid=1000 and gid=1000. The orchestrator
#   passes `-u <uid>:<gid>` from WORKSPACE_DOCKER_UID / WORKSPACE_DOCKER_GID
#   (both default 1000); change those env vars only if you rebuild this image
#   with a different user.
# - WORKDIR is /workspace and the directory is owned by agent:agent so the
#   bind-mounted worktree is writable from inside the container.
# - The default command is `sleep infinity`. The runner overrides it with
#   `["sleep", "infinity"]` (see buildDockerCreateArgs); this is the fallback
#   when the image is run by hand for debugging.
# - `bun` and `git` must be on PATH so lifecycle hooks (`bun run <script>`)
#   and orchestrator-driven git operations work without further provisioning.

FROM oven/bun:1.2.4-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# `oven/bun` ships a `bun` user at uid=1000 already; reuse it as `agent`.
# If the host UID differs, the operator either rebuilds the image with a
# matching uid or runs the container with the host user via -u <uid>:<gid>.
RUN if id bun >/dev/null 2>&1; then \
      groupmod -n agent bun && usermod -l agent -d /home/agent -m bun; \
    else \
      groupadd -g 1000 agent && useradd -u 1000 -g 1000 -m -d /home/agent -s /bin/bash agent; \
    fi

RUN mkdir -p /workspace && chown agent:agent /workspace
WORKDIR /workspace

USER agent

CMD ["sleep", "infinity"]

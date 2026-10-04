# Ferrum sandbox image (stage 1). Same contents as the engine's documented default image
# (docs/gateway/sandboxing/images-and-setup.md): bash, ca-certificates, curl, git, jq,
# python3 (needed by the sandbox write/edit helpers) and ripgrep. No Node, no secrets.
# Build: scripts/wsl/30-build-sandbox-image.sh   Tag: ferrum-sandbox:bookworm-slim
ARG BASE=debian:bookworm-slim
FROM ${BASE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git jq python3 ripgrep \
 && rm -rf /var/lib/apt/lists/*
# uid 1000 is only the fallback: the gateway starts the container as the host user's uid:gid
# (agents.defaults.sandbox.docker.user) so the bind-mounted workspace is writable.
RUN useradd --create-home --uid 1000 --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox
CMD ["sleep", "infinity"]

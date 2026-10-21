# Official ecosystem image plus socat and curl.
# socat forwards 127.0.0.1 to the host so clients that only allow HTTP
# on localhost (Cargo, Composer, Maven) can reach DepGate on the host.
ARG BASE=node:22-bookworm-slim
FROM ${BASE}
USER root
# composer:2 is Alpine; the other base images are Debian.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache socat curl ca-certificates bash coreutils; \
    else \
      apt-get update \
      && apt-get install -y --no-install-recommends socat curl ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi

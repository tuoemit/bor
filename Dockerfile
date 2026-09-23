# Works as-is on both Render and Railway.
#
# Two reasons this image is Debian-based rather than Alpine:
#   1. the Servo sidecar binary is glibc-linked (no musl build exists),
#   2. it links libfontconfig/libfreetype and needs real fonts installed,
#      otherwise every fidelity screenshot renders text as empty boxes.

# ---------- stage 1: fetch the Servo sidecar binary ----------
FROM debian:bookworm-slim AS servo-bin
ARG SERVO_FETCH_VERSION=0.15.1
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Buildx gives us TARGETARCH; map it to the release's target triple.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) TRIPLE=x86_64-unknown-linux-gnu ;; \
      arm64) TRIPLE=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/sf.tar.gz \
      "https://github.com/konippi/servo-fetch/releases/download/v${SERVO_FETCH_VERSION}/servo-fetch-v${SERVO_FETCH_VERSION}-${TRIPLE}.tar.gz"; \
    mkdir -p /out; \
    tar xzf /tmp/sf.tar.gz -C /out --strip-components=1; \
    chmod +x /out/servo-fetch; \
    /out/servo-fetch --version || true

# ---------- stage 2: runtime ----------
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/browser.db \
    SERVO_BIN=/app/bin/servo-fetch

WORKDIR /app

# Runtime deps for the sidecar: fonts are NOT optional (see header comment).
# curl is kept for the healthcheck and for debugging in a shell.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates \
      libfontconfig1 libfreetype6 libstdc++6 libpng16-16 \
      libbrotli1 libbz2-1.0 libexpat1 zlib1g \
      fontconfig fonts-dejavu-core \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first so the layer caches across code edits.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .
COPY --from=servo-bin /out/servo-fetch /app/bin/servo-fetch

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

# Uses node itself so no extra tooling is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

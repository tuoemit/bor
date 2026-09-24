# Chromium engine build for Render / Railway.
#
# Debian, not Alpine: Playwright's Chromium is glibc-linked, and the engine's
# system libraries (nss, atk, cups, gbm...) come from Playwright itself.
#
# Image size is the cost of a real browser: ~800 MB of Chromium plus its
# dependencies. Railway's builder handles it; it is not a free-tier-friendly
# deploy (see README for the memory profile).

# ---------- stage 1: browser + system deps ----------
FROM node:22-bookworm-slim AS browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
# Installs Chromium *and* apt-installs every shared library it needs.
RUN npx playwright-core install --with-deps chromium  && rm -rf /var/lib/apt/lists/*

# ---------- stage 2: runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/browser.db \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Node's heap: anything in this container that isn't the browser.
    NODE_OPTIONS=--max-old-space-size=384

WORKDIR /app

# Runtime libraries Chromium needs. Kept explicit rather than relying on the
# build stage having them, because this stage starts from a clean base.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libcairo-gobject2 \
      libx11-6 libxcb1 libxext6 libxi6 libxtst6 libglib2.0-0 \
      fonts-dejavu-core fontconfig ca-certificates curl tini \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .
COPY --from=browsers /ms-playwright /ms-playwright

RUN mkdir -p /data /tmp/bp-downloads && chown -R node:node /data /tmp/bp-downloads /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the zombie processes Chromium leaves behind.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

# Works as-is on both Render and Railway.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/browser.db

WORKDIR /app

# Dependencies first so Docker layer caching survives code edits.
# No native modules (sql.js is WASM) -> no compiler needed, fast builds.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Writable location for the SQLite file. Without a mounted volume this is
# wiped on redeploy; the app falls back to an in-memory DB if it can't write.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.js"]

# cloud-browser -- single image that runs on BOTH Render and Railway.
#
# Design: the Firefox (Gecko) build is downloaded DURING the image build, from
# the exact playwright version pinned in package-lock.json. That guarantees the
# bundled browser always matches the playwright library at runtime -- no version
# skew, and no reliance on the platform reaching the Playwright CDN at startup.
# There is NO Chromium anywhere: only the Firefox build is fetched.

FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# System libraries Firefox needs to run headless (GTK/NSS/ASound/etc.), plus a
# couple of build basics. `playwright install-deps` would also work; listing the
# set explicitly keeps the layer deterministic.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
      libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxrandr2 libgbm1 libxcb1 libxkbcommon0 libasound2 libcairo2 libpango-1.0-0 \
      fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Install JS deps first so app edits don't bust this (large) layer.
# --ignore-scripts is deliberate: the package's own postinstall hook downloads
# Firefox, but at this stage scripts/ is not copied yet (layer caching), which
# made the build fail with "Cannot find module scripts/postinstall.js". The
# explicit `npx playwright install` below does the same job deterministically.
# (playwright/playwright-core ship no lifecycle scripts, so --ignore-scripts
# skips nothing else.)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# Fetch ONLY the Firefox build that matches the pinned playwright, plus its
# system libraries. This is what the postinstall hook would have done.
RUN npx playwright install firefox --with-deps

# Copy the app (server + public assets). Vanilla JS -- no build step.
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Data (saved profiles + downloads) lives on the container filesystem. Mount a
# volume/disk at /app/data on the platform to persist it across restarts; the app
# works fine without one (profiles simply reset per boot).
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data/sessions /app/data/downloads

EXPOSE 3000

# Render and Railway both inject $PORT; the app binds 0.0.0.0:$PORT.
CMD ["node", "server/index.js"]

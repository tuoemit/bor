FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    HOME=/home/browser \
    CHROME_USER_DATA_DIR=/home/browser/chrome-profile \
    SCREEN_WIDTH=390 \
    SCREEN_HEIGHT=844 \
    SCREEN_DEPTH=24

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    openbox \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    dbus-x11 \
    procps \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -d /home/browser -s /bin/bash browser \
    && mkdir -p /home/browser/chrome-profile \
    && chown -R browser:browser /home/browser

COPY start.sh /app/start.sh
COPY README.md /app/README.md
RUN chmod +x /app/start.sh

USER browser
WORKDIR /home/browser

EXPOSE 10000

CMD ["/app/start.sh"]

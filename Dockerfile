FROM mcr.microsoft.com/playwright:v1.56.1-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC

RUN apt-get update \
    && apt-get install -yq --no-install-recommends \
        xvfb \
        x11vnc \
        fluxbox \
        novnc \
        websockify \
        supervisor \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src ./src
COPY scripts/start.sh ./scripts/start.sh
RUN chmod +x ./scripts/start.sh

RUN mkdir -p /profiles/default

ENV PORT=4000 \
    PROFILE_DIR=/profiles/default \
    HEADLESS=true \
    NAVIGATION_TIMEOUT=45000 \
    CONCURRENCY=1 \
    DISPLAY=:99 \
    XVFB_WIDTH=1366 \
    XVFB_HEIGHT=768 \
    XVFB_DEPTH=24 \
    VNC_PORT=5900 \
    NOVNC_PORT=7900

EXPOSE 4000
EXPOSE 5900
EXPOSE 7900

CMD ["./scripts/start.sh"]

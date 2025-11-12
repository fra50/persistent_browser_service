# Persistent Browser Service

This project provides a small HTTP API that keeps a Chromium instance warm using Playwright. It is optimized for:

- Persistent sessions (cookies, logins) via launchPersistentContext
- Fast turnaround: the browser stays open, so each /fetch call only navigates
- Simple Docker deployment so you can run it anywhere

## Key Features
- **POST /fetch** — Navigate to a URL, wait for selectors/timeouts, and return rendered HTML + metadata.
- **GET /health** — Lightweight health and readiness info.
- **POST /reset** — Force the browser context to restart if it ever gets stuck.
- Request queue to prevent overlapping commands against the same context.
- Optional extraction helper: supply selectors to capture text/attributes without extra parsing downstream.

## Local Development
```bash
npm install
npm start
```

Send a request:
```bash
curl -X POST http://localhost:4000/fetch \
     -H "Content-Type: application/json" \
     -H "X-API-Key: super-secret-key" \
     -d '{
           "url": "https://www.google.com/search?q=browser+automation",
           "waitForSelector": "div#search",
           "waitForTimeout": 1500,
           "extract": [
             {"name": "firstResult", "selector": "div#search h3"}
           ],
           "evaluateScript": "({ limit }) => { const cards = [...document.querySelectorAll(\'#search h3\')]; return cards.slice(0, limit).map(el => el.innerText); }",
           "evaluateArgs": { "limit": 3 }
         }'
```

## Specialized Endpoints

### `POST /search`
```bash
curl -X POST http://localhost:4000/search \
     -H "Content-Type: application/json" \
     -H "X-API-Key: super-secret-key" \
     -d '{
           "query": "ai automation agency",
           "limit": 5,
           "lang": "en",
           "returnHtml": false
         }'
```
Returns a `results` array with `{ title, link, snippet, sitePath }` plus metadata.

### `POST /maps`
```bash
curl -X POST http://localhost:4000/maps \
     -H "Content-Type: application/json" \
     -H "X-API-Key: super-secret-key" \
     -d '{
           "query": "brasserie paris",
           "limit": 10,
           "waitForTimeout": 3000,
           "scroll": true,
           "returnHtml": false
         }'
```
Returns `{ title, href, rating, reviews, descriptor }` entries gathered from the Maps results panel (the service scrolls automatically until it reaches the requested limit).

## Docker
Build and run:
```bash
docker build -t persistent-browser-service .
docker run -d \
  --name pb-service \
  -p 4000:4000 \
  -p 5900:5900 \
  -p 7900:7900 \
  -e API_KEY=super-secret-key \
  -e HEADLESS=false \
  -v $PWD/profiles:/profiles \
  persistent-browser-service
```

Environment variables:
- `PROFILE_DIR` — Persistent profile path inside the container (`/profiles/default` by default). Mount a host path to keep credentials.
- `HEADLESS` — Set to `false` (recommended when you need to click/observe through VNC) so Chromium uses the virtual display.
- `CONCURRENCY` — How many pages to run in parallel. Keep at 1 if the profile should behave like a single browser.
- `NAVIGATION_TIMEOUT` — Default timeout in ms for navigation and waits.
- `VNC_PORT` / `NOVNC_PORT` — Ports exposed for x11vnc (default `5900`) and the noVNC web proxy (default `7900`). Open `http://localhost:7900/vnc.html?host=localhost&port=7900` to see and control the same Chromium session the API uses, or connect any VNC client to `localhost:5900`. Use the same `API_KEY` value when prompted for the VNC password.
- `API_KEY` — Required for all REST requests (`X-API-Key` header) and used as the VNC/noVNC password. If unset, the API rejects requests and VNC will run without a password (not recommended).

## API Schema
### POST /fetch
Body fields:
| Field | Type | Description |
| --- | --- | --- |
| `url` | string (required) | Target URL to visit. |
| `waitUntil` | string | Any Playwright wait mode (`load`, `domcontentloaded`, `networkidle`). Default `networkidle`. |
| `waitForSelector` | string | Optional CSS selector to await after navigation. |
| `waitForSelectorTimeout` | number | Override timeout for the selector wait. |
| `waitForTimeout` | number | Extra delay (ms) after waits finish. |
| `headers` | object | Extra HTTP headers to send. |
| `returnHtml` | boolean | Disable if you only need metadata/extracted fields. Default `true`. |
| `extract` | array | List of `{ name, selector, attr }` objects to pull text/attributes client-side. |
| `evaluateScript` | string | Optional JavaScript function (as a string) executed inside the page after waits. Should be something like `async (args) => { ...; return data; }`. |
| `evaluateArgs` | object | JSON payload passed as the single `args` argument to the evaluate script. |

Response JSON:
```json
{
  "timestamp": "2025-11-12T13:05:02.123Z",
  "url": "https://...",
  "finalUrl": "https://...",
  "status": 200,
  "duration": 3120,
  "extracted": { "firstResult": "Example" },
  "evaluated": { "items": [...] },
  "html": "<!doctype html>..."
}
```

### GET /health
Returns `{ "ok": true, "browserReady": true, "queueSize": 0, "pending": 0 }`. (Requires the same `X-API-Key` header.)

### POST /reset
Closes the Playwright context and starts a new one on the next request.

## Production Tips
- Mount the profile directory to persist logins (e.g., `-v /data/profiles:/profiles`).
- Use a residential/VPN exit if you query Google or other strict sites.
- Keep `CONCURRENCY=1` per profile to avoid corrupting browsing state.
- Add an authentic user-agent or custom headers via the `/fetch` request to mimic real traffic.
- Extend this service by adding more routes (screenshots, PDFs) reusing the same persistent context.

## Docker Compose Deployment

If you want a one-command install on any server:

1. Copy/clone this repository to your target machine.
2. Duplicate the environment template `cp .env.example .env` and set `API_KEY` (the same value guards the REST API and VNC/noVNC).
3. Launch the stack:
   ```bash
   docker compose up -d
   ```
4. Verify:
   - REST API: `curl -H "x-api-key: $API_KEY" http://localhost:4000/health`
   - noVNC: `http://SERVER_IP:7900/vnc.html?host=SERVER_IP&port=7900` (password = `API_KEY`).

`docker-compose.yml` exposes ports `4000/5900/7900` and mounts `./pb-profiles` into `/profiles` inside the container so your Chromium profile (cookies/logins) persists across restarts. Edit `docker-compose.yml` or `.env` if you need different paths or ports.

# Technical Overview – Persistent Browser Service MVP

## 1. Problem Statement & Goals
We need a reusable “persistent browser” backend that can execute Playwright-driven scraping workflows (Google SERP, Maps, arbitrary fetches) while:
- Keeping browser state warm (persistent profiles, cookies) for faster, more human-like interactions.
- Exposing API endpoints that clients can hit via HTTPS with API keys.
- Detecting blockers (cookie consent, CAPTCHA) and reporting them instead of empty payloads.
- Remaining deployable on a single self-hosted server initially, with a clear path to horizontal scaling (workers, Redis queue, module system).

The MVP should prove:
1. A single worker container deployed via Docker can service `/fetch`, `/search`, `/maps`, `/health`, `/reset`.
2. API key auth works.
3. Blocker detection returns structured payloads (HTTP 409) for cookie/CAPTCHA surfaces.
4. Architecture allows plugging in future endpoints and additional workers without downtime.

## 2. Current Implementation Snapshot
- **Language/Runtime:** Node.js (ES Modules). Core logic in `src/index.js`.
- **HTTP Server:** Express 5, JSON body parsing limited to 512 KB, Morgan logging.
- **Browser Layer:** Playwright Chromium with `launchPersistentContext` using a configurable profile directory (`PROFILE_DIR`).
- **Queueing:** `p-queue` with single-concurrency guard to serialize page access.
- **Endpoints:**
  - `POST /fetch`: generic navigation + optional waits/extract/evaluate snippets.
  - `POST /search`: Google SERP wizard with snippet extraction, top stories, AI overview.
  - `POST /maps`: Google Maps search scraping with optional scrolling.
  - `GET /health`: readiness info (shared page status, queue size).
  - `POST /reset`: restarts the persistent context.
- **Security:** API key required via `X-API-Key` header or `api_key` query param. Without `API_KEY`, service refuses requests.
- **Blocker Detection:** After navigation, each endpoint runs `detectAccessBlocker` (cookie, CAPTCHA, Cloudflare patterns, missing selectors). If triggered, returns HTTP 409 `{"blocked":true,...}`.
- **Dockerization:** Base image `mcr.microsoft.com/playwright:v1.56.1-jammy`, startup script launches Xvfb, fluxbox, x11vnc, noVNC, then Node entry point.
- **Config:** `.env` file (example):
  ```
  API_KEY=local-dev-key
  PROFILE_DIR=/profiles/google
  HEADLESS=false
  CONCURRENCY=1
  NAVIGATION_TIMEOUT=45000
  ```

## 3. MVP Architecture (Single-Host Deployment)
### Components
1. **Ingress (Nginx/Caddy)**
   - Terminates TLS via Let’s Encrypt, enforces rate limits, proxies `/fetch`, `/search`, etc. to the Node.js container.
2. **Persistent Browser Worker (current repo)**
   - Runs via Docker Compose.
   - Mounts `./pb-profiles` for persistent session storage.
   - Uses environment variables to tune behavior (headless/headed, concurrency, extra browser args).
3. **Redis (optional for MVP)**
   - Used only if you want to test queueing/locks early. For single worker MVP, not required; requests go directly to Express.

### Request Flow
1. Client sends HTTPS `POST /fetch` with API key.
2. Nginx forwards to worker container.
3. Worker enqueues job via `p-queue` and drives Playwright page.
4. If blocker detected, returns 409 payload; otherwise returns JSON result (with optional HTML).
5. `/health` reports readiness for monitoring.

### Deployment Steps (MVP)
1. `git clone` repo onto VPS.
2. `cp .env.example .env` and set `API_KEY`, `HEADLESS`, `PROFILE_DIR`.
3. `docker compose up -d` to start worker.
4. Configure Nginx reverse proxy with TLS cert + basic WAF rules, forwarding to `localhost:4000`.
5. Test using `curl -H "X-API-Key: <key>" http://server/fetch`.

## 4. Future Worker Architecture (Scalable Design)
*(Summarizes `docs/worker-architecture/action-plan.md` for team reference.)*

### Objectives
- **Modular endpoint logic:** load signed modules at runtime; no redeploy to add endpoints.
- **Horizontal scaling:** multiple workers consuming from Redis Streams, coordinated via locks.
- **Resource pooling:** page pools per browser context with state reset.
- **Telemetry & security:** Prometheus metrics, structured logs, secret management, hardened containers.

### Key Components
1. **HTTP Synchronous API (Fastify/Go)**
   - For sub-3 s endpoints. Balanced via Envoy/NGINX, health-checked, hedged retries.
2. **Async API + Orchestrator (n8n + Redis or RabbitMQ)**
   - Accepts long-running jobs, returns job ID, pushes to queue.
3. **Workers**
   - Node/TypeScript service with:
     - Redis Stream consumer groups for job intake.
     - Profile locks (`SETNX`), quota enforcement, heartbeat.
     - Playwright context+page pools (N pages per context).
     - Plugin loader for endpoint modules (signed bundles).
     - Blocker detection, solver integrations, behavior plugins.
     - Result reporting via Redis streams or HTTP callback.
4. **Supporting Infra**
   - Redis cluster, Postgres for tenancy, object storage (MinIO/S3) for profiles & artifacts.
   - Prometheus + Grafana + Loki for observability.
   - Vault/SOPS for secrets.

### Execution Pipeline (Async Path)
```
Client -> Cloudflare/Nginx -> Async API (auth, validation)
      -> Redis job stream (job_id, tenant, endpoint, payload)
      -> Worker (lock profile, reserve page, run module)
      -> Result stream/callback -> Async API -> Client webhook/poll.
```

### Synchronous Path
```
Client -> Cloudflare/Nginx -> Sync API -> Envoy -> Worker HTTP server -> result
```
Endpoints must stay under timeout budget; otherwise rerouted to async path.

### Development Considerations
- **Contracts:** Document job schema, module interface, and config spec (ADR #1).
- **Testing:** Unit tests for scheduler/locks, integration suite with mock Redis + Playwright.
- **CI/CD:** GitHub Actions building Docker image, automated tests, push to registry, staged rollout (canary).
- **Security:** API keys per tenant, TLS everywhere, strict firewall between ingress and workers, sandboxed Playwright.

## 5. Operational Checklist
1. **Secrets & Config**
   - Store API keys/configs in `.env` for MVP; plan migration to Vault/SOPS.
2. **Logging & Metrics**
   - Enable structured logging (JSON) and forward to Loki/ELK.
   - Deploy Prometheus node exporter + app metrics (pending queue, job durations).
3. **Blocking Monitoring**
   - Track rate of `blocked=true` responses to identify IP bans/cookie walls.
4. **Profiles**
   - Ensure `pb-profiles` volume persists. Consider per-tenant directories to avoid cross-contamination.
5. **Scaling Plan**
   - Document manual process for adding a second worker (copy repo, configure `.env`, run with different profile path).
   - Define cutover strategy when moving from single worker to Redis-backed fleet.

## 6. Roadmap Milestones
| Milestone | Description | Deliverables |
| --- | --- | --- |
| MVP launch | Single worker behind TLS, /fetch-/search-/maps live | Docker deployment guide, monitoring basic checks |
| Blocker telemetry | Dashboards for CAPTCHA/cookie detections | Prometheus alerts |
| Modular endpoints | Loader + registry for custom scripts | ADR, sample module |
| Async pipeline | n8n + Redis job queue, worker consumer | Job schema, result callbacks |
| Horizontal scale | Multiple workers, load balanced ingress | Service discovery, health checks |

## 7. References
- `src/index.js` – main service implementation.
- `docs/worker-architecture/action-plan.md` – future worker design.
- `README.md` – API usage instructions.

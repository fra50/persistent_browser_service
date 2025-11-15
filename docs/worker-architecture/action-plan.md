# Worker Architecture Action Plan (Gateway → n8n → Redis → Workers)

## Objectives (Best-Practice Anchors)
- **Plug-and-Play with Ingress Stack:** Workers must accept jobs pushed by n8n via Redis Streams/Lists without assuming direct public access, and remain agnostic of Cloudflare/webhook details.
- **Modular Endpoint Runtime:** New scraping logic ships as loadable modules (signed bundles) so production workers keep running while endpoints are added/updated.
- **Horizontal Scalability:** Any worker instance can consume any job; browser profiles and per-tenant limits are coordinated through Redis locks/quotas so scaling out simply means adding pods.
- **Resource Isolation & Pooling:** Each worker maintains a Playwright context + multi-page pool with strict reservation/recycle semantics to prevent job interference while keeping browsers warm.
- **Resilience & Observability:** Built-in health probes, structured logging, Prometheus metrics, distributed tracing, and self-healing for crashed pages/contexts ensure 24/7 reliability.
- **Security & Compliance:** Tenant-scoped secrets, signed module verification, auditable execution traces, and hardened sandbox (seccomp/AppArmor) around the browser process.
- **Operational Configurability:** Concurrency, proxy policies, retry limits, blocker thresholds, and feature flags pulled from centralized config (Redis/hash store or SSM) with hot reload.
- **Testability & CI/CD:** Deterministic contracts, mocks for Redis/Playwright, integration suites, canary deploy pipeline with automated rollback.

## Action Plan
## Technical Specification

### 1. API Gateway Layer
- Implement a stateless HTTP API (Fastify/Go) fronted by Nginx/Caddy.
- Responsibilities: authenticate API keys (stored in Redis/Postgres), enforce per-tenant rate limits (Redis token bucket), maintain a pool of healthy worker targets.
- Expose `/fetch`, `/search`, `/maps`, `/health` endpoints mirroring current Express contract.
- Health monitoring: periodically call each worker’s `/health` endpoint; store status in Redis (`worker:<id>:state`), remove unhealthy workers from routing.
- Routing: API proxy selects the least-loaded healthy worker (round-robin with Redis-backed counters) and forwards the client request; hedged retry after 200 ms if the first worker doesn’t respond.
- Metrics: request latency, success/error codes per endpoint, worker response time histogram.
- API↔Worker contract:
  - Request JSON schema (`fetchRequest`, `searchRequest`, `mapsRequest`) mirrors current Express payloads. Documented in `docs/api-schemas/*.json`.
  - Response schema (`fetchResponse`, `searchResponse`, `mapsResponse`, `blockedResponse`) aligned with worker outputs. API validates worker responses before returning to clients.
  - Include `traceId` header propagated end-to-end.

### 2. Worker Container
- Base image: Playwright + Node; add a lightweight HTTP server (Fastify) to receive synchronous requests from the API.
- Endpoints: `/fetch`, `/search`, `/maps`, `/health`, `/metrics`. Each request directly runs on the worker (no queue in synchronous phase).
- Modular endpoints: define a `modules/` directory; each module exports `schema`, `handler`. On boot the worker loads the module list (from local disk or remote registry), with hot reload triggered by `SIGHUP` or periodic checksum check.
- Module packaging/signing:
  - Module bundle = tarball containing `module.js`, `schema.json`, `metadata.json` (fields: `name`, `version`, `checksum`, `allowedTenants`).
  - Tarball signed with Ed25519; worker verifies signature against trusted public key before loading.
  - Registry layout: `modules/<name>/<version>/bundle.tar.gz` + `signature`. n8n publishes new versions and updates metadata in Redis (`module:<name>:current=version`).
  - Loader keeps multiple versions for canary rollout (tag workers to use beta versions).
- Health reporting: worker updates `worker:<id>:state=healthy` in Redis every 5 s and expires key in 15 s; includes metrics (CPU, queue length).
- Logging: JSON logs including `trace_id` propagated from API; send to Loki stack.
- Config: `.env`/YAML for Redis URI, profile path, concurrency, headless flag, module registry URL. Support hot reload via config watcher.
- Adaptive concurrency: implement an admission controller that samples per-page latency and adjusts the effective `POOL_SIZE` to meet latency SLOs (circuit-breaker style throttling).
- Deterministic builds: lock dependencies and publish image checksums/signatures so every worker instance is identical (important for reproducibility/security).

### 3. Redis Usage
- Primary store for rate limiting, worker health, and (future) asynchronous jobs.
- Structures:
  - `apikey:<key>` → tenant info, quotas.
  - `rate:<tenant>` → token bucket counters with TTL.
  - `worker:<id>:state` → `healthy|degraded|down` + metadata (CPU, last_ping).
  - `dispatch:stats` → per-worker request counts for routing decisions.
- Credentials stored securely; enable AOF + replication.

### 4. Worker Lifecycle & Scaling
- Each worker maintains a Playwright context + page pool (configurable `POOL_SIZE`). For synchronous phase, requests are queued locally (PQueue) per page.
- Use systemd/Docker health checks to restart crashed workers automatically; API removes them from routing until they pass health checks again.
- Deployment: workers packaged as Docker images; updates automated via n8n calling Elestio API (stop container, pull new image, start). API detects worker drain via `/health` and temporarily stops routing to it.
- Multi-region readiness: tag workers by region/availability zone; API prefers same-region workers but can fail over cross-region. Plan for per-region Redis replicas or async replication.
- Chaos testing: schedule periodic simulated failures (kill worker, drop Redis connection) to verify self-healing and alerting.

### 5. Security
- API-to-worker communication restricted to private network/VPN; mutual TLS or IP allowlist.
- Secrets (API keys, Redis password) managed via env vars initially; plan migration to Vault/SOPS.
- Workers run as non-root, read-only filesystem, seccomp profile to harden Chromium.
- Module bundles signed (e.g., SHA256 + signature file) before deployment; worker verifies signature before loading.

### 6. Observability
- Prometheus exporters on API and workers. Metrics: request latency, worker pool utilization, Chromium restarts, blocker detections.
- Grafana dashboards for real-time monitoring; alerts on worker health key expiry, high latency, error spikes.
- Centralized logs (Loki/ELK) with trace IDs for root-cause analysis.
- Synthetic monitoring: continuously run scripted SERP/MAPS requests from multiple regions to validate latency/error SLOs; feed results into alerting.

### 7. Future Async Path (Placeholder)
- Reserve Redis Streams namespaces (`jobs:<endpoint>`) for later asynchronous mode. API already tags requests with `trace_id` so switching to async won’t break clients.
- Workers expose a background consumer service disabled by default; can be enabled when async pipeline is ready.
- Latency SLOs: define P50/P95 budgets (e.g., 1.5 s / 3 s) and feed into adaptive throttling + autoscaling signals.
- Capacity planning: maintain formulas that translate target QPS into required worker count. Automate alerts when worker utilization exceeds 70%.
- Disaster recovery: nightly backups of Redis (RDB/AOF) and worker config in off-site storage; documented runbook for restoring service in <30 min.
- API schema registry: publish OpenAPI/JSON Schema definitions for all public endpoints, versioned in `docs/api-schemas`. Validate requests/responses against these schemas in both API and worker unit tests.

### 8. Testing & Deployment
- Automated tests: module loader unit tests, health reporting, routing logic in API, Playwright smoke tests per endpoint.
- CI: lint → unit → integration → Docker build → security scan (Trivy/Grype) → push to registry.
- Deployment: n8n triggers rolling update (one worker at a time) via Elestio API; API removes each worker from routing when `draining=true` flag set. Include automatic smoke test after each worker rejoins.

## Action Plan
1. **Contract & Schema Definition**
   - Draft REST contracts for API ↔ worker (payloads identical to current Express endpoints).
   - Define worker module interface (`registerRoute({ name, schema, handler })`).
   - Specify Redis structures for api keys, rate limits, worker health.

2. **Worker Runtime Skeleton**
   - Build a TypeScript service that on boot: loads config, establishes Redis connection (Streams consumer group), registers Prometheus exporters, and performs self-checks.
   - Implement graceful shutdown: stop polling Redis, drain in-flight jobs, release page locks, close browser contexts.
   - Expose an internal health HTTP endpoint for Kubernetes/nomad probes.

3. **Redis Integration Layer**
   - Use consumer groups to pull jobs; acknowledge only after successful result emission back to n8n (via Redis pub/sub or HTTP callback).
   - Implement distributed locks (`SETNX` with TTL) for profile directories and per-tenant rate tokens.
   - Add dead-letter queues for exhausted retries; publish diagnostic payloads for n8n to handle.

4. **Browser & Page Pool Manager**
   - Launch persistent Chromium contexts keyed by `profile_id` or tenant group; cache contexts with LRU eviction to limit memory.
   - For each context, pre-create `N` pages; manage state machine `IDLE → RESERVED → RUNNING → RECYCLE`. Enforce exclusive use per job.
   - Implement page sanitation: clear listeners, reset viewport/device, optionally load a blank checkpoint page; capture screenshots/HTML when job fails.
   - Monitor Chromium process; auto-restart on crash with exponential backoff and emit metric.

5. **Endpoint Module Loader**
   - Fetch module bundles from a signed registry (e.g., S3 + checksum file) that n8n references in the job payload; cache locally with version pinning.
   - Provide shared helper SDK (blocker detector, wait utilities, structured result builder) injected into each module to keep code DRY.
   - Support hot reload: watch registry for updates, swap module versions gracefully (finish running jobs first).

6. **Execution Pipeline**
   - `Job pulled → quota check (tenant/domain) → reserve profile lock/page → load module → run with timeout budget → collect result/blocker metadata → upload artifacts (HTML, screenshot) → release locks/page → acknowledge job`.
   - Enforce global + tenant-specific limits (requests/min, concurrent jobs). If quota exceeded, requeue with delay.
   - Integrate blocker detection outputs so n8n can notify clients consistently.

7. **Telemetry & Alerting**
   - Metrics: job latency percentiles, success/error counts per endpoint, page pool utilization, Chromium restarts, Redis lag.
   - Logs: JSON with `trace_id`, `tenant_id`, `job_id`, module version, proxy used; forward to centralized logging (e.g., Loki/ELK).
   - Tracing: emit OpenTelemetry spans so Cloudflare/n8n/job pipeline can be correlated end-to-end.
   - Alerts: trigger when queue lag exceeds threshold, blocker rate spikes, context restarts loop, or heartbeat missing.

8. **Security & Secrets**
   - Store API keys/proxies in a secrets manager (Vault/KMS). Workers fetch short-lived tokens on startup and refresh periodically.
   - Run containers with read-only root FS, drop Linux capabilities, isolate Chromium via unprivileged user + seccomp profile.
   - Verify module signatures and enforce per-tenant sandbox (limit modules accessible to certain tenants).

9. **Testing & Deployment**
   - Unit tests for Redis adapters, lock manager, scheduler, module loading.
   - Integration tests using mock Redis Streams + headless Chromium to simulate job lifecycle.
   - Performance/load tests to validate page pool sizing.
   - Chaos tests to simulate worker/Redis/API failures.
   - CI pipeline: lint → unit → integration → package → security scan → publish image → canary deploy (few workers) → automated rollout.

## Critical Review (Developer Meeting Notes)
- **Q:** Does relying on Redis Streams create a single bottleneck?  
  **A:** We’ll cluster Redis (primary + replicas) and shard job streams by tenant or endpoint. Consumer groups distribute load while maintaining ordering guarantees per shard.
- **Q:** How do modules avoid breaking multi-tenant isolation?  
  **A:** Modules run within a controlled sandbox (limited API surface, no direct FS/Net). They only receive `page`, sanitized payload, and helper SDK. Access to tenant secrets routed through the worker’s policy layer.
- **Q:** Can page pooling starve long-running jobs?  
  **A:** Scheduler enforces max runtime per job; overruns trigger cancel + recycle. Admissions control ensures we never reserve more jobs than pages. Autoscaler adds workers when pool utilization stays high.
- **Q:** What if n8n sends malformed/rogue jobs?  
  **A:** Worker validates payloads against JSON schema, rejects invalid jobs, and emits error events back to Redis for n8n to handle. Rate limits prevent floods.
- **Q:** How do we add endpoints without downtime?  
  **A:** Publish new module bundle + metadata to registry; n8n references new version in jobs; workers download and start executing immediately—no container restart. Canary deployments can target a subset of workers by tag.

## Next Steps
1. Author formal ADR covering Redis job schema and consumer-group strategy aligned with n8n flows.
2. Prototype worker runtime with mock Redis + simple module to validate locking/page pool pipeline.
3. Define module packaging/signing process and registry structure.
4. Draft autoscaling/observability requirements (Prometheus dashboards, alert thresholds) before coding.
5. Establish latency SLOs/capacity formulas; build synthetic load tester.
6. Document disaster-recovery runbook and schedule quarterly chaos drills.
7. Publish API/worker JSON schemas and integrate validation tests in CI.

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
1. **Contract & Schema Definition**
   - Draft Redis job schema (`job_id`, `tenant_id`, `endpoint_module`, `payload`, `profile_id`, `priority`, `retry_count`, `trace_id`).
   - Define module interface (`async handler({ page, payload, helpers, context })`), lifecycle hooks (before/after job), and error reporting expectations.
   - Document worker config spec (YAML/env) including Redis endpoints, profile storage paths, page pool size, proxy policy.

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
   - CI pipeline: lint → unit → integration → package → publish image → canary deploy (few workers) → automated rollout.

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

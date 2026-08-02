# runner-autoscaler

Webhook-driven autoscaler for self-hosted GitHub Actions runners.

Listens for `workflow_job` webhooks from the `wopr-network` org. When a job queues with matching labels and no idle runner exists, spawns a new container from the `github-runners-runner` image. Containers run as a warm pool — they pick up multiple jobs sequentially. After `IDLE_TIMEOUT_MINUTES` of no work, the reaper sends SIGTERM to gracefully deregister and remove them.

## Architecture

```
GitHub  ──workflow_job.queued──▶  cloudflared tunnel  ──▶  Hono listener
                                                                │
                                                                ├─ verify HMAC sig (GitHub App webhook_secret)
                                                                ├─ filter labels
                                                                ├─ ask Vault for current idle runner count
                                                                └─ if 0 idle  ──▶  dockerode.run(github-runners-runner)
                                                                                          │
                                                                                          ▼
                                                                                  picks up job, runs, becomes idle, picks up next job, ...
                                                                                          │
                                                            reaper (every 60s) ──▶ if idle > IDLE_TIMEOUT_MINUTES, SIGTERM container
```

State is **soft** — the listener crashes are recoverable: on boot it queries Vault + Docker and reconciles.

## Why this exists

- GARM doesn't have a Docker single-host provider
- ARC requires Kubernetes
- Pure ephemeral runners cold-start on every job (PR + merge = 4-6 cold starts), which is the common case not the edge
- Always-on runners burn idle resources (battleaxe at 3am)

So we want a *warm pool*: spin up on demand, keep warm for `IDLE_TIMEOUT_MINUTES`, kill cleanly when done.

## Capacity: count ceiling + memory floor

There is **no MIN_RUNNERS**. The pool is demand-driven (spawn on queue, reaper
on idle). Two independent spawn refusals:

| Gate | Env | Default | Meaning |
| --- | --- | --- | --- |
| Count | `MAX_RUNNERS` | **10** | Hard cap on alive managed containers |
| Memory | `RUNNER_MEMORY_FLOOR_MB` + `RUNNER_ESTIMATED_MB` | **28672** + **3482** | Refuse if MemAvailable − est would drop below floor |

**Why 10 (2026-08-02 thrash):** 25 × ~3.4GB ≈ 85GB demanded on a 62GB box
(137% of RAM) → AnonPages 57GB, MemFree 1GB, 68% iowait, load 138, sshd could
not finish auth. 10 × 3.4GB ≈ 34GB leaves ~28GB for recensus/floors/walls.
Heavy work is single-process or k=8 — never needed 25 seats.

A count limit alone is a guess (queue depth can still overfill RAM). The memory
floor is the law: same shape as the measurement load gate.

## Secrets

The autoscaler reads two things from `vault.wopr.bot` at boot via its scoped AppRole:

1. `secret/shared/cloudflare/tunnel_edit` — Cloudflare API token (only if we end up programmatically managing the tunnel; otherwise the cloudflared sidecar uses a tunnel-specific `TUNNEL_TOKEN` from a separate secret)
2. `secret/shared/github/webhook_secret` — the wopr-network GitHub App's webhook secret, used to verify incoming `workflow_job` payloads

The AppRole credentials themselves come from environment variables (`VAULT_ROLE_ID`, `VAULT_SECRET_ID`), which are loaded from the local-secrets vault file `2026-04-09-tsavo-runner-autoscaler-approle.txt` (in `vault/local-secrets/` on the user's Drive). See `reference_vault.md` in agent memory for how to retrieve them.

The autoscaler **never** stores secrets — it reads them once at boot from Vault, holds them in memory, and re-fetches if its Vault token expires.

## Layout

```
runner-autoscaler/
├── package.json
├── tsconfig.json
├── biome.json                    (uses repo root config if absent)
├── .env.example                  copy to .env, fill in VAULT_ROLE_ID + VAULT_SECRET_ID
├── Dockerfile                    multi-stage: builder → distroless runtime
├── docker-compose.yml            autoscaler + cloudflared sidecar
└── src/
    ├── index.ts                  entry: load config → vault login → start server + reaper
    ├── config.ts                 env var parsing + validation
    ├── vault.ts                  HTTP client for vault.wopr.bot, AppRole login, secret fetch
    ├── github.ts                 octokit client: list runners with busy state, filter by labels
    ├── docker.ts                 dockerode wrapper: spawn / list / kill runner containers
    ├── webhook.ts                workflow_job.queued / .completed handlers
    ├── reaper.ts                 60s poll loop, SIGTERMs idle-too-long containers
    ├── server.ts                 Hono app: signature verify middleware + routes
    └── log.ts                    pino logger
```

## Running

### Local dev (Mac, against vault.wopr.bot)

```sh
pnpm install
cp .env.example .env
# edit .env: paste VAULT_ROLE_ID + VAULT_SECRET_ID from the vault file
pnpm dev
```

The listener binds on `LISTENER_PORT` (default 3000). For dev you can expose it via `cloudflared tunnel --url http://localhost:3000` and point a GitHub webhook at it temporarily.

### Production (battleaxe)

```sh
docker compose up -d
```

The compose file starts both the autoscaler and a cloudflared sidecar that exposes it via the wopr.bot tunnel. The cloudflared `TUNNEL_TOKEN` is a separate per-tunnel secret managed via the Cloudflare dashboard, not the API token in Vault.

## Behavior in failure modes

- **Vault unreachable at boot** → fail-closed, exit non-zero. systemd / docker compose restarts will retry.
- **Vault token expires mid-flight** → re-login via AppRole, swap token in memory.
- **Docker daemon unreachable** → fail-closed for spawn requests; reaper logs and skips.
- **GitHub webhook signature invalid** → 401, log, no runner spawned.
- **Container crashes mid-job** → GitHub re-queues the job; next webhook spawns a fresh container.
- **Listener crashes** → on restart, queries `/orgs/<org>/actions/runners` to reconcile state; in-memory idle timestamps reset (worst case = an extra 10 min before idle reap).

## Operational gotchas

- The autoscaler container needs `/var/run/docker.sock` mounted to spawn siblings. On Mac Docker Desktop, that needs `group_add: ["0"]` (same fix as the runners — see `project_github_runners.md` in agent memory).
- The runner containers and the autoscaler should join the same Docker network so the autoscaler can address them by container name when killing.
- The `RUNNER_NETWORK` env var should point at the network created by the github-runners compose project (default: `github-runners_runner-network`).

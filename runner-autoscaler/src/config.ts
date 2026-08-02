// Env var parsing + validation. Fail-closed: any required var missing → throw on boot.

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface Config {
  vault: {
    addr: string;
    roleId: string;
    secretId: string;
  };
  github: {
    /** Primary org. Webhooks from this org get org-scoped runners. */
    org: string;
    /** Additional repo scopes. Webhooks from these repos get repo-scoped runners. */
    repos: RepoRef[];
    /** Vault field on shared/github holding the PAT used for repo-scoped registrations. */
    repoPatField: string;
  };
  listener: {
    port: number;
    bind: string;
  };
  pool: {
    runnerImage: string;
    runnerLabels: string[];
    /**
     * Hard count ceiling. There is no MIN_RUNNERS — warm pool is demand-driven
     * (spawn on queue, reaper on idle). 2026-08-02: 25 over-subscribed a 62GB
     * host (25×3.4GB≈85GB); default 10 leaves ~28GB for real work.
     */
    maxRunners: number;
    /**
     * Refuse to spawn when MemAvailable - RUNNER_ESTIMATED_MB would drop below
     * this floor (MiB). Count alone is a guess; memory floor is the law.
     * Default 28672 (28 GiB) — headroom for recensus / floors / walls / sshd.
     */
    memoryFloorMiB: number;
    /**
     * Conservative per-runner RSS estimate (MiB). Measured ~3.4GB AnonPages
     * class on battleaxe runner containers.
     */
    runnerEstimatedMiB: number;
    idleTimeoutMs: number;
    reaperIntervalMs: number;
    /**
     * Poll interval for the reconciliation loop that recovers from missed
     * workflow_job:queued webhooks. Set <= 0 to disable.
     */
    reconcilerIntervalMs: number;
    runnerNetwork: string;
    /**
     * Host path to a Vault-rendered GitHub writer token mounted read-only into
     * runner containers. Empty disables the mount.
     */
    runnerVaultGithubPatFile: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Env var ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

export function parseRepos(raw: string | undefined): RepoRef[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid GITHUB_REPOS entry: "${entry}" (expected "owner/repo")`);
      }
      return { owner: parts[0], repo: parts[1] };
    });
}

export function loadConfig(): Config {
  return {
    vault: {
      addr: required("VAULT_ADDR"),
      roleId: required("VAULT_ROLE_ID"),
      secretId: required("VAULT_SECRET_ID"),
    },
    github: {
      org: required("GITHUB_ORG"),
      repos: parseRepos(process.env["GITHUB_REPOS"]),
      repoPatField: optional("GITHUB_REPO_PAT_FIELD", "ops_pat"),
    },
    listener: {
      port: intEnv("LISTENER_PORT", 3000),
      bind: optional("LISTENER_BIND", "0.0.0.0"),
    },
    pool: {
      runnerImage: optional("RUNNER_IMAGE", "github-runners-runner"),
      runnerLabels: optional("RUNNER_LABELS", "self-hosted,Linux,X64")
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label.length > 0),
      // Count ceiling (no min). 10 × 3.4GB ≈ 34GB on a 62GB box → ~28GB free for work.
      maxRunners: intEnv("MAX_RUNNERS", 10),
      memoryFloorMiB: intEnv("RUNNER_MEMORY_FLOOR_MB", 28672),
      runnerEstimatedMiB: intEnv("RUNNER_ESTIMATED_MB", 3482),
      idleTimeoutMs: intEnv("IDLE_TIMEOUT_MINUTES", 10) * 60 * 1000,
      reaperIntervalMs: intEnv("REAPER_INTERVAL_SECONDS", 60) * 1000,
      reconcilerIntervalMs: intEnv("RECONCILER_INTERVAL_SECONDS", 60) * 1000,
      runnerNetwork: optional("RUNNER_NETWORK", "github-runners_runner-network"),
      runnerVaultGithubPatFile: optional("RUNNER_VAULT_GITHUB_PAT_FILE", ""),
    },
  };
}

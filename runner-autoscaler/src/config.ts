// Env var parsing + validation. Fail-closed: any required var missing → throw on boot.

export interface Config {
  vault: {
    addr: string;
    roleId: string;
    secretId: string;
  };
  github: {
    org: string;
  };
  listener: {
    port: number;
    bind: string;
  };
  pool: {
    runnerImage: string;
    runnerLabels: string[];
    maxRunners: number;
    idleTimeoutMs: number;
    reaperIntervalMs: number;
    runnerNetwork: string;
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

export function loadConfig(): Config {
  return {
    vault: {
      addr: required("VAULT_ADDR"),
      roleId: required("VAULT_ROLE_ID"),
      secretId: required("VAULT_SECRET_ID"),
    },
    github: {
      org: required("GITHUB_ORG"),
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
      maxRunners: intEnv("MAX_RUNNERS", 10),
      idleTimeoutMs: intEnv("IDLE_TIMEOUT_MINUTES", 10) * 60 * 1000,
      reaperIntervalMs: intEnv("REAPER_INTERVAL_SECONDS", 60) * 1000,
      runnerNetwork: optional("RUNNER_NETWORK", "github-runners_runner-network"),
    },
  };
}

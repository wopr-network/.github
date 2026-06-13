// Entry point.
//
// Boot order:
//   1. Load and validate config (env vars). Crash if anything required is missing.
//   2. Login to Vault via AppRole. Crash if it fails.
//   3. Fetch initial secrets: GitHub App webhook_secret + PATs per scope.
//   4. Ping Docker. Crash if unreachable.
//   5. Construct webhook context, server, and reaper.
//   6. Start the HTTP server and the reaper loop.
//   7. Install SIGTERM handler for clean shutdown.

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { DockerPool } from "./docker.js";
import { GitHubClient, type TokenProvider } from "./github.js";
import { log } from "./log.js";
import { Reaper } from "./reaper.js";
import { Reconciler } from "./reconciler.js";
import { scopeKey, type Scope } from "./scope.js";
import { buildServer } from "./server.js";
import { VaultClient } from "./vault.js";
import type { RunnerSecrets, WebhookContext } from "./webhook.js";

async function main(): Promise<void> {
  log.info("runner-autoscaler starting");

  // 1. Config
  const config = loadConfig();
  log.info(
    {
      org: config.github.org,
      repos: config.github.repos.map((r) => `${r.owner}/${r.repo}`),
      repoPatField: config.github.repoPatField,
    },
    "scopes configured",
  );

  // 2. Vault
  const vault = new VaultClient(config.vault.addr, config.vault.roleId, config.vault.secretId);
  await vault.login();

  // 3. Initial secrets — webhook_secret is needed at server build time;
  // everything else is fetched lazily per-scope.
  const githubFields = await vault.readKV("shared/github");
  const webhookSecret = githubFields["webhook_secret"];
  if (!webhookSecret) {
    throw new Error("vault secret/shared/github is missing webhook_secret");
  }

  /** Pick the right vault field for a scope. Org uses runner_registration_pat; repos use repoPatField. */
  const tokenFieldForScope = (scope: Scope): string => {
    if (scope.kind === "org") return "runner_registration_pat";
    return config.github.repoPatField;
  };

  // Lazy per-scope token provider — re-reads vault each call so rotation Just Works.
  const tokenProvider: TokenProvider = async (scope: Scope): Promise<string> => {
    const gh = await vault.readKV("shared/github");
    const field = tokenFieldForScope(scope);
    const token = gh[field];
    if (!token) {
      throw new Error(`vault secret/shared/github is missing field ${field} (for scope ${scopeKey(scope)})`);
    }
    return token;
  };

  /** Everything a runner container needs at spawn time, scoped to the job source. */
  const getRunnerSecretsForScope = async (scope: Scope): Promise<RunnerSecrets> => {
    const [gh, dh, reg] = await Promise.all([
      vault.readKV("shared/github"),
      vault.readKV("shared/dockerhub").catch((err) => {
        log.warn({ err }, "vault secret/shared/dockerhub unreadable; spawning without dockerhub auth");
        return {} as Record<string, string>;
      }),
      vault.readKV("shared/registry").catch((err) => {
        log.warn({ err }, "vault secret/shared/registry unreadable; spawning without registry auth");
        return {} as Record<string, string>;
      }),
    ]);

    const field = tokenFieldForScope(scope);
    const githubToken = gh[field];
    if (!githubToken) {
      throw new Error(`vault secret/shared/github is missing field ${field} (for scope ${scopeKey(scope)})`);
    }

    const secrets: RunnerSecrets = { githubToken };
    if (dh["username"]) secrets.dockerhubUsername = dh["username"];
    if (dh["token"]) secrets.dockerhubToken = dh["token"];
    if (reg["url"]) secrets.registryUrl = reg["url"];
    if (reg["username"]) secrets.registryUsername = reg["username"];
    if (reg["password"]) secrets.registryPassword = reg["password"];
    return secrets;
  };

  const github = new GitHubClient(tokenProvider);

  // 4. Docker
  const docker = new DockerPool(config);
  await docker.ping();
  log.info("docker ping ok");

  // 5. Wire context
  const ctx: WebhookContext = { config, github, docker, getRunnerSecretsForScope };

  // 6. Server + reaper + reconciler
  const app = buildServer({ webhookSecret, ctx });
  const reaper = new Reaper(config, docker, github);
  reaper.start();
  const reconciler = new Reconciler({ config, github, docker, getSecretsForScope: getRunnerSecretsForScope });
  reconciler.start();

  const server = serve({
    fetch: app.fetch,
    port: config.listener.port,
    hostname: config.listener.bind,
  });
  log.info({ port: config.listener.port, bind: config.listener.bind }, "listener bound");

  // 7. Graceful shutdown
  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutdown signal received");
    reaper.stop();
    reconciler.stop();
    server.close(() => {
      log.info("listener closed; bye");
      process.exit(0);
    });
    setTimeout(() => {
      log.warn("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "boot failed");
  process.exit(1);
});

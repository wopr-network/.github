// Entry point.
//
// Boot order:
//   1. Load and validate config (env vars). Crash if anything required is missing.
//   2. Login to Vault via AppRole. Crash if it fails.
//   3. Fetch initial secrets: GitHub App webhook_secret + a usable PAT for runner registration.
//   4. Ping Docker. Crash if unreachable.
//   5. Construct webhook context, server, and reaper.
//   6. Start the HTTP server and the reaper loop.
//   7. Install SIGTERM handler for clean shutdown.

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { DockerPool } from "./docker.js";
import { GitHubClient } from "./github.js";
import { log } from "./log.js";
import { Reaper } from "./reaper.js";
import { buildServer } from "./server.js";
import { VaultClient } from "./vault.js";
import type { WebhookContext } from "./webhook.js";

async function main(): Promise<void> {
  log.info("runner-autoscaler starting");

  // 1. Config
  const config = loadConfig();

  // 2. Vault
  const vault = new VaultClient(config.vault.addr, config.vault.roleId, config.vault.secretId);
  await vault.login();

  // 3. Initial secrets — webhook_secret is needed at server build time;
  // everything else is fetched lazily in getRunnerSecrets().
  const githubFields = await vault.readKV("shared/github");
  const webhookSecret = githubFields["webhook_secret"];
  if (!webhookSecret) {
    throw new Error("vault secret/shared/github is missing webhook_secret");
  }

  // Lazy getter: re-reads vault each call so secret rotation just works.
  // VaultClient handles re-login on 403 internally. The github token is
  // mandatory; the dockerhub/registry creds are optional — if vault doesn't
  // have them (e.g., during a partial migration), runners spawn without
  // them and accept the consequences (rate-limited pulls, registry-auth
  // failures for private images).
  const getRunnerSecrets = async (): Promise<import("./webhook.js").RunnerSecrets> => {
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

    const githubToken = gh["runner_registration_pat"];
    if (!githubToken) {
      throw new Error("vault secret/shared/github is missing runner_registration_pat");
    }

    const secrets: import("./webhook.js").RunnerSecrets = { githubToken };
    if (dh["username"]) secrets.dockerhubUsername = dh["username"];
    if (dh["token"]) secrets.dockerhubToken = dh["token"];
    if (reg["url"]) secrets.registryUrl = reg["url"];
    if (reg["username"]) secrets.registryUsername = reg["username"];
    if (reg["password"]) secrets.registryPassword = reg["password"];
    return secrets;
  };

  // The octokit client needs a token at construction time so it can call the runners API.
  // We use the runner_registration_pat (admin:org); fetch fresh secrets to seed it.
  const initialSecrets = await getRunnerSecrets();
  const github = new GitHubClient(config.github.org, initialSecrets.githubToken);

  // 4. Docker
  const docker = new DockerPool(config);
  await docker.ping();
  log.info("docker ping ok");

  // 5. Wire context
  const ctx: WebhookContext = { config, github, docker, getRunnerSecrets };

  // 6. Server + reaper
  const app = buildServer({ webhookSecret, ctx });
  const reaper = new Reaper(config, docker, github);
  reaper.start();

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
    server.close(() => {
      log.info("listener closed; bye");
      process.exit(0);
    });
    // Hard exit if close hangs
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

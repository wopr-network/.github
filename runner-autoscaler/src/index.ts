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

  // 3. Initial secrets
  const githubFields = await vault.readKV("shared/github");
  const webhookSecret = githubFields["webhook_secret"];
  if (!webhookSecret) {
    throw new Error("vault secret/shared/github is missing webhook_secret");
  }

  // The runner-registration PAT lives at secret/shared/github/runner_registration_pat
  // (admin:org scope, used by the spawned container's entrypoint to obtain a
  // registration token). The wopr-network GitHub *App*'s webhook_secret is for
  // verifying inbound webhooks — different field, same vault path.
  const getRunnerToken = async (): Promise<string> => {
    const fields = await vault.readKV("shared/github");
    const pat = fields["runner_registration_pat"];
    if (!pat) {
      throw new Error("vault secret/shared/github is missing runner_registration_pat");
    }
    return pat;
  };

  // The octokit client uses a token too. We initialise with the runner-registration PAT
  // so we can call the runners API. (The webhook_secret is HMAC, not bearer auth.)
  const initialGithubToken = await getRunnerToken();
  const github = new GitHubClient(config.github.org, initialGithubToken);

  // 4. Docker
  const docker = new DockerPool(config);
  await docker.ping();
  log.info("docker ping ok");

  // 5. Wire context
  const ctx: WebhookContext = { config, github, docker, getRunnerToken };

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

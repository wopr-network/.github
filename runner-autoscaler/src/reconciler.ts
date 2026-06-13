// Reconciler: catches missed workflow_job:queued webhooks.
//
// The autoscaler is webhook-only in the happy path. When the webhook
// tunnel flaps, cloudflared restarts, or GitHub returns 502 and gives up
// its retry budget, the queued job gets stranded: the run stays in
// `queued` status and the concurrency group it belongs to never
// releases. That stalls every subsequent push indefinitely.
//
// This loop is the belt-and-suspenders layer. Every
// RECONCILER_INTERVAL_SECONDS it enumerates queued jobs across every
// scope the autoscaler is responsible for, and for any job older than
// WEBHOOK_GRACE_MS with no idle matching runner, it spawns one. That
// closes the gap without changing how the happy path behaves.
//
// Capacity cap is shared with the webhook handler via docker.countManaged().

import type { Config, RepoRef } from "./config.js";
import type { DockerPool } from "./docker.js";
import type { GitHubClient, QueuedJob } from "./github.js";
import { log } from "./log.js";
import { scopeKey, type Scope } from "./scope.js";
import { poolMatchesJob, type RunnerSecrets } from "./webhook.js";

/**
 * Skip jobs younger than this. The webhook path is faster than polling;
 * a 30s grace window lets the webhook handle its own and keeps the
 * reconciler out of the common case.
 */
const WEBHOOK_GRACE_MS = 30_000;

export interface ReconcilerDeps {
  config: Config;
  github: GitHubClient;
  docker: DockerPool;
  getSecretsForScope: (scope: Scope) => Promise<RunnerSecrets>;
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: ReconcilerDeps) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.config.pool.reconcilerIntervalMs;
    if (intervalMs <= 0) {
      log.info("reconciler disabled (RECONCILER_INTERVAL_SECONDS <= 0)");
      return;
    }
    log.info({ interval_ms: intervalMs, grace_ms: WEBHOOK_GRACE_MS }, "reconciler started");
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error({ err }, "reconcile tick failed"));
    }, intervalMs);
    this.tick().catch((err) => log.error({ err }, "reconcile initial tick failed"));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    // Prevent concurrent ticks if a previous one is still walking the API.
    if (this.running) {
      log.debug("reconcile tick already running; skipping");
      return;
    }
    this.running = true;
    try {
      await this.reconcile();
    } finally {
      this.running = false;
    }
  }

  private async reconcile(): Promise<void> {
    const { config } = this.deps;

    // Build the repo list to scan. Configured repo-scopes always; the org's
    // repos are scanned too so org-scoped webhooks that missed still recover.
    const repoSet = new Map<string, RepoRef>();
    for (const r of config.github.repos) {
      repoSet.set(`${r.owner}/${r.repo}`, r);
    }
    let orgRepos: RepoRef[] = [];
    try {
      orgRepos = await this.deps.github.listOrgRepos(config.github.org);
    } catch (err) {
      log.warn({ err, org: config.github.org }, "reconcile: listOrgRepos failed; continuing with configured repos only");
    }
    for (const r of orgRepos) {
      repoSet.set(`${r.owner}/${r.repo}`, r);
    }

    for (const repo of repoSet.values()) {
      await this.reconcileRepo(repo).catch((err) => {
        log.warn({ err, repo: `${repo.owner}/${repo.repo}` }, "reconcile: per-repo scan failed");
      });
    }
  }

  private async reconcileRepo(repo: RepoRef): Promise<void> {
    const scope = this.scopeForRepo(repo);
    if (!scope) return;

    const jobs = await this.deps.github.listQueuedJobsForRepo(repo.owner, repo.repo, scope);
    if (jobs.length === 0) return;

    for (const job of jobs) {
      await this.handleQueuedJob(job, scope).catch((err) => {
        log.warn({ err, job_id: job.id, repo: `${repo.owner}/${repo.repo}` }, "reconcile: handleQueuedJob failed");
      });
    }
  }

  private async handleQueuedJob(job: QueuedJob, scope: Scope): Promise<void> {
    const { config, github, docker } = this.deps;

    const ageMs = Date.now() - new Date(job.queuedAt).getTime();
    if (ageMs < WEBHOOK_GRACE_MS) return;

    if (!poolMatchesJob(job.labels, config.pool.runnerLabels)) return;

    const idle = await github.countIdleMatching(scope, job.labels);
    if (idle > 0) return;

    const managed = await docker.countManaged();
    if (managed >= config.pool.maxRunners) {
      log.warn(
        { managed, max: config.pool.maxRunners, job_id: job.id, scope: scopeKey(scope), age_ms: ageMs },
        "reconcile: at capacity, cannot spawn for stranded job",
      );
      return;
    }

    const secrets = await this.deps.getSecretsForScope(scope);
    const containerId = await docker.spawnRunner({
      scope,
      githubToken: secrets.githubToken,
      runnerLabels: job.labels,
      ...(secrets.dockerhubUsername !== undefined && { dockerhubUsername: secrets.dockerhubUsername }),
      ...(secrets.dockerhubToken !== undefined && { dockerhubToken: secrets.dockerhubToken }),
      ...(secrets.registryUrl !== undefined && { registryUrl: secrets.registryUrl }),
      ...(secrets.registryUsername !== undefined && { registryUsername: secrets.registryUsername }),
      ...(secrets.registryPassword !== undefined && { registryPassword: secrets.registryPassword }),
    });
    log.warn(
      {
        container_id: containerId,
        job_id: job.id,
        job_name: job.name,
        run_id: job.runId,
        scope: scopeKey(scope),
        age_ms: ageMs,
      },
      "reconcile: spawned runner for stranded job (webhook missed)",
    );
  }

  /**
   * Map a repo to its scope. Configured repos are repo-scoped; everything
   * else under the primary org gets org-scoped runners. Mirrors the
   * decision `resolveScope` makes for webhooks so reconciler spawns are
   * bucketed identically.
   */
  private scopeForRepo(repo: RepoRef): Scope | null {
    const { config } = this.deps;
    const configured = config.github.repos.find((r) => r.owner === repo.owner && r.repo === repo.repo);
    if (configured) return { kind: "repo", owner: configured.owner, repo: configured.repo };
    if (repo.owner === config.github.org) return { kind: "org", org: config.github.org };
    return null;
  }
}

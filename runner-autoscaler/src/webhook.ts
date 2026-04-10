// workflow_job webhook handlers — the spawn decision point.
//
// On `queued`: check if any idle runner has the requested labels. If yes,
// do nothing (GitHub will route the job to it). If no, spawn a fresh
// container — but only if we're under MAX_RUNNERS.
//
// On `completed`: nothing to do. Containers are warm; the reaper kills
// them after IDLE_TIMEOUT_MINUTES.

import type { WorkflowJobEvent } from "@octokit/webhooks-types";
import type { Config } from "./config.js";
import type { DockerPool } from "./docker.js";
import type { GitHubClient } from "./github.js";
import { log } from "./log.js";

export interface WebhookContext {
  config: Config;
  github: GitHubClient;
  docker: DockerPool;
  /** Lazy getter for the GitHub PAT used to register the spawned runner. */
  getRunnerToken: () => Promise<string>;
}

/**
 * True iff our pool advertises every label the job requested.
 * The pool may advertise *more* labels than the job asks for; that's fine.
 *
 * Examples:
 *   pool=[self-hosted, Linux, X64], job=[self-hosted]            → true
 *   pool=[self-hosted, Linux, X64], job=[self-hosted, Linux]      → true
 *   pool=[self-hosted, Linux, X64], job=[ubuntu-latest]           → false
 *   pool=[self-hosted, Linux, X64], job=[self-hosted, gpu]        → false (we don't have gpu)
 *
 * Exported for testing.
 */
export function poolMatchesJob(jobLabels: string[], poolLabels: string[]): boolean {
  return jobLabels.every((jobLabel) => poolLabels.includes(jobLabel));
}

export async function handleWorkflowJob(
  ctx: WebhookContext,
  event: WorkflowJobEvent,
): Promise<{ action: "spawned" | "reused" | "ignored" | "skipped"; reason?: string }> {
  const { action, workflow_job } = event;

  if (action === "completed") {
    log.info(
      { job_id: workflow_job.id, conclusion: workflow_job.conclusion },
      "job completed; reaper will handle idle cleanup",
    );
    return { action: "ignored", reason: "completed events are no-ops" };
  }

  if (action !== "queued") {
    return { action: "ignored", reason: `action=${action}` };
  }

  const jobLabels = workflow_job.labels ?? [];
  if (!poolMatchesJob(jobLabels, ctx.config.pool.runnerLabels)) {
    return {
      action: "ignored",
      reason: `pool labels [${ctx.config.pool.runnerLabels.join(",")}] don't cover job labels [${jobLabels.join(",")}]`,
    };
  }

  // Check current pool capacity
  const managedCount = await ctx.docker.countManaged();
  if (managedCount >= ctx.config.pool.maxRunners) {
    log.warn(
      { managed: managedCount, max: ctx.config.pool.maxRunners, job_id: workflow_job.id },
      "pool at capacity, refusing to spawn",
    );
    return { action: "skipped", reason: "pool at MAX_RUNNERS" };
  }

  // Ask GitHub: are any of our runners idle right now?
  const idleCount = await ctx.github.countIdleMatching(jobLabels);
  if (idleCount > 0) {
    log.info({ idle: idleCount, job_id: workflow_job.id }, "idle runner available; not spawning");
    return { action: "reused" };
  }

  // No idle, under capacity, labels match — spawn.
  const githubToken = await ctx.getRunnerToken();
  const containerId = await ctx.docker.spawnRunner({
    githubToken,
    githubOrg: ctx.config.github.org,
    runnerLabels: ctx.config.pool.runnerLabels,
  });

  log.info(
    { container_id: containerId, job_id: workflow_job.id, job_labels: jobLabels },
    "spawned runner for queued job",
  );
  return { action: "spawned" };
}

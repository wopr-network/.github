// workflow_job webhook handlers — the spawn decision point.
//
// On `queued`: check if any idle runner has the requested labels in the
// same scope. If yes, do nothing (GitHub will route the job to it). If
// no, spawn a fresh container — but only if we're under MAX_RUNNERS
// (global cap across all scopes).
//
// On `completed`: nothing to do. Containers are warm; the reaper kills
// them after IDLE_TIMEOUT_MINUTES.

import type { WorkflowJobEvent } from "@octokit/webhooks-types";
import type { Config, RepoRef } from "./config.js";
import type { DockerPool } from "./docker.js";
import type { GitHubClient } from "./github.js";
import { evaluateMemoryGate, formatMiB, readHostMemory } from "./host_memory.js";
import { log } from "./log.js";
import { scopeKey, type Scope } from "./scope.js";

/**
 * Everything a spawned runner container needs in its env. The github token is
 * scope-specific (org PAT for org scopes, repo PAT for repo scopes).
 * DockerHub and registry credentials are optional — if vault doesn't have
 * them, runners spawn without them and accept the consequences.
 */
export interface RunnerSecrets {
  githubToken: string;
  dockerhubUsername?: string;
  dockerhubToken?: string;
  registryUrl?: string;
  registryUsername?: string;
  registryPassword?: string;
}

export interface WebhookContext {
  config: Config;
  github: GitHubClient;
  docker: DockerPool;
  /** Lazy getter for all secrets needed to spawn a runner in this scope. Re-fetched per call so vault rotation Just Works. */
  getRunnerSecretsForScope: (scope: Scope) => Promise<RunnerSecrets>;
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

/**
 * Decide which scope a workflow_job webhook should route to.
 * Configured repos take precedence (more specific); fall back to the
 * primary org when the event originates there. Events from sources we
 * don't know about return null and are ignored.
 *
 * Exported for testing.
 */
export function resolveScope(
  event: WorkflowJobEvent,
  primaryOrg: string,
  configuredRepos: RepoRef[],
): Scope | null {
  const fullName = event.repository?.full_name;
  if (fullName) {
    const [owner, repo] = fullName.split("/");
    if (owner && repo) {
      const match = configuredRepos.find((r) => r.owner === owner && r.repo === repo);
      if (match) {
        return { kind: "repo", owner: match.owner, repo: match.repo };
      }
    }
  }

  const orgLogin = event.organization?.login;
  if (orgLogin && orgLogin === primaryOrg) {
    return { kind: "org", org: primaryOrg };
  }

  return null;
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

  const scope = resolveScope(event, ctx.config.github.org, ctx.config.github.repos);
  if (!scope) {
    log.info(
      { repo: event.repository?.full_name, org: event.organization?.login, job_id: workflow_job.id },
      "no matching scope for event; ignoring",
    );
    return { action: "ignored", reason: "unknown scope (repo not in GITHUB_REPOS and org mismatch)" };
  }

  // Global capacity cap (across all scopes).
  const managedCount = await ctx.docker.countManaged();
  if (managedCount >= ctx.config.pool.maxRunners) {
    log.warn(
      { managed: managedCount, max: ctx.config.pool.maxRunners, job_id: workflow_job.id, scope: scopeKey(scope) },
      "pool at capacity, refusing to spawn",
    );
    return { action: "skipped", reason: "pool at MAX_RUNNERS" };
  }

  // Memory floor: count alone over-subscribed the host (25×3.4GB on 62GB).
  const memSnap = await readHostMemory();
  const memGate = evaluateMemoryGate(memSnap, {
    memoryFloorBytes: ctx.config.pool.memoryFloorMiB * 1024 * 1024,
    runnerEstimatedBytes: ctx.config.pool.runnerEstimatedMiB * 1024 * 1024,
  });
  if (!memGate.allow) {
    log.warn(
      {
        job_id: workflow_job.id,
        scope: scopeKey(scope),
        mem_available: formatMiB(memSnap.memAvailableBytes),
        mem_total: formatMiB(memSnap.memTotalBytes),
        floor_mib: ctx.config.pool.memoryFloorMiB,
        est_runner_mib: ctx.config.pool.runnerEstimatedMiB,
        reason: memGate.reason,
      },
      "crime=host-memory-floor: refusing to spawn runner",
    );
    return { action: "skipped", reason: "host memory floor" };
  }

  // Idle check is scope-specific: an idle org runner can't pick up a repo job.
  const idleCount = await ctx.github.countIdleMatching(scope, jobLabels);
  if (idleCount > 0) {
    log.info(
      { idle: idleCount, job_id: workflow_job.id, scope: scopeKey(scope) },
      "idle runner available in scope; not spawning",
    );
    return { action: "reused" };
  }

  const secrets = await ctx.getRunnerSecretsForScope(scope);
  // Only include optional fields when defined — exactOptionalPropertyTypes
  // rejects explicit `undefined` in the target parameter.
  const containerId = await ctx.docker.spawnRunner({
    scope,
    githubToken: secrets.githubToken,
    runnerLabels: jobLabels,
    ...(secrets.dockerhubUsername !== undefined && { dockerhubUsername: secrets.dockerhubUsername }),
    ...(secrets.dockerhubToken !== undefined && { dockerhubToken: secrets.dockerhubToken }),
    ...(secrets.registryUrl !== undefined && { registryUrl: secrets.registryUrl }),
    ...(secrets.registryUsername !== undefined && { registryUsername: secrets.registryUsername }),
    ...(secrets.registryPassword !== undefined && { registryPassword: secrets.registryPassword }),
  });

  log.info(
    { container_id: containerId, job_id: workflow_job.id, job_labels: jobLabels, scope: scopeKey(scope) },
    "spawned runner for queued job",
  );
  return { action: "spawned" };
}

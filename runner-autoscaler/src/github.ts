// Octokit wrapper for the GitHub Actions runners API.
// Scope-aware: org scopes use /orgs/{org}/actions/runners, repo scopes
// use /repos/{owner}/{repo}/actions/runners. Different scopes may use
// different PATs, so we cache one octokit per scope and rebuild when
// the provided token rotates.

import { Octokit } from "@octokit/rest";
import type { RepoRef } from "./config.js";
import { log } from "./log.js";
import { scopeKey, type Scope } from "./scope.js";

export interface Runner {
  id: number;
  name: string;
  os: string;
  status: "online" | "offline";
  busy: boolean;
  labels: Array<{ id?: number; name: string; type?: string }>;
}

/** Back-compat alias, the old shape was org-only so exports referenced OrgRunner. */
export type OrgRunner = Runner;

/**
 * Minimal job shape the reconciliation loop needs. Carries its repo so
 * the reconciler can scope the spawn correctly even when iterating
 * across an entire org.
 */
export interface QueuedJob {
  id: number;
  name: string;
  labels: string[];
  /** ISO timestamp of the parent run's creation; used to age-out vs WEBHOOK_GRACE_MS. */
  queuedAt: string;
  runId: number;
  repo: RepoRef;
}

export type TokenProvider = (scope: Scope) => Promise<string>;

export class GitHubClient {
  private octokits = new Map<string, Octokit>();
  private lastTokens = new Map<string, string>();

  constructor(private readonly tokenProvider: TokenProvider) {}

  private async clientFor(scope: Scope): Promise<Octokit> {
    const key = scopeKey(scope);
    const token = await this.tokenProvider(scope);
    if (this.lastTokens.get(key) !== token) {
      this.octokits.set(key, new Octokit({ auth: token }));
      this.lastTokens.set(key, token);
    }
    const client = this.octokits.get(key);
    if (!client) throw new Error(`octokit missing for ${key}`);
    return client;
  }

  async listRunners(scope: Scope): Promise<Runner[]> {
    const octokit = await this.clientFor(scope);
    const all: Runner[] = [];
    let page = 1;
    while (true) {
      const res =
        scope.kind === "org"
          ? await octokit.actions.listSelfHostedRunnersForOrg({
              org: scope.org,
              per_page: 100,
              page,
            })
          : await octokit.actions.listSelfHostedRunnersForRepo({
              owner: scope.owner,
              repo: scope.repo,
              per_page: 100,
              page,
            });
      all.push(...(res.data.runners as Runner[]));
      if (res.data.runners.length < 100) break;
      page += 1;
    }
    return all;
  }

  /** Count idle online runners in a given scope that advertise all required labels. */
  async countIdleMatching(scope: Scope, requiredLabels: string[]): Promise<number> {
    const runners = await this.listRunners(scope);
    return runners.filter(
      (r) =>
        r.status === "online" && !r.busy && requiredLabels.every((req) => r.labels.some((l) => l.name === req)),
    ).length;
  }

  /**
   * List non-archived, non-disabled repos in an org. Used by the
   * reconciler to find queued jobs that might have missed webhooks.
   * Requires the org PAT to carry read:org (admin:org covers it).
   */
  async listOrgRepos(org: string): Promise<RepoRef[]> {
    const octokit = await this.clientFor({ kind: "org", org });
    const repos: RepoRef[] = [];
    let page = 1;
    while (true) {
      const res = await octokit.repos.listForOrg({ org, type: "all", per_page: 100, page });
      for (const r of res.data) {
        if (r.archived || r.disabled) continue;
        if (!r.owner?.login || !r.name) continue;
        repos.push({ owner: r.owner.login, repo: r.name });
      }
      if (res.data.length < 100) break;
      page += 1;
    }
    return repos;
  }

  /**
   * Enumerate queued jobs for a repo. Uses whichever PAT matches the
   * provided scope so the call works for both configured repos (repo
   * PAT) and org-scoped repos (org PAT).
   *
   * Only queued runs are scanned; in-progress runs are handled by the
   * webhook path in the common case and are not worth the extra API
   * spend here.
   */
  async listQueuedJobsForRepo(owner: string, repo: string, scope: Scope): Promise<QueuedJob[]> {
    const octokit = await this.clientFor(scope);
    const runs = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
      owner,
      repo,
      status: "queued",
      per_page: 100,
    });

    const out: QueuedJob[] = [];
    for (const run of runs) {
      const jobsRes = await octokit.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: run.id,
        filter: "latest",
        per_page: 100,
      });
      for (const job of jobsRes.data.jobs) {
        if (job.status !== "queued") continue;
        out.push({
          id: job.id,
          name: job.name,
          labels: job.labels,
          queuedAt: run.created_at,
          runId: run.id,
          repo: { owner, repo },
        });
      }
    }
    return out;
  }

  async removeRunner(scope: Scope, id: number): Promise<void> {
    try {
      const octokit = await this.clientFor(scope);
      if (scope.kind === "org") {
        await octokit.actions.deleteSelfHostedRunnerFromOrg({ org: scope.org, runner_id: id });
      } else {
        await octokit.actions.deleteSelfHostedRunnerFromRepo({
          owner: scope.owner,
          repo: scope.repo,
          runner_id: id,
        });
      }
      log.info({ scope: scopeKey(scope), runner_id: id }, "removed runner");
    } catch (err) {
      log.warn({ scope: scopeKey(scope), runner_id: id, err }, "failed to remove runner (may already be gone)");
    }
  }
}

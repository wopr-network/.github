// Octokit wrapper for the GitHub Actions runners API.
// Used by the reaper to query runner busy state, and by the spawn path
// to count idle-with-matching-labels before deciding to launch.

import { Octokit } from "@octokit/rest";
import { log } from "./log.js";

export interface OrgRunner {
  id: number;
  name: string;
  os: string;
  status: "online" | "offline";
  busy: boolean;
  labels: Array<{ id?: number; name: string; type?: string }>;
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(
    private readonly org: string,
    appToken: string,
  ) {
    this.octokit = new Octokit({ auth: appToken });
  }

  async listRunners(): Promise<OrgRunner[]> {
    const all: OrgRunner[] = [];
    let page = 1;
    while (true) {
      const res = await this.octokit.actions.listSelfHostedRunnersForOrg({
        org: this.org,
        per_page: 100,
        page,
      });
      all.push(...(res.data.runners as OrgRunner[]));
      if (res.data.runners.length < 100) break;
      page += 1;
    }
    return all;
  }

  /**
   * Count idle online runners that have *all* of the requested labels.
   * Used by the spawn decision: if zero, spawn a new container.
   */
  async countIdleMatching(requiredLabels: string[]): Promise<number> {
    const runners = await this.listRunners();
    return runners.filter(
      (r) => r.status === "online" && !r.busy && requiredLabels.every((req) => r.labels.some((l) => l.name === req)),
    ).length;
  }

  /**
   * Force-remove a runner from the org via API. Used when a container is
   * killed without graceful dereg (e.g., docker kill instead of stop).
   */
  async removeRunner(id: number): Promise<void> {
    try {
      await this.octokit.actions.deleteSelfHostedRunnerFromOrg({
        org: this.org,
        runner_id: id,
      });
      log.info({ runner_id: id }, "removed runner from org");
    } catch (err) {
      log.warn({ runner_id: id, err }, "failed to remove runner from org (may already be gone)");
    }
  }
}

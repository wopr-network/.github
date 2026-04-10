// Reaper: every REAPER_INTERVAL_SECONDS, look at the pool. For each
// managed runner that has been idle (busy=false on GitHub) for longer
// than IDLE_TIMEOUT_MINUTES, send SIGTERM via docker stop. The runner's
// entrypoint trap will gracefully deregister from GitHub.
//
// State: an in-memory Map of `runner_name -> first_idle_at_ms`. On boot
// the map is empty; the reaper rebuilds it on its first tick. The
// worst-case effect of a listener restart is one extra IDLE_TIMEOUT_MINUTES
// before a stale runner gets reaped.

import type { Config } from "./config.js";
import type { DockerPool, ManagedContainer } from "./docker.js";
import type { GitHubClient, OrgRunner } from "./github.js";
import { log } from "./log.js";

export class Reaper {
  /** runner.name -> ms timestamp when we first saw it idle */
  private firstIdleAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly docker: DockerPool,
    private readonly github: GitHubClient,
  ) {}

  start(): void {
    if (this.timer) return;
    log.info(
      {
        interval_ms: this.config.pool.reaperIntervalMs,
        idle_timeout_ms: this.config.pool.idleTimeoutMs,
      },
      "reaper started",
    );
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error({ err }, "reaper tick failed"));
    }, this.config.pool.reaperIntervalMs);
    // Run one tick immediately so we don't wait the full interval at boot.
    this.tick().catch((err) => log.error({ err }, "reaper initial tick failed"));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const [containers, runners] = await Promise.all([this.docker.listManaged(), this.github.listRunners()]);

    // Index runners by name for O(1) lookup
    const runnersByName = new Map<string, OrgRunner>();
    for (const r of runners) runnersByName.set(r.name, r);

    const now = Date.now();
    const seen = new Set<string>();

    for (const container of containers) {
      // The github-runners entrypoint sets RUNNER_NAME=wopr-runner-<hostname suffix>.
      // The container name is `github-runners-runner-N` from compose, OR a random
      // hash if we created it via the API. The runner's *registered name* on GitHub
      // is keyed off the container hostname (12-char id), so we look that up via
      // the docker container's hostname rather than the docker name.
      // For simplicity here we match by GitHub runner name containing the docker id prefix.
      const idPrefix = container.id.slice(0, 12);
      const matched = this.findMatchingRunner(runnersByName, idPrefix);
      if (!matched) {
        // Container exists but hasn't registered yet (still booting).
        // Don't reap — give it time.
        seen.add(container.name);
        this.firstIdleAt.delete(container.name);
        continue;
      }
      seen.add(container.name);

      if (matched.busy) {
        // Active job → reset idle timer
        this.firstIdleAt.delete(container.name);
        continue;
      }

      // Idle. Did we record when it became idle?
      const since = this.firstIdleAt.get(container.name);
      if (since === undefined) {
        this.firstIdleAt.set(container.name, now);
        continue;
      }

      const idleFor = now - since;
      if (idleFor >= this.config.pool.idleTimeoutMs) {
        log.info({ container: container.name, runner_id: matched.id, idle_for_ms: idleFor }, "reaping idle runner");
        await this.reap(container, matched);
        this.firstIdleAt.delete(container.name);
      }
    }

    // Clean up timestamps for containers we no longer see
    for (const name of this.firstIdleAt.keys()) {
      if (!seen.has(name)) this.firstIdleAt.delete(name);
    }
  }

  private findMatchingRunner(runnersByName: Map<string, OrgRunner>, idPrefix: string): OrgRunner | undefined {
    for (const r of runnersByName.values()) {
      if (r.name.includes(idPrefix)) return r;
    }
    return undefined;
  }

  private async reap(container: ManagedContainer, runner: OrgRunner): Promise<void> {
    // Stop the container — entrypoint trap deregisters from GitHub
    await this.docker.stopGracefully(container.id);
    // Belt-and-suspenders: ensure GitHub-side cleanup if the trap didn't work
    await this.github.removeRunner(runner.id);
  }
}

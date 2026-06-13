// Reaper: every REAPER_INTERVAL_SECONDS, look at the pool. For each
// managed runner that has been idle (busy=false on GitHub) for longer
// than IDLE_TIMEOUT_MINUTES, send SIGTERM via docker stop. The runner's
// entrypoint trap will gracefully deregister from GitHub.
//
// Multi-scope: containers carry their scope in a docker label. Each tick
// groups containers by scope and queries the matching GitHub endpoint
// (org vs repo). This keeps API calls proportional to the number of
// active scopes, not the number of containers.
//
// State: an in-memory Map of `runner_name -> first_idle_at_ms`. On boot
// the map is empty; the reaper rebuilds it on its first tick. The
// worst-case effect of a listener restart is one extra IDLE_TIMEOUT_MINUTES
// before a stale runner gets reaped.

import type { Config } from "./config.js";
import type { DockerPool, ManagedContainer } from "./docker.js";
import type { GitHubClient, Runner } from "./github.js";
import { log } from "./log.js";
import { scopeKey, type Scope } from "./scope.js";

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
    // Garbage-collect dead managed containers first (failed runners with
    // RestartPolicy "no" linger as exited containers; they hold no runner slot
    // and never match a GitHub runner, so nothing else cleans them up).
    const removed = await this.docker.removeExited().catch((err) => {
      log.warn({ err }, "reaper: removeExited failed");
      return 0;
    });
    if (removed > 0) log.info({ removed }, "reaper: cleaned up dead managed containers");

    const containers = await this.docker.listManaged();

    // Group containers by scope key so we only hit GitHub once per scope.
    const byScope = new Map<string, { scope: Scope; containers: ManagedContainer[] }>();
    for (const c of containers) {
      const key = scopeKey(c.scope);
      const entry = byScope.get(key);
      if (entry) {
        entry.containers.push(c);
      } else {
        byScope.set(key, { scope: c.scope, containers: [c] });
      }
    }

    const now = Date.now();
    const seen = new Set<string>();

    for (const { scope, containers: scopeContainers } of byScope.values()) {
      let runnersByName: Map<string, Runner>;
      try {
        const runners = await this.github.listRunners(scope);
        runnersByName = new Map<string, Runner>();
        for (const r of runners) runnersByName.set(r.name, r);
      } catch (err) {
        log.error({ err, scope: scopeKey(scope) }, "reaper: listRunners failed; skipping scope this tick");
        for (const c of scopeContainers) seen.add(c.name);
        continue;
      }

      for (const container of scopeContainers) {
        seen.add(container.name);

        // GitHub runner name includes the container's 12-char id suffix
        // (hostname | tail -c 13 in entrypoint.sh).
        const idPrefix = container.id.slice(0, 12);
        const matched = this.findMatchingRunner(runnersByName, idPrefix);

        if (!matched) {
          // Container exists but hasn't registered yet (still booting). Give it time.
          this.firstIdleAt.delete(container.name);
          continue;
        }

        if (matched.busy) {
          // Active job → reset idle timer
          this.firstIdleAt.delete(container.name);
          continue;
        }

        // Idle. Record first-idle or check elapsed.
        const since = this.firstIdleAt.get(container.name);
        if (since === undefined) {
          this.firstIdleAt.set(container.name, now);
          continue;
        }

        const idleFor = now - since;
        if (idleFor >= this.config.pool.idleTimeoutMs) {
          log.info(
            { container: container.name, runner_id: matched.id, idle_for_ms: idleFor, scope: scopeKey(scope) },
            "reaping idle runner",
          );
          await this.reap(scope, container, matched);
          this.firstIdleAt.delete(container.name);
        }
      }
    }

    // Clean up timestamps for containers we no longer see
    for (const name of this.firstIdleAt.keys()) {
      if (!seen.has(name)) this.firstIdleAt.delete(name);
    }
  }

  private findMatchingRunner(runnersByName: Map<string, Runner>, idPrefix: string): Runner | undefined {
    for (const r of runnersByName.values()) {
      if (r.name.includes(idPrefix)) return r;
    }
    return undefined;
  }

  private async reap(scope: Scope, container: ManagedContainer, runner: Runner): Promise<void> {
    await this.docker.stopGracefully(container.id);
    // Belt-and-suspenders: ensure GitHub-side cleanup if the trap didn't work
    await this.github.removeRunner(scope, runner.id);
  }
}

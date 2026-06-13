// Dockerode wrapper for spawning, listing, and killing runner containers.
// All containers we manage carry an `autoscaler.managed=true` label so we
// never touch containers we didn't create (battleaxe might have other
// runners running side-by-side). Each container also carries an
// `autoscaler.scope` label encoding org:<org> or repo:<owner>/<repo>, so
// the reaper knows which GitHub API to query for a given container.

import Docker from "dockerode";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { parseScopeKey, scopeKey, type Scope } from "./scope.js";

export interface ManagedContainer {
  id: string;
  name: string;
  createdAt: number;
  scope: Scope;
  /** Docker lifecycle state: "running" | "restarting" | "created" | "exited" | "dead" | ... */
  state: string;
}

/** Container states that still occupy a runner slot. Exited/dead containers
 *  (e.g. runners that failed to register) hold no slot and must not count
 *  toward MAX_RUNNERS — otherwise failed containers wedge the pool at capacity. */
const ALIVE_STATES = new Set(["running", "restarting", "created", "paused"]);

const MANAGED_LABEL = "autoscaler.managed";
const SCOPE_LABEL = "autoscaler.scope";

export class DockerPool {
  private readonly docker: Docker;

  // `docker` is injectable for tests; production passes nothing and gets the
  // default socket path (/var/run/docker.sock, mounted into our container).
  constructor(
    private readonly config: Config,
    docker?: Docker,
  ) {
    this.docker = docker ?? new Docker();
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  async listManaged(): Promise<ManagedContainer[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=true`] },
    });
    const fallback: Scope = { kind: "org", org: this.config.github.org };
    return containers.map((c) => {
      const rawScope = c.Labels?.[SCOPE_LABEL];
      let scope: Scope;
      if (rawScope) {
        try {
          scope = parseScopeKey(rawScope);
        } catch (err) {
          log.warn({ container_id: c.Id, raw: rawScope, err }, "unparseable scope label; defaulting to primary org");
          scope = fallback;
        }
      } else {
        // Containers spawned before this change don't carry the label.
        scope = fallback;
      }
      return {
        id: c.Id,
        name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
        createdAt: c.Created * 1000,
        scope,
        state: c.State,
      };
    });
  }

  /** Count managed containers that still occupy a runner slot. Exited/dead
   *  containers are excluded — they hold no slot and would otherwise wedge the
   *  pool at MAX_RUNNERS (the reaper can't clean them: it only matches
   *  GitHub-registered runners, and a container that died before registering
   *  never appears in the GitHub runners list). */
  async countManaged(): Promise<number> {
    const list = await this.listManaged();
    return list.filter((c) => ALIVE_STATES.has(c.state)).length;
  }

  /** Remove managed containers that have exited or died. Runner containers use
   *  RestartPolicy "no" (we own the lifecycle), so a runner that fails — e.g. a
   *  registration error against a renamed repo — lingers as an exited container
   *  forever. Left unchecked they accumulate and (before countManaged ignored
   *  them) silently consumed capacity. Returns the number removed. */
  async removeExited(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=true`], status: ["exited", "dead"] },
    });
    let removed = 0;
    for (const c of containers) {
      try {
        await this.docker.getContainer(c.Id).remove({ force: true });
        removed += 1;
        log.info(
          { container_id: c.Id, name: c.Names[0]?.replace(/^\//, ""), state: c.State },
          "removed dead managed container",
        );
      } catch (err) {
        log.warn({ container_id: c.Id, err }, "failed to remove dead managed container");
      }
    }
    return removed;
  }

  /**
   * Spawn a new runner container for the given scope. Returns the container id.
   * The caller is responsible for any rate-limiting / max-pool-size enforcement.
   */
  async spawnRunner(args: {
    scope: Scope;
    githubToken: string;
    runnerLabels: string[];
    dockerhubUsername?: string;
    dockerhubToken?: string;
    registryUrl?: string;
    registryUsername?: string;
    registryPassword?: string;
  }): Promise<string> {
    const envArray: string[] = [
      `GITHUB_TOKEN=${args.githubToken}`,
      `RUNNER_LABELS=${args.runnerLabels.join(",")}`,
      "AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache",
    ];
    if (args.scope.kind === "org") {
      envArray.push(`GITHUB_ORG=${args.scope.org}`);
    } else {
      envArray.push(`GITHUB_REPO=${args.scope.owner}/${args.scope.repo}`);
    }
    if (args.dockerhubUsername) envArray.push(`DOCKERHUB_USERNAME=${args.dockerhubUsername}`);
    if (args.dockerhubToken) envArray.push(`DOCKERHUB_TOKEN=${args.dockerhubToken}`);
    if (args.registryUrl) envArray.push(`REGISTRY_URL=${args.registryUrl}`);
    if (args.registryUsername) envArray.push(`REGISTRY_USERNAME=${args.registryUsername}`);
    if (args.registryPassword) envArray.push(`REGISTRY_PASSWORD=${args.registryPassword}`);

    const needsVaultGithubPat = args.runnerLabels.includes("vault");
    const binds = ["/var/run/docker.sock:/var/run/docker.sock"];
    if (needsVaultGithubPat && this.config.pool.runnerVaultGithubPatFile) {
      binds.push(`${this.config.pool.runnerVaultGithubPatFile}:/run/vault/github-pat:ro`);
      envArray.push("CICP_GH_TOKEN_FILE=/run/vault/github-pat");
    }

    const container = await this.docker.createContainer({
      Image: this.config.pool.runnerImage,
      Env: envArray,
      Labels: {
        [MANAGED_LABEL]: "true",
        [SCOPE_LABEL]: scopeKey(args.scope),
      },
      HostConfig: {
        RestartPolicy: { Name: "no" }, // we manage lifecycle ourselves
        Binds: binds,
        NetworkMode: this.config.pool.runnerNetwork,
        CapAdd: ["SYS_TIME"],
        // Mac Docker Desktop fix: gid 0 for socket access. Harmless on Linux.
        GroupAdd: ["0"],
      },
    });
    await container.start();
    log.info(
      { container_id: container.id, image: this.config.pool.runnerImage, scope: scopeKey(args.scope) },
      "spawned runner",
    );
    return container.id;
  }

  /**
   * Send SIGTERM to a container — triggers the entrypoint's graceful dereg trap.
   * Falls back to docker kill after a timeout.
   */
  async stopGracefully(containerId: string, timeoutSeconds = 30): Promise<void> {
    const container = this.docker.getContainer(containerId);
    try {
      await container.stop({ t: timeoutSeconds });
      await container.remove({ force: true });
      log.info({ container_id: containerId }, "stopped + removed runner");
    } catch (err) {
      log.error({ container_id: containerId, err }, "failed to stop container cleanly");
      try {
        await container.remove({ force: true });
      } catch {
        // swallow
      }
    }
  }
}

// Dockerode wrapper for spawning, listing, and killing runner containers.
// All containers we manage carry an `autoscaler.managed=true` label so we
// never touch containers we didn't create (battleaxe might have other
// runners running side-by-side).

import Docker from "dockerode";
import type { Config } from "./config.js";
import { log } from "./log.js";

export interface ManagedContainer {
  id: string;
  name: string;
  createdAt: number;
}

const MANAGED_LABEL = "autoscaler.managed";

export class DockerPool {
  private readonly docker: Docker;

  constructor(private readonly config: Config) {
    // Default socket path. In Docker Desktop / Linux this is /var/run/docker.sock,
    // mounted into our container at the same path.
    this.docker = new Docker();
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  async listManaged(): Promise<ManagedContainer[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=true`] },
    });
    return containers.map((c) => ({
      id: c.Id,
      name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
      createdAt: c.Created * 1000, // dockerode gives seconds; normalise to ms
    }));
  }

  async countManaged(): Promise<number> {
    const list = await this.listManaged();
    return list.length;
  }

  /**
   * Spawn a new runner container. Returns the container id.
   * The caller is responsible for any rate-limiting / max-pool-size enforcement.
   *
   * The container uses the existing github-runners image and gets the same
   * env vars the entrypoint expects (GITHUB_TOKEN, GITHUB_ORG, RUNNER_LABELS, ...).
   */
  async spawnRunner(env: {
    githubToken: string;
    githubOrg: string;
    runnerLabels: string[];
    dockerhubUsername?: string;
    dockerhubToken?: string;
    registryUrl?: string;
    registryUsername?: string;
    registryPassword?: string;
  }): Promise<string> {
    const envArray: string[] = [
      `GITHUB_TOKEN=${env.githubToken}`,
      `GITHUB_ORG=${env.githubOrg}`,
      `RUNNER_LABELS=${env.runnerLabels.join(",")}`,
      "AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache",
    ];
    if (env.dockerhubUsername) envArray.push(`DOCKERHUB_USERNAME=${env.dockerhubUsername}`);
    if (env.dockerhubToken) envArray.push(`DOCKERHUB_TOKEN=${env.dockerhubToken}`);
    if (env.registryUrl) envArray.push(`REGISTRY_URL=${env.registryUrl}`);
    if (env.registryUsername) envArray.push(`REGISTRY_USERNAME=${env.registryUsername}`);
    if (env.registryPassword) envArray.push(`REGISTRY_PASSWORD=${env.registryPassword}`);

    const container = await this.docker.createContainer({
      Image: this.config.pool.runnerImage,
      Env: envArray,
      Labels: { [MANAGED_LABEL]: "true" },
      HostConfig: {
        RestartPolicy: { Name: "no" }, // we manage lifecycle ourselves
        Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        NetworkMode: this.config.pool.runnerNetwork,
        CapAdd: ["SYS_TIME"],
        // Mac Docker Desktop fix: gid 0 for socket access. Harmless on Linux.
        GroupAdd: ["0"],
      },
    });
    await container.start();
    log.info({ container_id: container.id, image: this.config.pool.runnerImage }, "spawned runner");
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
      // Best-effort force remove
      try {
        await container.remove({ force: true });
      } catch {
        // swallow
      }
    }
  }
}

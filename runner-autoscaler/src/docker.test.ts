// Regression tests for the capacity-accounting bug that wedged the pool.
//
// Bug (2026-06-13): runner containers use RestartPolicy "no", so a runner that
// fails to register (e.g. against a renamed repo) lingers as an *exited*
// container. countManaged() listed containers with `all: true` and returned
// list.length, so those corpses counted toward MAX_RUNNERS. Five dead
// containers wedged a 5-slot pool at capacity and every job in the org
// stranded for 26-44h. The reaper never cleaned them because it only matches
// GitHub-registered runners and a container that died before registering never
// appears in the GitHub runners list.
//
// Fixes under test:
//   - countManaged() counts only ALIVE containers (not exited/dead).
//   - removeExited() garbage-collects exited/dead managed containers.

import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { DockerPool } from "./docker.js";

function makeConfig(): Config {
  return {
    vault: { addr: "x", roleId: "x", secretId: "x" },
    github: { org: "wopr-network", repos: [], repoPatField: "ops_pat" },
    listener: { port: 3000, bind: "0.0.0.0" },
    pool: {
      runnerImage: "img",
      runnerLabels: ["self-hosted"],
      maxRunners: 5,
      memoryFloorMiB: 28672,
      runnerEstimatedMiB: 3482,
      idleTimeoutMs: 1000,
      reaperIntervalMs: 1000,
      reconcilerIntervalMs: 1000,
      runnerNetwork: "wopr-runners",
      runnerVaultGithubPatFile: "",
    },
  };
}

interface FakeContainer {
  Id: string;
  Names: string[];
  Created: number;
  Labels: Record<string, string>;
  State: string;
}

/** Minimal dockerode stand-in: honours the `status` filter the way the real
 *  daemon does, and records which container ids get removed. */
function fakeDocker(containers: FakeContainer[]) {
  const removed: string[] = [];
  const docker = {
    listContainers: async (opts: {
      all?: boolean;
      filters?: { label?: string[]; status?: string[] };
    }) => {
      const status = opts?.filters?.status;
      return status ? containers.filter((c) => status.includes(c.State)) : containers;
    },
    getContainer: (id: string) => ({
      remove: async () => {
        removed.push(id);
      },
    }),
  };
  return { docker: docker as unknown as Docker, removed };
}

const SCOPE_LABEL = "autoscaler.scope";

function container(id: string, state: string): FakeContainer {
  return {
    Id: id,
    Names: [`/runner-${id}`],
    Created: 1_700_000_000,
    Labels: { "autoscaler.managed": "true", [SCOPE_LABEL]: "org:wopr-network" },
    State: state,
  };
}

describe("DockerPool capacity accounting", () => {
  it("countManaged ignores exited/dead containers (the wedge bug)", async () => {
    const { docker } = fakeDocker([
      container("a", "running"),
      container("b", "running"),
      container("c", "exited"), // failed-to-register corpse — must NOT count
      container("d", "dead"), //   ditto
      container("e", "created"), // about to start — still occupies a slot
    ]);
    const pool = new DockerPool(makeConfig(), docker);
    // 5 managed containers exist, but only 3 occupy a runner slot.
    await expect(pool.countManaged()).resolves.toBe(3);
  });

  it("countManaged returns 0 when every managed container is a corpse", async () => {
    // This is the exact production state that stranded the org: 5 exited, 0 live.
    const { docker } = fakeDocker([
      container("a", "exited"),
      container("b", "exited"),
      container("c", "exited"),
      container("d", "exited"),
      container("e", "exited"),
    ]);
    const pool = new DockerPool(makeConfig(), docker);
    await expect(pool.countManaged()).resolves.toBe(0);
  });

  it("removeExited removes only exited/dead managed containers", async () => {
    const { docker, removed } = fakeDocker([
      container("a", "running"),
      container("b", "exited"),
      container("c", "dead"),
    ]);
    const pool = new DockerPool(makeConfig(), docker);
    await expect(pool.removeExited()).resolves.toBe(2);
    expect(removed.sort()).toEqual(["b", "c"]);
  });
});

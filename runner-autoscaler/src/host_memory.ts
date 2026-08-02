// Host memory meter for spawn decisions.
//
// 2026-08-02: MAX_RUNNERS alone over-subscribed battleaxe (25 × ~3.4GB ≈ 85GB
// on a 62GB box → thrash, load 138, sshd stuck). A count limit is a guess;
// MemAvailable under a floor is a law — same shape as the measurement load gate.
//
// Reads /proc/meminfo (Linux). Inside Docker-on-Linux this is usually the host
// or VM meminfo the engine exposes. If unreadable, refuse-open is wrong for
// safety: we treat as unknown and only apply MAX_RUNNERS (log loud).

import { readFile } from "node:fs/promises";
import { log } from "./log.js";

export interface MemorySnapshot {
  memAvailableBytes: number;
  memTotalBytes: number;
  source: "proc-meminfo" | "unmeasured";
}

export interface MemoryGateConfig {
  /** Refuse spawn if MemAvailable would fall below this after one more runner. */
  memoryFloorBytes: number;
  /** Conservative RSS estimate for one runner container (AnonPages class). */
  runnerEstimatedBytes: number;
}

export interface MemoryGateResult {
  allow: boolean;
  reason?: string;
  snapshot: MemorySnapshot;
  afterSpawnAvailableBytes: number;
}

/** Parse /proc/meminfo text. Prefers MemAvailable; falls back to MemFree. */
export function parseMeminfo(text: string): MemorySnapshot {
  const get = (key: string): number | null => {
    const re = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m");
    const m = text.match(re);
    if (!m?.[1]) return null;
    return Number.parseInt(m[1], 10) * 1024;
  };
  const total = get("MemTotal");
  const available = get("MemAvailable") ?? get("MemFree");
  if (total === null || available === null) {
    return { memAvailableBytes: -1, memTotalBytes: -1, source: "unmeasured" };
  }
  return {
    memAvailableBytes: available,
    memTotalBytes: total,
    source: "proc-meminfo",
  };
}

export async function readHostMemory(
  meminfoPath = "/proc/meminfo",
): Promise<MemorySnapshot> {
  try {
    const text = await readFile(meminfoPath, "utf8");
    return parseMeminfo(text);
  } catch (err) {
    log.warn({ err, path: meminfoPath }, "host memory unmeasured; spawn uses count ceiling only");
    return { memAvailableBytes: -1, memTotalBytes: -1, source: "unmeasured" };
  }
}

/**
 * Would adding one more runner leave MemAvailable above the floor?
 * after = available - estimated (conservative; ignores reclaimable cache nuance).
 */
export function evaluateMemoryGate(
  snapshot: MemorySnapshot,
  cfg: MemoryGateConfig,
): MemoryGateResult {
  if (snapshot.source === "unmeasured" || snapshot.memAvailableBytes < 0) {
    return {
      allow: true,
      reason: "memory unmeasured — count ceiling only",
      snapshot,
      afterSpawnAvailableBytes: -1,
    };
  }
  const after = snapshot.memAvailableBytes - cfg.runnerEstimatedBytes;
  if (after < cfg.memoryFloorBytes) {
    return {
      allow: false,
      reason:
        `MemAvailable ${formatMiB(snapshot.memAvailableBytes)} - est_runner ${formatMiB(cfg.runnerEstimatedBytes)} ` +
        `= ${formatMiB(after)} < floor ${formatMiB(cfg.memoryFloorBytes)}`,
      snapshot,
      afterSpawnAvailableBytes: after,
    };
  }
  return {
    allow: true,
    snapshot,
    afterSpawnAvailableBytes: after,
  };
}

export function formatMiB(bytes: number): string {
  if (bytes < 0) return "unknown";
  return `${Math.round(bytes / (1024 * 1024))}MiB`;
}

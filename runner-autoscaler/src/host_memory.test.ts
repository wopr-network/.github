import { describe, expect, it } from "vitest";
import { evaluateMemoryGate, parseMeminfo } from "./host_memory.js";

const sample = `
MemTotal:       65011712 kB
MemFree:         1048576 kB
MemAvailable:    8388608 kB
Buffers:          524288 kB
Cached:          2097152 kB
`;

describe("parseMeminfo", () => {
  it("reads MemAvailable and MemTotal", () => {
    const s = parseMeminfo(sample);
    expect(s.source).toBe("proc-meminfo");
    expect(s.memTotalBytes).toBe(65011712 * 1024);
    expect(s.memAvailableBytes).toBe(8388608 * 1024);
  });
});

describe("evaluateMemoryGate", () => {
  const cfg = {
    // 28 GiB floor — headroom for recensus/floors/walls
    memoryFloorBytes: 28 * 1024 * 1024 * 1024,
    // ~3.4 GiB per runner
    runnerEstimatedBytes: Math.round(3.4 * 1024 * 1024 * 1024),
  };

  it("refuses when one more runner would breach the floor", () => {
    // 8 GiB available, 3.4 GiB runner → 4.6 GiB left << 28 GiB floor
    const snap = parseMeminfo(sample);
    const r = evaluateMemoryGate(snap, cfg);
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/floor/);
  });

  it("allows when plenty free", () => {
    const plenty = parseMeminfo(`
MemTotal:       65011712 kB
MemAvailable:   40000000 kB
`);
    const r = evaluateMemoryGate(plenty, cfg);
    expect(r.allow).toBe(true);
  });

  it("allows (count-only) when unmeasured", () => {
    const r = evaluateMemoryGate(
      { memAvailableBytes: -1, memTotalBytes: -1, source: "unmeasured" },
      cfg,
    );
    expect(r.allow).toBe(true);
    expect(r.reason).toMatch(/unmeasured/);
  });
});

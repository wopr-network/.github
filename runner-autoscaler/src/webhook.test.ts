import { describe, expect, it } from "vitest";
import { poolMatchesJob } from "./webhook.js";

describe("poolMatchesJob", () => {
  const pool = ["self-hosted", "Linux", "X64"];

  it("matches when job requests a subset of pool labels", () => {
    expect(poolMatchesJob(["self-hosted"], pool)).toBe(true);
    expect(poolMatchesJob(["self-hosted", "Linux"], pool)).toBe(true);
    expect(poolMatchesJob(["self-hosted", "Linux", "X64"], pool)).toBe(true);
  });

  it("rejects when job requests a label the pool doesn't have", () => {
    expect(poolMatchesJob(["ubuntu-latest"], pool)).toBe(false);
    expect(poolMatchesJob(["self-hosted", "gpu"], pool)).toBe(false);
    expect(poolMatchesJob(["macos-14"], pool)).toBe(false);
  });

  it("matches an empty job label set vacuously (every of empty == true)", () => {
    // GitHub shouldn't send this, but the function should handle it without throwing.
    expect(poolMatchesJob([], pool)).toBe(true);
  });

  it("is case-sensitive (matches GitHub's behavior)", () => {
    // GitHub treats labels as case-sensitive in routing.
    expect(poolMatchesJob(["self-hosted"], pool)).toBe(true);
    expect(poolMatchesJob(["Self-Hosted"], pool)).toBe(false);
    expect(poolMatchesJob(["linux"], pool)).toBe(false);
  });

  it("returns false when the pool is empty and the job wants any label", () => {
    expect(poolMatchesJob(["self-hosted"], [])).toBe(false);
  });

  it("returns true when both pool and job are empty", () => {
    expect(poolMatchesJob([], [])).toBe(true);
  });
});

import type { WorkflowJobEvent } from "@octokit/webhooks-types";
import { describe, expect, it } from "vitest";
import type { RepoRef } from "./config.js";
import { scopeKey } from "./scope.js";
import { poolMatchesJob, resolveScope } from "./webhook.js";

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

/**
 * Narrow helper to build a workflow_job.queued payload with only the fields
 * resolveScope inspects. Casting to WorkflowJobEvent keeps the typechecker
 * honest without forcing us to construct every field in the real type.
 */
function makeEvent(args: { repoFullName?: string; orgLogin?: string }): WorkflowJobEvent {
  const event: Record<string, unknown> = { action: "queued", workflow_job: { labels: [] } };
  if (args.repoFullName) {
    event["repository"] = { full_name: args.repoFullName };
  }
  if (args.orgLogin) {
    event["organization"] = { login: args.orgLogin };
  }
  return event as unknown as WorkflowJobEvent;
}

describe("resolveScope", () => {
  const primaryOrg = "wopr-network";
  const configuredRepos: RepoRef[] = [
    { owner: "TSavo", repo: "nefariousplan" },
    { owner: "TSavo", repo: "otherrepo" },
  ];

  it("returns org scope when the event is from the primary org and no configured repo matches", () => {
    const event = makeEvent({ repoFullName: "wopr-network/platform", orgLogin: primaryOrg });
    const scope = resolveScope(event, primaryOrg, configuredRepos);
    expect(scope).toEqual({ kind: "org", org: primaryOrg });
  });

  it("returns repo scope when the event's repo is in configuredRepos", () => {
    const event = makeEvent({ repoFullName: "TSavo/nefariousplan" });
    const scope = resolveScope(event, primaryOrg, configuredRepos);
    expect(scope).toEqual({ kind: "repo", owner: "TSavo", repo: "nefariousplan" });
  });

  it("prefers repo scope over org scope when both would match (configured repo wins)", () => {
    // Edge case: a repo could technically exist in both the org and the configured repo list.
    // Configured-repo match is more specific so it wins.
    const event = makeEvent({ repoFullName: "TSavo/nefariousplan", orgLogin: primaryOrg });
    const scope = resolveScope(event, primaryOrg, configuredRepos);
    expect(scope?.kind).toBe("repo");
  });

  it("returns null when the event is from an unknown org and unknown repo", () => {
    const event = makeEvent({ repoFullName: "someone-else/whatever", orgLogin: "other-org" });
    expect(resolveScope(event, primaryOrg, configuredRepos)).toBeNull();
  });

  it("returns null when the event has no repository or organization at all", () => {
    const event = makeEvent({});
    expect(resolveScope(event, primaryOrg, configuredRepos)).toBeNull();
  });

  it("is case-sensitive on owner/repo matching (matches GitHub's canonical casing)", () => {
    // GitHub's full_name uses the repo's canonical casing. If configured with "TSavo" but
    // event says "tsavo", we treat them as different — caller should normalize if needed.
    const event = makeEvent({ repoFullName: "tsavo/nefariousplan" });
    expect(resolveScope(event, primaryOrg, configuredRepos)).toBeNull();
  });
});

describe("scopeKey", () => {
  it("formats org scope", () => {
    expect(scopeKey({ kind: "org", org: "wopr-network" })).toBe("org:wopr-network");
  });
  it("formats repo scope", () => {
    expect(scopeKey({ kind: "repo", owner: "TSavo", repo: "nefariousplan" })).toBe("repo:TSavo/nefariousplan");
  });
});

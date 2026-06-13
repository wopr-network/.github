// A runner scope is either the primary org or a specific owner/repo.
// Different scopes may use different PATs; GitHub API endpoints and
// webhook routing branch on this discriminator.

export type Scope =
  | { kind: "org"; org: string }
  | { kind: "repo"; owner: string; repo: string };

export function scopeKey(s: Scope): string {
  return s.kind === "org" ? `org:${s.org}` : `repo:${s.owner}/${s.repo}`;
}

export function parseScopeKey(raw: string): Scope {
  if (raw.startsWith("org:")) {
    const org = raw.slice(4);
    if (!org) throw new Error(`Invalid scope key: ${raw}`);
    return { kind: "org", org };
  }
  if (raw.startsWith("repo:")) {
    const full = raw.slice(5);
    const [owner, repo] = full.split("/");
    if (!owner || !repo) throw new Error(`Invalid scope key: ${raw}`);
    return { kind: "repo", owner, repo };
  }
  throw new Error(`Invalid scope key: ${raw}`);
}

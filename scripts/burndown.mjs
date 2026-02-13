#!/usr/bin/env node
/**
 * Queries Linear for WOPR issues and generates a Mermaid xychart burn-up
 * chart broken out by repo, written into profile/README.md.
 *
 * Two lines: total scope (created) and completed (done).
 * The gap between them = remaining work.
 *
 * Requires: LINEAR_API_KEY env var
 * Usage: node scripts/burndown.mjs
 */

const LINEAR_API = "https://api.linear.app/graphql";
const TEAM_ID = "dca92d56-659a-4ee9-a8d1-69d1f0de19e0";
const API_KEY = process.env.LINEAR_API_KEY;

if (!API_KEY) {
  console.error("LINEAR_API_KEY not set");
  process.exit(1);
}

// Grouping rules: label name patterns → display name
const GROUPING_RULES = [
  { pattern: /^plugin-provider-/, display: "providers" },
  { pattern: /^plugin-voice-|^voice$/, display: "voice" },
  { pattern: /^plugin-tailscale|^plugin-p2p/, display: "infra" },
  { pattern: /^wopr-platform$|^plugin-platform$|^platform$/, display: "platform" },
  { pattern: /^wopr-core$/, display: "wopr" },
  { pattern: /^tech-debt$|^refactor$/, display: "refactor" },
  { pattern: /^plugin-/, display: null }, // strip "plugin-" prefix
];

function labelToDisplayName(labelName) {
  for (const rule of GROUPING_RULES) {
    if (rule.pattern.test(labelName)) {
      if (rule.display) return rule.display;
      return labelName.replace(/^plugin-/, "");
    }
  }
  return labelName;
}

let REPO_LABELS = {};
let DISPLAY_NAMES = [];

async function linearQuery(query, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchLabels() {
  const data = await linearQuery(
    `query($teamId: String!) {
      team(id: $teamId) {
        labels { nodes { name } }
      }
    }`,
    { teamId: TEAM_ID },
  );

  const wsData = await linearQuery(
    `{ issueLabels(filter: { team: { null: true } }, first: 250) { nodes { name } } }`,
  );

  const allLabels = [
    ...data.team.labels.nodes.map((l) => l.name),
    ...wsData.issueLabels.nodes.map((l) => l.name),
  ];

  const skipLabels = new Set(["Bug", "Improvement", "Feature"]);

  REPO_LABELS = {};
  for (const name of allLabels) {
    if (skipLabels.has(name)) continue;
    REPO_LABELS[name] = labelToDisplayName(name);
  }

  DISPLAY_NAMES = [...new Set(Object.values(REPO_LABELS))];
  console.log(`Loaded ${Object.keys(REPO_LABELS).length} labels \u2192 ${DISPLAY_NAMES.length} groups`);
}

async function fetchAllIssues() {
  const issues = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const data = await linearQuery(
      `query($teamId: ID!, $cursor: String) {
        issues(
          filter: { team: { id: { eq: $teamId } } }
          first: 250
          after: $cursor
        ) {
          nodes {
            id
            identifier
            createdAt
            completedAt
            state { type }
            labels { nodes { name } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { teamId: TEAM_ID, cursor },
    );

    issues.push(...data.issues.nodes);
    hasMore = data.issues.pageInfo.hasNextPage;
    cursor = data.issues.pageInfo.endCursor;
  }

  return issues;
}

function getHourLabel(isoStr) {
  const d = new Date(isoStr);
  const month = d.toLocaleString("en", { month: "short" });
  const day = d.getDate();
  const hour = d.getHours().toString().padStart(2, "0");
  return `${month} ${day} ${hour}:00`;
}

function buildHourlySlots(earliest) {
  const now = new Date();
  const start = new Date(earliest);
  start.setMinutes(0, 0, 0);

  const slots = [];
  const current = new Date(start);
  while (current <= now) {
    slots.push(current.toISOString());
    current.setHours(current.getHours() + 1);
  }

  // Sample to max ~48 labels for readability
  if (slots.length > 48) {
    const step = Math.ceil(slots.length / 48);
    const sampled = [];
    for (let i = 0; i < slots.length; i += step) {
      sampled.push(slots[i]);
    }
    if (sampled[sampled.length - 1] !== slots[slots.length - 1]) {
      sampled.push(slots[slots.length - 1]);
    }
    return sampled;
  }
  return slots;
}

function categorizeIssues(issues) {
  const grouped = {};
  for (const name of DISPLAY_NAMES) grouped[name] = [];
  grouped["other"] = [];

  for (const issue of issues) {
    const labels = issue.labels.nodes.map((l) => l.name);
    let matched = false;
    for (const [label, displayName] of Object.entries(REPO_LABELS)) {
      if (labels.includes(label)) {
        grouped[displayName].push(issue);
        matched = true;
        break;
      }
    }
    if (!matched) grouped["other"].push(issue);
  }

  return grouped;
}

function isDone(issue, asOf) {
  if (issue.completedAt) {
    return new Date(issue.completedAt) <= asOf;
  }
  // State is completed/cancelled but no completedAt — treat as done now
  return issue.state.type === "completed" || issue.state.type === "cancelled";
}

function buildBurnupData(issues) {
  // Find earliest createdAt
  let earliest = new Date();
  for (const issue of issues) {
    const d = new Date(issue.createdAt);
    if (d < earliest) earliest = d;
  }

  const slots = buildHourlySlots(earliest);
  const slotLabels = slots.map((s) => getHourLabel(s));

  // Overall burn-up: scope line + done line
  const scopeLine = slots.map((slotIso) => {
    const slotEnd = new Date(slotIso);
    slotEnd.setHours(slotEnd.getHours() + 1);
    let count = 0;
    for (const issue of issues) {
      if (new Date(issue.createdAt) <= slotEnd) count++;
    }
    return count;
  });

  const doneLine = slots.map((slotIso) => {
    const slotEnd = new Date(slotIso);
    slotEnd.setHours(slotEnd.getHours() + 1);
    let count = 0;
    for (const issue of issues) {
      if (new Date(issue.createdAt) > slotEnd) continue;
      if (isDone(issue, slotEnd)) count++;
    }
    return count;
  });

  // Per-repo breakdown (done counts only, for the table)
  const grouped = categorizeIssues(issues);
  const repoStats = {};

  for (const [displayName, repoIssues] of Object.entries(grouped)) {
    if (repoIssues.length === 0) continue;

    const total = repoIssues.length;
    const done = repoIssues.filter(
      (i) => i.state.type === "completed" || i.state.type === "cancelled",
    ).length;
    const open = total - done;

    repoStats[displayName] = { total, done, open };
  }

  return { slotLabels, scopeLine, doneLine, repoStats };
}

function buildSummaryStats(issues) {
  const total = issues.length;
  let done = 0;
  let inProgress = 0;
  let backlog = 0;

  for (const issue of issues) {
    const type = issue.state.type;
    if (type === "completed" || type === "cancelled") done++;
    else if (type === "started") inProgress++;
    else backlog++;
  }

  return { total, done, inProgress, backlog };
}

function generateMermaid(slotLabels, scopeLine, doneLine) {
  const lines = [];
  lines.push("```mermaid");
  lines.push("xychart-beta");
  lines.push('  title "WOPR Burn-Up \u2014 Scope vs Completed (hourly)"');
  lines.push(`  x-axis [${slotLabels.map((w) => `"${w}"`).join(", ")}]`);

  const max = Math.max(...scopeLine, ...doneLine);
  lines.push(`  y-axis "Issues" 0 --> ${Math.ceil(max * 1.1)}`);

  lines.push(`  line [${scopeLine.join(", ")}]`);
  lines.push(`  line [${doneLine.join(", ")}]`);

  lines.push("```");
  return lines.join("\n");
}

function generateTable(repoStats) {
  const sorted = Object.entries(repoStats).sort((a, b) => b[1].open - a[1].open);
  const lines = [];
  lines.push("| Repo | Total | Done | Open | Progress |");
  lines.push("|------|-------|------|------|----------|");

  let totalAll = 0;
  let doneAll = 0;
  let openAll = 0;

  for (const [name, { total, done, open }] of sorted) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const filled = Math.round(pct / 10);
    const bar = "\u2593".repeat(filled) + "\u2591".repeat(10 - filled);
    lines.push(`| ${name} | ${total} | ${done} | ${open} | ${bar} ${pct}% |`);
    totalAll += total;
    doneAll += done;
    openAll += open;
  }

  const pctAll = totalAll > 0 ? Math.round((doneAll / totalAll) * 100) : 0;
  lines.push(`| **Total** | **${totalAll}** | **${doneAll}** | **${openAll}** | **${pctAll}%** |`);
  return lines.join("\n");
}

async function main() {
  console.log("Fetching labels from Linear...");
  await fetchLabels();

  console.log("Fetching issues from Linear...");
  const issues = await fetchAllIssues();
  console.log(`Fetched ${issues.length} issues`);

  const { slotLabels, scopeLine, doneLine, repoStats } = buildBurnupData(issues);
  const stats = buildSummaryStats(issues);
  const mermaid = generateMermaid(slotLabels, scopeLine, doneLine);
  const table = generateTable(repoStats);
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const readme = `# WOPR Network

**AI-native multi-channel bot platform** \u2014 Discord, Slack, Telegram, WhatsApp, Signal, IRC, and more.

## Burn-Up Chart

${mermaid}

> **Upper line** = total scope (issues created) | **Lower line** = completed | **Gap** = remaining work

### Progress by Repo

${table}

### Summary

| Metric | Count |
|--------|-------|
| Total Issues | ${stats.total} |
| Completed | ${stats.done} |
| In Progress | ${stats.inProgress} |
| Backlog | ${stats.backlog} |
| Completion | ${Math.round((stats.done / stats.total) * 100)}% |

---

*Updated automatically every 6 hours from [Linear](https://linear.app/wopr) \u2014 last run: ${now} UTC*
`;

  const { writeFileSync } = await import("node:fs");
  writeFileSync("profile/README.md", readme);
  console.log("Wrote profile/README.md");
  console.log(
    `Stats: ${stats.total} total, ${stats.done} done, ${stats.inProgress} in progress, ${stats.backlog} backlog`,
  );
  console.log(`Chart: ${slotLabels.length} time slots, scope peak: ${Math.max(...scopeLine)}, done peak: ${Math.max(...doneLine)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Queries Linear for WOPR issues and generates a Mermaid xychart burndown
 * broken out by repo, written into profile/README.md.
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
// Labels fetched from Linear API are matched against these patterns
const GROUPING_RULES = [
  { pattern: /^plugin-provider-/, display: "providers" },
  { pattern: /^plugin-voice-|^voice$/, display: "voice" },
  { pattern: /^plugin-tailscale|^plugin-p2p/, display: "infra" },
  { pattern: /^wopr-platform$|^plugin-platform$|^platform$/, display: "platform" },
  { pattern: /^wopr-core$/, display: "wopr" },
  { pattern: /^tech-debt$|^refactor$/, display: "refactor" },
  { pattern: /^plugin-/, display: null }, // strip "plugin-" prefix, use rest as display name
];

function labelToDisplayName(labelName) {
  for (const rule of GROUPING_RULES) {
    if (rule.pattern.test(labelName)) {
      if (rule.display) return rule.display;
      // null display means strip prefix
      return labelName.replace(/^plugin-/, "");
    }
  }
  return labelName; // use as-is
}

// Built dynamically from Linear API
let REPO_LABELS = {};
let DISPLAY_NAMES = [];

async function fetchLabels() {
  const data = await linearQuery(
    `query($teamId: String!) {
      team(id: $teamId) {
        labels { nodes { name } }
      }
    }`,
    { teamId: TEAM_ID },
  );

  // Also get workspace labels
  const wsData = await linearQuery(
    `{ issueLabels(filter: { team: { null: true } }, first: 250) { nodes { name } } }`,
  );

  const allLabels = [
    ...data.team.labels.nodes.map((l) => l.name),
    ...wsData.issueLabels.nodes.map((l) => l.name),
  ];

  // Skip generic labels that aren't repo-related
  const skipLabels = new Set(["Bug", "Improvement", "Feature"]);

  REPO_LABELS = {};
  for (const name of allLabels) {
    if (skipLabels.has(name)) continue;
    REPO_LABELS[name] = labelToDisplayName(name);
  }

  DISPLAY_NAMES = [...new Set(Object.values(REPO_LABELS))];
  console.log(`Loaded ${Object.keys(REPO_LABELS).length} labels → ${DISPLAY_NAMES.length} groups`);
}

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

function buildHourlySlots() {
  const now = new Date();
  // Find the earliest issue createdAt to set the start
  // We'll determine this after fetching, so return a function
  return (earliest) => {
    const start = new Date(earliest);
    start.setMinutes(0, 0, 0); // round down to hour

    const slots = [];
    const current = new Date(start);
    while (current <= now) {
      slots.push(current.toISOString());
      current.setHours(current.getHours() + 1);
    }

    // If too many slots, sample every N hours to keep chart readable (max ~48 labels)
    if (slots.length > 48) {
      const step = Math.ceil(slots.length / 48);
      const sampled = [];
      for (let i = 0; i < slots.length; i += step) {
        sampled.push(slots[i]);
      }
      // Always include the last slot
      if (sampled[sampled.length - 1] !== slots[slots.length - 1]) {
        sampled.push(slots[slots.length - 1]);
      }
      return sampled;
    }
    return slots;
  };
}

function categorizeIssues(issues) {
  // Group by display name
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

function buildHourlyData(issues) {
  // Find earliest createdAt
  let earliest = new Date();
  for (const issue of issues) {
    const d = new Date(issue.createdAt);
    if (d < earliest) earliest = d;
  }

  const slotBuilder = buildHourlySlots();
  const slots = slotBuilder(earliest);

  const grouped = categorizeIssues(issues);

  const slotLabels = slots.map((s) => getHourLabel(s));
  const series = {};

  for (const [displayName, repoIssues] of Object.entries(grouped)) {
    if (repoIssues.length === 0) continue;

    series[displayName] = slots.map((slotIso) => {
      const slotEnd = new Date(slotIso);
      slotEnd.setHours(slotEnd.getHours() + 1);

      let open = 0;
      for (const issue of repoIssues) {
        const created = new Date(issue.createdAt);
        if (created > slotEnd) continue; // not yet created
        if (issue.completedAt) {
          const completed = new Date(issue.completedAt);
          if (completed <= slotEnd) continue; // already done by this slot
        } else if (
          issue.state.type === "completed" ||
          issue.state.type === "cancelled"
        ) {
          // completedAt might be null for cancelled — treat as done now
          continue;
        }
        open++;
      }
      return open;
    });
  }

  return { slotLabels, series };
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

function generateMermaid(slotLabels, series) {
  const lines = [];
  lines.push("```mermaid");
  lines.push("xychart-beta");
  lines.push('  title "WOPR Burndown — Open Issues by Repo (hourly)"');
  lines.push(`  x-axis [${slotLabels.map((w) => `"${w}"`).join(", ")}]`);

  // Find max for y-axis
  let max = 0;
  for (const vals of Object.values(series)) {
    for (const v of vals) max = Math.max(max, v);
  }
  lines.push(`  y-axis "Open Issues" 0 --> ${Math.ceil(max * 1.1)}`);

  for (const vals of Object.values(series)) {
    lines.push(`  line [${vals.join(", ")}]`);
  }

  lines.push("```");
  return lines.join("\n");
}

function generateTable(series) {
  // Current (last column) breakdown
  const current = {};
  let total = 0;
  for (const [name, vals] of Object.entries(series)) {
    const v = vals[vals.length - 1];
    if (v > 0) {
      current[name] = v;
      total += v;
    }
  }

  const sorted = Object.entries(current).sort((a, b) => b[1] - a[1]);
  const lines = [];
  lines.push("| Repo | Open Issues |");
  lines.push("|------|------------|");
  for (const [name, count] of sorted) {
    const bar = "\u2588".repeat(Math.ceil(count / 2)) || "\u258F";
    lines.push(`| ${name} | ${bar} ${count} |`);
  }
  lines.push(`| **Total** | **${total}** |`);
  return lines.join("\n");
}

function generateLegend(series) {
  const names = Object.keys(series);
  return `> Lines (top\u2192bottom): ${names.join(", ")}`;
}

async function main() {
  console.log("Fetching labels from Linear...");
  await fetchLabels();

  console.log("Fetching issues from Linear...");
  const issues = await fetchAllIssues();
  console.log(`Fetched ${issues.length} issues`);

  const { slotLabels, series } = buildHourlyData(issues);
  const stats = buildSummaryStats(issues);
  const mermaid = generateMermaid(slotLabels, series);
  const table = generateTable(series);
  const legend = generateLegend(series);
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const readme = `# WOPR Network

**AI-native multi-channel bot platform** \u2014 Discord, Slack, Telegram, WhatsApp, Signal, IRC, and more.

## Project Burndown

${mermaid}

${legend}

### Current Open Issues by Repo

${table}

### Summary

| Metric | Count |
|--------|-------|
| Total Issues | ${stats.total} |
| Done | ${stats.done} |
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
  console.log(`Chart: ${slotLabels.length} time slots, ${Object.keys(series).length} series`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

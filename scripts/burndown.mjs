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

// Label → display name mapping (only repos we care about)
const REPO_LABELS = {
  "wopr-core": "wopr",
  "plugin-discord": "discord",
  "plugin-slack": "slack",
  "plugin-telegram": "telegram",
  "plugin-whatsapp": "whatsapp",
  "plugin-signal": "signal",
  "plugin-msteams": "msteams",
  "plugin-memory-semantic": "memory",
  "wopr-platform": "platform",
  "plugin-webui": "webui",
  "plugin-github": "github",
};

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
      `query($teamId: String!, $cursor: String) {
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
      { teamId: TEAM_ID, cursor }
    );

    issues.push(...data.issues.nodes);
    hasMore = data.issues.pageInfo.hasNextPage;
    cursor = data.issues.pageInfo.endCursor;
  }

  return issues;
}

function getWeekLabel(date) {
  const d = new Date(date);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d - jan1) / 86400000);
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  const month = d.toLocaleString("en", { month: "short" });
  const day = d.getDate();
  return `${month} ${day}`;
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - day); // Sunday
  return d.toISOString().slice(0, 10);
}

function buildWeeklyData(issues) {
  // Get date range — last 8 weeks
  const now = new Date();
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const ws = getWeekStart(d);
    weeks.push(ws);
  }

  // Categorize issues by repo label
  const repoIssues = {};
  for (const label of Object.keys(REPO_LABELS)) {
    repoIssues[label] = [];
  }
  repoIssues["other"] = [];

  for (const issue of issues) {
    const labels = issue.labels.nodes.map((l) => l.name);
    let matched = false;
    for (const label of Object.keys(REPO_LABELS)) {
      if (labels.includes(label)) {
        repoIssues[label].push(issue);
        matched = true;
        break;
      }
    }
    if (!matched) repoIssues["other"].push(issue);
  }

  // For each week, count remaining open issues per repo
  const weekLabels = weeks.map((w) => getWeekLabel(w));
  const series = {};

  for (const [label, displayName] of [
    ...Object.entries(REPO_LABELS),
    ["other", "other"],
  ]) {
    const repoList = repoIssues[label];
    if (repoList.length === 0) continue;

    series[displayName] = weeks.map((weekEnd) => {
      const endDate = new Date(weekEnd);
      endDate.setDate(endDate.getDate() + 7); // end of week

      let open = 0;
      for (const issue of repoList) {
        const created = new Date(issue.createdAt);
        if (created > endDate) continue; // not yet created
        if (issue.completedAt) {
          const completed = new Date(issue.completedAt);
          if (completed <= endDate) continue; // already done
        }
        // cancelled/archived count as done
        if (
          issue.state.type === "cancelled" ||
          issue.state.type === "completed"
        ) {
          if (issue.completedAt && new Date(issue.completedAt) <= endDate)
            continue;
        }
        open++;
      }
      return open;
    });
  }

  return { weekLabels, series };
}

function buildSummaryStats(issues) {
  let total = issues.length;
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

function generateMermaid(weekLabels, series) {
  const lines = [];
  lines.push("```mermaid");
  lines.push("xychart-beta");
  lines.push('  title "WOPR Burndown — Open Issues by Repo"');
  lines.push(`  x-axis [${weekLabels.map((w) => `"${w}"`).join(", ")}]`);

  // Find max for y-axis
  let max = 0;
  for (const vals of Object.values(series)) {
    for (const v of vals) max = Math.max(max, v);
  }
  lines.push(`  y-axis "Open Issues" 0 --> ${Math.ceil(max * 1.1)}`);

  for (const [name, vals] of Object.entries(series)) {
    lines.push(`  line [${vals.join(", ")}]`);
  }

  lines.push("```");
  return lines.join("\n");
}

function generateTable(series, weekLabels) {
  // Current week (last column) breakdown
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
    const bar = "█".repeat(Math.ceil(count / 2)) || "▏";
    lines.push(`| ${name} | ${bar} ${count} |`);
  }
  lines.push(`| **Total** | **${total}** |`);
  return lines.join("\n");
}

function generateLegend(series) {
  const names = Object.keys(series);
  return `> Lines (top→bottom): ${names.join(", ")}`;
}

async function main() {
  console.log("Fetching issues from Linear...");
  const issues = await fetchAllIssues();
  console.log(`Fetched ${issues.length} issues`);

  const { weekLabels, series } = buildWeeklyData(issues);
  const stats = buildSummaryStats(issues);
  const mermaid = generateMermaid(weekLabels, series);
  const table = generateTable(series, weekLabels);
  const legend = generateLegend(series);
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const readme = `# WOPR Network

**AI-native multi-channel bot platform** — Discord, Slack, Telegram, WhatsApp, Signal, IRC, and more.

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

*Updated automatically every 6 hours from [Linear](https://linear.app/wopr) — last run: ${now} UTC*
`;

  const { writeFileSync } = await import("node:fs");
  writeFileSync("profile/README.md", readme);
  console.log("Wrote profile/README.md");
  console.log(`Stats: ${stats.total} total, ${stats.done} done, ${stats.inProgress} in progress, ${stats.backlog} backlog`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Queries Linear for WOPR issues and generates Mermaid charts for the
 * GitHub org profile README:
 *
 * 1. Burn-Up Chart — scope vs completed (hourly)
 * 2. Milestone Progress — bar chart per milestone
 * 3. Velocity — issues closed per hour
 * 4. Priority Distribution — pie chart of open issues
 * 5. Issue State Breakdown — pie chart
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

const PRIORITY_NAMES = ["None", "Urgent", "High", "Normal", "Low"];

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
            priority
            state { type }
            labels { nodes { name } }
            projectMilestone { id name }
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

const ZWSP = "\u200B"; // zero-width space for invisible unique labels

function getHourLabel(isoStr, index, prevIsoStr) {
  const d = new Date(isoStr);
  // Show date only at day boundaries
  if (!prevIsoStr || new Date(prevIsoStr).getDate() !== d.getDate()) {
    const month = d.toLocaleString("en", { month: "short" });
    return `${month} ${d.getDate()}`;
  }
  // Unique invisible label for intermediate hours
  return ZWSP.repeat(index);
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

  // Sample to max ~60 slots (labels are invisible except day boundaries)
  if (slots.length > 60) {
    const step = Math.ceil(slots.length / 60);
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
  const slotLabels = slots.map((s, i) => getHourLabel(s, i, i > 0 ? slots[i - 1] : null));

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

  return { slotLabels, scopeLine, doneLine, repoStats, slots };
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

function buildMilestoneData(issues) {
  const milestones = {};

  for (const issue of issues) {
    const ms = issue.projectMilestone;
    if (!ms) continue;
    // Skip deleted milestones
    if (ms.name.startsWith("[DELETED]")) continue;

    if (!milestones[ms.name]) milestones[ms.name] = { total: 0, done: 0 };
    milestones[ms.name].total++;
    const type = issue.state.type;
    if (type === "completed" || type === "cancelled") milestones[ms.name].done++;
  }

  return milestones;
}

function generateMilestoneChart(milestones) {
  const entries = Object.entries(milestones).sort((a, b) => {
    // Sort by completion % ascending (least done first)
    const pctA = a[1].total > 0 ? a[1].done / a[1].total : 0;
    const pctB = b[1].total > 0 ? b[1].done / b[1].total : 0;
    return pctA - pctB;
  });

  if (entries.length === 0) return "";

  const names = entries.map(([n]) => {
    // Truncate long milestone names
    const short = n.length > 16 ? n.slice(0, 15) + "\u2026" : n;
    return `"${short}"`;
  });
  const done = entries.map(([, s]) => s.done);
  const open = entries.map(([, s]) => s.total - s.done);

  const max = Math.max(...entries.map(([, s]) => s.total));

  const lines = [];
  lines.push("```mermaid");
  lines.push("xychart-beta");
  lines.push('  title "Milestone Progress"');
  lines.push(`  x-axis [${names.join(", ")}]`);
  lines.push(`  y-axis "Issues" 0 --> ${Math.ceil(max * 1.15)}`);
  lines.push(`  bar [${done.join(", ")}]`);
  lines.push(`  bar [${open.join(", ")}]`);
  lines.push("```");
  return lines.join("\n");
}

function buildVelocityData(issues, slots) {
  // Count issues completed in each hourly slot
  return slots.map((slotIso) => {
    const slotStart = new Date(slotIso);
    const slotEnd = new Date(slotIso);
    slotEnd.setHours(slotEnd.getHours() + 1);

    let count = 0;
    for (const issue of issues) {
      if (!issue.completedAt) continue;
      const completed = new Date(issue.completedAt);
      if (completed >= slotStart && completed < slotEnd) count++;
    }
    return count;
  });
}

function generateVelocityChart(slotLabels, velocityLine) {
  const max = Math.max(...velocityLine);
  if (max === 0) return "";

  const lines = [];
  lines.push("```mermaid");
  lines.push("xychart-beta");
  lines.push('  title "Velocity \u2014 Issues Closed per Hour"');
  lines.push(`  x-axis [${slotLabels.map((w) => `"${w}"`).join(", ")}]`);
  lines.push(`  y-axis "Closed" 0 --> ${Math.ceil(max * 1.15)}`);
  lines.push(`  bar [${velocityLine.join(", ")}]`);
  lines.push("```");
  return lines.join("\n");
}

function generatePriorityPie(issues) {
  const counts = {};
  for (const issue of issues) {
    const type = issue.state.type;
    if (type === "completed" || type === "cancelled") continue;
    const name = PRIORITY_NAMES[issue.priority] || "None";
    counts[name] = (counts[name] || 0) + 1;
  }

  if (Object.keys(counts).length === 0) return "";

  // Order: Urgent, High, Normal, Low, None
  const order = ["Urgent", "High", "Normal", "Low", "None"];
  const lines = [];
  lines.push("```mermaid");
  lines.push("pie");
  lines.push('  title "Open Issues by Priority"');
  for (const name of order) {
    if (counts[name]) lines.push(`  "${name}" : ${counts[name]}`);
  }
  lines.push("```");
  return lines.join("\n");
}

function generateStatePie(stats) {
  const lines = [];
  lines.push("```mermaid");
  lines.push("pie");
  lines.push('  title "Issue State Breakdown"');
  if (stats.done > 0) lines.push(`  "Completed" : ${stats.done}`);
  if (stats.inProgress > 0) lines.push(`  "In Progress" : ${stats.inProgress}`);
  if (stats.backlog > 0) lines.push(`  "Backlog" : ${stats.backlog}`);
  lines.push("```");
  return lines.join("\n");
}

async function main() {
  console.log("Fetching labels from Linear...");
  await fetchLabels();

  console.log("Fetching issues from Linear...");
  const issues = await fetchAllIssues();
  console.log(`Fetched ${issues.length} issues`);

  const { slotLabels, scopeLine, doneLine, repoStats, slots } = buildBurnupData(issues);
  const stats = buildSummaryStats(issues);

  // Chart 1: Burn-Up
  const burnup = generateMermaid(slotLabels, scopeLine, doneLine);

  // Chart 2: Milestone Progress
  const milestoneData = buildMilestoneData(issues);
  const milestoneChart = generateMilestoneChart(milestoneData);

  // Chart 3: Velocity (per hour)
  const velocityLine = buildVelocityData(issues, slots);
  const velocityChart = generateVelocityChart(slotLabels, velocityLine);

  // Chart 4: Priority Distribution (open issues)
  const priorityPie = generatePriorityPie(issues);

  // Chart 5: State Breakdown
  const statePie = generateStatePie(stats);

  const table = generateTable(repoStats);
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const sections = [`# WOPR Network

**AI-native multi-channel bot platform** \u2014 Discord, Slack, Telegram, WhatsApp, Signal, IRC, and more.

## Burn-Up Chart

${burnup}

> **Upper line** = total scope (issues created) | **Lower line** = completed | **Gap** = remaining work`];

  if (milestoneChart) {
    sections.push(`## Milestone Progress

${milestoneChart}

> **Dark bars** = completed | **Light bars** = remaining`);
  }

  if (velocityChart) {
    sections.push(`## Velocity

${velocityChart}`);
  }

  sections.push(`## Progress by Repo

${table}`);

  // Pie charts side by side in a table
  if (priorityPie || statePie) {
    const pies = [];
    if (statePie) pies.push(`### Issue States\n\n${statePie}`);
    if (priorityPie) pies.push(`### Open by Priority\n\n${priorityPie}`);
    sections.push(pies.join("\n\n"));
  }

  sections.push(`## Summary

| Metric | Count |
|--------|-------|
| Total Issues | ${stats.total} |
| Completed | ${stats.done} |
| In Progress | ${stats.inProgress} |
| Backlog | ${stats.backlog} |
| Completion | ${stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0}% |

---

*Updated automatically every hour from [Linear](https://linear.app/wopr) \u2014 last run: ${now} UTC*`);

  const readme = sections.join("\n\n") + "\n";

  const { writeFileSync } = await import("node:fs");
  writeFileSync("profile/README.md", readme);
  console.log("Wrote profile/README.md");
  console.log(
    `Stats: ${stats.total} total, ${stats.done} done, ${stats.inProgress} in progress, ${stats.backlog} backlog`,
  );
  console.log(`Charts: burn-up (${slotLabels.length} slots), milestones (${Object.keys(milestoneData).length}), velocity, priority pie, state pie`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

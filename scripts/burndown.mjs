#!/usr/bin/env node
/**
 * Queries Linear for WOPR issues and generates QuickChart.io chart images
 * for the GitHub org profile README:
 *
 * 1. Burn-Up Chart — scope vs completed (hourly)
 * 2. Milestone Progress — horizontal bar chart
 * 3. Velocity — issues closed per hour
 * 4. Priority Distribution — doughnut chart of open issues
 * 5. Issue State Breakdown — doughnut chart
 *
 * Requires: LINEAR_API_KEY env var
 * Usage: node scripts/burndown.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LINEAR_API = "https://api.linear.app/graphql";
const TEAM_ID = "dca92d56-659a-4ee9-a8d1-69d1f0de19e0";

function loadApiKey() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  const keyFile = join(homedir(), ".config", "wopr", "linear-api-key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  return null;
}

const API_KEY = loadApiKey();

if (!API_KEY) {
  console.error("LINEAR_API_KEY not set (env or ~/.config/wopr/linear-api-key)");
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

function getHourLabel(isoStr) {
  const d = new Date(isoStr);
  const month = d.toLocaleString("en", { month: "short" });
  const day = d.getDate();
  const hour = d.getHours().toString().padStart(2, "0");
  return `${month} ${day} ${hour}:00`;
}

function quickchartUrl(config, width = 700, height = 300) {
  const json = JSON.stringify(config);
  const encoded = encodeURIComponent(json);
  return `https://quickchart.io/chart?c=${encoded}&w=${width}&h=${height}&bkg=%23ffffff`;
}

async function quickchartShortUrl(config, width = 700, height = 300) {
  const res = await fetch("https://quickchart.io/chart/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chart: config,
      width,
      height,
      backgroundColor: "#ffffff",
      format: "png",
    }),
  });
  if (!res.ok) {
    console.error(`QuickChart POST error: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  return data.url;
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

  // Sample to max ~48 slots for chart readability
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

async function generateBurnupChart(slotLabels, scopeLine, doneLine) {
  // Show every Nth label to avoid crowding
  const step = Math.max(1, Math.ceil(slotLabels.length / 12));
  const sparseLabels = slotLabels.map((l, i) => (i % step === 0 ? l : ""));

  const config = {
    type: "line",
    data: {
      labels: sparseLabels,
      datasets: [
        {
          label: "Scope",
          data: scopeLine,
          borderColor: "#6366f1",
          backgroundColor: "rgba(99,102,241,0.1)",
          fill: true,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: "Completed",
          data: doneLine,
          borderColor: "#10b981",
          backgroundColor: "rgba(16,185,129,0.15)",
          fill: true,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      title: { display: true, text: "Burn-Up \u2014 Scope vs Completed", fontSize: 16 },
      scales: {
        xAxes: [{ ticks: { maxRotation: 45, fontSize: 10 } }],
        yAxes: [{ ticks: { beginAtZero: true }, scaleLabel: { display: true, labelString: "Issues" } }],
      },
      legend: { position: "bottom" },
    },
  };

  const url = await quickchartShortUrl(config, 800, 300);
  if (!url) return "";
  return `![Burn-Up Chart](${url})`;
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
  const now = new Date();
  const windowMs = 7 * 24 * 60 * 60 * 1000; // 7-day velocity window
  const windowStart = new Date(now.getTime() - windowMs);

  for (const issue of issues) {
    const ms = issue.projectMilestone;
    if (!ms) continue;
    if (ms.name.startsWith("[DELETED]")) continue;

    if (!milestones[ms.name]) milestones[ms.name] = { total: 0, done: 0, recentDone: 0 };
    milestones[ms.name].total++;
    const type = issue.state.type;
    if (type === "completed" || type === "cancelled") {
      milestones[ms.name].done++;
      // Track velocity: completed in last 7 days
      if (issue.completedAt && new Date(issue.completedAt) >= windowStart) {
        milestones[ms.name].recentDone++;
      }
    }
  }

  return milestones;
}

function buildDailySlots(earliest) {
  const now = new Date();
  const start = new Date(earliest);
  start.setHours(0, 0, 0, 0);

  const slots = [];
  const current = new Date(start);
  while (current <= now) {
    slots.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return slots;
}

async function generateProjectionChart(milestones, issues) {
  const now = new Date();

  // Only chart incomplete milestones
  const incomplete = Object.entries(milestones)
    .filter(([, s]) => s.total > 0 && s.total - s.done > 0);

  if (incomplete.length === 0) return "";

  // Group issues by milestone
  const issuesByMs = {};
  for (const issue of issues) {
    const ms = issue.projectMilestone;
    if (!ms || ms.name.startsWith("[DELETED]")) continue;
    if (!issuesByMs[ms.name]) issuesByMs[ms.name] = [];
    issuesByMs[ms.name].push(issue);
  }

  // Find earliest issue across all incomplete milestones
  let earliest = now;
  for (const [name] of incomplete) {
    for (const issue of issuesByMs[name] || []) {
      const d = new Date(issue.createdAt);
      if (d < earliest) earliest = d;
    }
  }

  // Build daily historical slots
  const historySlots = buildDailySlots(earliest);

  // Compute historical remaining per day per milestone
  const colors = ["#6366f1", "#10b981", "#f97316", "#ef4444", "#eab308", "#3b82f6", "#ec4899", "#14b8a6", "#8b5cf6", "#f43f5e"];
  const datasets = [];
  let maxProjectedDays = 0;

  for (let mi = 0; mi < incomplete.length; mi++) {
    const [name, stats] = incomplete[mi];
    const msIssues = issuesByMs[name] || [];
    const color = colors[mi % colors.length];

    // Historical: remaining issues at end of each day
    const histData = historySlots.map((day) => {
      const dayEnd = new Date(day);
      dayEnd.setHours(23, 59, 59, 999);
      let created = 0;
      let done = 0;
      for (const issue of msIssues) {
        if (new Date(issue.createdAt) <= dayEnd) {
          created++;
          if (issue.completedAt && new Date(issue.completedAt) <= dayEnd) done++;
          else if (!issue.completedAt && (issue.state.type === "completed" || issue.state.type === "cancelled")) {
            // No completedAt but done — count as done at current time only
            if (dayEnd >= now) done++;
          }
        }
      }
      return created - done;
    });

    // Velocity: 7-day average issues/day
    const velocity = Math.max(1, stats.recentDone) / 7;
    const remaining = stats.total - stats.done;

    // Project future: generate daily points declining to 0
    let projDays = Math.ceil(remaining / velocity);
    if (projDays > 90) projDays = 90; // cap at 90 days

    if (projDays > maxProjectedDays) maxProjectedDays = projDays;

    // Build projected data (starts with null for historical, then declining values)
    const projData = [];
    for (let d = 0; d < historySlots.length - 1; d++) projData.push(null);
    // Last historical point = start of projection
    projData.push(remaining);
    for (let d = 1; d <= projDays; d++) {
      const val = Math.max(0, remaining - velocity * d);
      projData.push(Math.round(val * 10) / 10);
    }

    // Actual line (solid)
    datasets.push({
      label: name,
      data: [...histData, ...Array(projDays).fill(null)],
      borderColor: color,
      backgroundColor: "transparent",
      pointRadius: 0,
      borderWidth: 2,
      fill: false,
    });

    // Projected line (dashed, hidden from legend)
    datasets.push({
      label: "",
      data: projData,
      borderColor: color,
      backgroundColor: "transparent",
      pointRadius: 0,
      borderWidth: 2,
      borderDash: [6, 3],
      fill: false,
    });
  }

  // Build x-axis labels: historical days + projected future days
  const allLabels = [];
  const labelStep = Math.max(1, Math.ceil((historySlots.length + maxProjectedDays) / 16));

  for (let i = 0; i < historySlots.length; i++) {
    if (i % labelStep === 0) {
      const d = historySlots[i];
      allLabels.push(`${d.toLocaleString("en", { month: "short" })} ${d.getDate()}`);
    } else {
      allLabels.push("");
    }
  }
  for (let d = 1; d <= maxProjectedDays; d++) {
    const future = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const idx = historySlots.length + d - 1;
    if (idx % labelStep === 0) {
      allLabels.push(`${future.toLocaleString("en", { month: "short" })} ${future.getDate()}`);
    } else {
      allLabels.push("");
    }
  }

  const config = {
    type: "line",
    data: { labels: allLabels, datasets },
    options: {
      title: { display: true, text: "Burndown Projection (7-day velocity)", fontSize: 16 },
      scales: {
        xAxes: [{ ticks: { maxRotation: 45, fontSize: 10 } }],
        yAxes: [{
          ticks: { beginAtZero: true },
          scaleLabel: { display: true, labelString: "Remaining Issues" },
        }],
      },
      legend: { position: "bottom" },
      spanGaps: false,
    },
  };

  const url = await quickchartShortUrl(config, 900, 400);
  if (!url) return "";
  return `![Projection](${url})`;
}

function generateMilestoneChart(milestones) {
  const entries = Object.entries(milestones)
    .filter(([, s]) => s.total > 0)
    .sort((a, b) => {
      const pctA = a[1].done / a[1].total;
      const pctB = b[1].done / b[1].total;
      return pctB - pctA; // highest completion on top
    });

  if (entries.length === 0) return "";

  const config = {
    type: "horizontalBar",
    data: {
      labels: entries.map(([n]) => n),
      datasets: [
        {
          label: "Done",
          data: entries.map(([, s]) => s.done),
          backgroundColor: "#10b981",
        },
        {
          label: "Remaining",
          data: entries.map(([, s]) => s.total - s.done),
          backgroundColor: "#e5e7eb",
        },
      ],
    },
    options: {
      title: { display: true, text: "Milestone Progress", fontSize: 16 },
      scales: {
        xAxes: [{ stacked: true, ticks: { beginAtZero: true } }],
        yAxes: [{ stacked: true, ticks: { fontSize: 11 } }],
      },
      legend: { position: "bottom" },
    },
  };

  const height = Math.max(300, entries.length * 28 + 80);
  return `![Milestone Progress](${quickchartUrl(config, 700, height)})`;
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

  const step = Math.max(1, Math.ceil(slotLabels.length / 12));
  const sparseLabels = slotLabels.map((l, i) => (i % step === 0 ? l : ""));

  const config = {
    type: "bar",
    data: {
      labels: sparseLabels,
      datasets: [
        {
          label: "Issues Closed",
          data: velocityLine,
          backgroundColor: "#6366f1",
        },
      ],
    },
    options: {
      title: { display: true, text: "Velocity \u2014 Issues Closed per Hour", fontSize: 16 },
      scales: {
        xAxes: [{ ticks: { maxRotation: 45, fontSize: 10 } }],
        yAxes: [{ ticks: { beginAtZero: true, stepSize: 1 }, scaleLabel: { display: true, labelString: "Closed" } }],
      },
      legend: { display: false },
    },
  };

  return `![Velocity](${quickchartUrl(config, 800, 250)})`;
}

function generatePriorityChart(issues) {
  const counts = {};
  for (const issue of issues) {
    const type = issue.state.type;
    if (type === "completed" || type === "cancelled") continue;
    const name = PRIORITY_NAMES[issue.priority] || "None";
    counts[name] = (counts[name] || 0) + 1;
  }

  if (Object.keys(counts).length === 0) return "";

  const order = ["Urgent", "High", "Normal", "Low", "None"];
  const colors = ["#ef4444", "#f97316", "#eab308", "#3b82f6", "#9ca3af"];
  const labels = [];
  const data = [];
  const bgColors = [];

  for (let i = 0; i < order.length; i++) {
    if (counts[order[i]]) {
      labels.push(order[i]);
      data.push(counts[order[i]]);
      bgColors.push(colors[i]);
    }
  }

  const config = {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: bgColors }],
    },
    options: {
      title: { display: true, text: "Open Issues by Priority", fontSize: 14 },
      legend: { position: "right" },
    },
  };

  return `![Priority](${quickchartUrl(config, 400, 250)})`;
}

async function generateScopeCreepChart(issues, slots, slotLabels) {
  // Cumulative created vs cumulative closed over time
  const cumulativeCreated = slots.map((slotIso) => {
    const slotEnd = new Date(slotIso);
    slotEnd.setHours(slotEnd.getHours() + 1);
    let count = 0;
    for (const issue of issues) {
      if (new Date(issue.createdAt) <= slotEnd) count++;
    }
    return count;
  });

  const cumulativeClosed = slots.map((slotIso) => {
    const slotEnd = new Date(slotIso);
    slotEnd.setHours(slotEnd.getHours() + 1);
    let count = 0;
    for (const issue of issues) {
      if (issue.completedAt && new Date(issue.completedAt) <= slotEnd) count++;
    }
    return count;
  });

  // Gap = created - closed (the backlog)
  const gap = cumulativeCreated.map((c, i) => c - cumulativeClosed[i]);

  const step = Math.max(1, Math.ceil(slotLabels.length / 12));
  const sparseLabels = slotLabels.map((l, i) => (i % step === 0 ? l : ""));

  const config = {
    type: "line",
    data: {
      labels: sparseLabels,
      datasets: [
        {
          label: "Created",
          data: cumulativeCreated,
          borderColor: "#6366f1",
          backgroundColor: "transparent",
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
        },
        {
          label: "Closed",
          data: cumulativeClosed,
          borderColor: "#10b981",
          backgroundColor: "transparent",
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
        },
        {
          label: "Backlog Gap",
          data: gap,
          borderColor: "#ef4444",
          backgroundColor: "rgba(239,68,68,0.08)",
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [4, 3],
          fill: true,
        },
      ],
    },
    options: {
      title: { display: true, text: "Scope Creep — Created vs Closed", fontSize: 16 },
      scales: {
        xAxes: [{ ticks: { maxRotation: 45, fontSize: 10 } }],
        yAxes: [{ ticks: { beginAtZero: true }, scaleLabel: { display: true, labelString: "Issues (cumulative)" } }],
      },
      legend: { position: "bottom" },
    },
  };

  const url = await quickchartShortUrl(config, 800, 300);
  if (!url) return "";
  return `![Scope Creep](${url})`;
}

async function generateConfidenceCone(issues) {
  const now = new Date();

  // Total remaining
  const total = issues.length;
  let done = 0;
  for (const issue of issues) {
    const type = issue.state.type;
    if (type === "completed" || type === "cancelled") done++;
  }
  const remaining = total - done;
  if (remaining === 0) return "";

  // Compute closure counts for rolling windows
  const closureDates = issues
    .filter((i) => i.completedAt)
    .map((i) => new Date(i.completedAt));

  if (closureDates.length < 2) return "";

  const countInWindow = (days) => {
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    let count = 0;
    for (const dt of closureDates) {
      if (dt >= cutoff) count++;
    }
    return Math.max(1, count) / days; // issues/day, floor of 1 total
  };

  // Rolling window averages: recent bursts show up in short windows
  const optimistic = countInWindow(3);   // last 3 days
  const expected = countInWindow(7);     // last 7 days
  const pessimistic = countInWindow(14); // last 14 days

  // Project days to completion for each rate
  const optDays = Math.ceil(remaining / optimistic);
  const expDays = Math.ceil(remaining / expected);
  const pesDays = Math.ceil(remaining / pessimistic);
  const maxDays = Math.min(pesDays, 120); // cap at 120 days

  // Build the datasets: remaining issues declining over future days
  const labels = [];
  const optData = [];
  const expData = [];
  const pesData = [];

  // Add "Today" as first point
  const labelStep = Math.max(1, Math.ceil(maxDays / 16));
  for (let d = 0; d <= maxDays; d++) {
    const future = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    if (d % labelStep === 0) {
      labels.push(`${future.toLocaleString("en", { month: "short" })} ${future.getDate()}`);
    } else {
      labels.push("");
    }
    optData.push(Math.max(0, remaining - optimistic * d));
    expData.push(Math.max(0, remaining - expected * d));
    pesData.push(Math.max(0, remaining - pessimistic * d));
  }

  const config = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: `Optimistic — 3-day avg (${Math.round(optimistic * 10) / 10}/day)`,
          data: optData,
          borderColor: "#10b981",
          backgroundColor: "rgba(16,185,129,0.08)",
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
        },
        {
          label: `Expected — 7-day avg (${Math.round(expected * 10) / 10}/day)`,
          data: expData,
          borderColor: "#6366f1",
          backgroundColor: "rgba(99,102,241,0.1)",
          pointRadius: 0,
          borderWidth: 2.5,
          fill: false,
        },
        {
          label: `Pessimistic — 14-day avg (${Math.round(pessimistic * 10) / 10}/day)`,
          data: pesData,
          borderColor: "#ef4444",
          backgroundColor: "rgba(239,68,68,0.08)",
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
        },
      ],
    },
    options: {
      title: { display: true, text: "Confidence Cone — When Are We Done?", fontSize: 16 },
      scales: {
        xAxes: [{ ticks: { maxRotation: 45, fontSize: 10 } }],
        yAxes: [{
          ticks: { beginAtZero: true },
          scaleLabel: { display: true, labelString: "Remaining Issues" },
        }],
      },
      legend: { position: "bottom" },
      annotation: {
        annotations: [{
          type: "line",
          mode: "horizontal",
          scaleID: "y-axis-0",
          value: 0,
          borderColor: "#10b981",
          borderWidth: 1,
          borderDash: [4, 4],
        }],
      },
    },
  };

  const url = await quickchartShortUrl(config, 800, 350);
  if (!url) return "";
  return `![Confidence Cone](${url})`;
}

async function generatePriorityProjection(issues) {
  const now = new Date();
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const windowStart = new Date(now.getTime() - windowMs);

  // Group by priority
  const priorities = {};
  for (const issue of issues) {
    const name = PRIORITY_NAMES[issue.priority] || "None";
    if (!priorities[name]) priorities[name] = { total: 0, done: 0, recentDone: 0, issues: [] };
    priorities[name].total++;
    priorities[name].issues.push(issue);
    const type = issue.state.type;
    if (type === "completed" || type === "cancelled") {
      priorities[name].done++;
      if (issue.completedAt && new Date(issue.completedAt) >= windowStart) {
        priorities[name].recentDone++;
      }
    }
  }

  // Only chart priorities with remaining issues, in severity order
  const order = ["Urgent", "High", "Normal", "Low", "None"];
  const colors = { Urgent: "#ef4444", High: "#f97316", Normal: "#eab308", Low: "#3b82f6", None: "#9ca3af" };
  const incomplete = order.filter((p) => priorities[p] && priorities[p].total - priorities[p].done > 0);

  if (incomplete.length === 0) return "";

  // Find earliest issue creation for history
  let earliest = now;
  for (const issue of issues) {
    const d = new Date(issue.createdAt);
    if (d < earliest) earliest = d;
  }

  const historySlots = buildDailySlots(earliest);
  const datasets = [];
  let maxProjectedDays = 0;

  for (const pName of incomplete) {
    const stats = priorities[pName];
    const color = colors[pName];
    const remaining = stats.total - stats.done;
    const velocity = Math.max(1, stats.recentDone) / 7;

    // Historical: remaining per day for this priority
    const histData = historySlots.map((day) => {
      const dayEnd = new Date(day);
      dayEnd.setHours(23, 59, 59, 999);
      let created = 0;
      let doneCount = 0;
      for (const issue of stats.issues) {
        if (new Date(issue.createdAt) <= dayEnd) {
          created++;
          if (issue.completedAt && new Date(issue.completedAt) <= dayEnd) doneCount++;
          else if (!issue.completedAt && (issue.state.type === "completed" || issue.state.type === "cancelled")) {
            if (dayEnd >= now) doneCount++;
          }
        }
      }
      return created - doneCount;
    });

    let projDays = Math.ceil(remaining / velocity);
    if (projDays > 90) projDays = 90;
    if (projDays > maxProjectedDays) maxProjectedDays = projDays;

    // Projected data
    const projData = [];
    for (let d = 0; d < historySlots.length - 1; d++) projData.push(null);
    projData.push(remaining);
    for (let d = 1; d <= projDays; d++) {
      projData.push(Math.max(0, Math.round((remaining - velocity * d) * 10) / 10));
    }

    // Solid historical line
    datasets.push({
      label: pName,
      data: [...histData, ...Array(projDays).fill(null)],
      borderColor: color,
      backgroundColor: "transparent",
      pointRadius: 0,
      borderWidth: 2.5,
      fill: false,
    });

    // Dashed projected line
    datasets.push({
      label: "",
      data: projData,
      borderColor: color,
      backgroundColor: "transparent",
      pointRadius: 0,
      borderWidth: 2,
      borderDash: [6, 3],
      fill: false,
    });
  }

  // Labels
  const allLabels = [];
  const labelStep = Math.max(1, Math.ceil((historySlots.length + maxProjectedDays) / 16));

  for (let i = 0; i < historySlots.length; i++) {
    if (i % labelStep === 0) {
      const d = historySlots[i];
      allLabels.push(`${d.toLocaleString("en", { month: "short" })} ${d.getDate()}`);
    } else {
      allLabels.push("");
    }
  }
  for (let d = 1; d <= maxProjectedDays; d++) {
    const future = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const idx = historySlots.length + d - 1;
    if (idx % labelStep === 0) {
      allLabels.push(`${future.toLocaleString("en", { month: "short" })} ${future.getDate()}`);
    } else {
      allLabels.push("");
    }
  }

  const config = {
    type: "line",
    data: { labels: allLabels, datasets },
    options: {
      title: { display: true, text: "Priority Burndown — When Is Each Severity Done?", fontSize: 16 },
      scales: {
        xAxes: [{ ticks: { maxRotation: 45, fontSize: 10 } }],
        yAxes: [{
          ticks: { beginAtZero: true },
          scaleLabel: { display: true, labelString: "Remaining Issues" },
        }],
      },
      legend: { position: "bottom" },
      spanGaps: false,
    },
  };

  const url = await quickchartShortUrl(config, 900, 400);
  if (!url) return "";
  return `![Priority Burndown](${url})`;
}

function generateStateChart(stats) {
  const config = {
    type: "doughnut",
    data: {
      labels: ["Completed", "In Progress", "Backlog"],
      datasets: [
        {
          data: [stats.done, stats.inProgress, stats.backlog],
          backgroundColor: ["#10b981", "#6366f1", "#e5e7eb"],
        },
      ],
    },
    options: {
      title: { display: true, text: "Issue State Breakdown", fontSize: 14 },
      legend: { position: "right" },
    },
  };

  return `![States](${quickchartUrl(config, 400, 250)})`;
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
  const burnup = await generateBurnupChart(slotLabels, scopeLine, doneLine);

  // Chart 2: Milestone Progress + Projection
  const milestoneData = buildMilestoneData(issues);
  const milestoneChart = generateMilestoneChart(milestoneData);
  const projectionChart = await generateProjectionChart(milestoneData, issues);

  // Chart 3: Scope Creep Race
  const scopeCreepChart = await generateScopeCreepChart(issues, slots, slotLabels);

  // Chart 4: Confidence Cone
  const confidenceCone = await generateConfidenceCone(issues);

  // Chart 5: Priority Burndown Projection
  const priorityProjection = await generatePriorityProjection(issues);

  // Chart 6: Velocity (per hour)
  const velocityLine = buildVelocityData(issues, slots);
  const velocityChart = generateVelocityChart(slotLabels, velocityLine);

  // Chart 7: Priority Distribution (open issues)
  const priorityChart = generatePriorityChart(issues);

  // Chart 8: State Breakdown
  const stateChart = generateStateChart(stats);

  const table = generateTable(repoStats);
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const sections = [`# WOPR Network

**AI-native multi-channel bot platform** \u2014 Discord, Slack, Telegram, WhatsApp, Signal, IRC, and more.

## Burn-Up

${burnup}`];

  if (milestoneChart) {
    sections.push(`## Milestones

${milestoneChart}`);
  }

  if (projectionChart) {
    sections.push(`## Projected Completion

${projectionChart}`);
  }

  if (confidenceCone) {
    sections.push(`## Confidence Cone

${confidenceCone}`);
  }

  if (scopeCreepChart) {
    sections.push(`## Scope Creep

${scopeCreepChart}`);
  }

  if (priorityProjection) {
    sections.push(`## Priority Burndown

${priorityProjection}`);
  }

  if (velocityChart) {
    sections.push(`## Velocity

${velocityChart}`);
  }

  sections.push(`## Progress by Repo

${table}`);

  // Doughnut charts side by side
  if (stateChart || priorityChart) {
    sections.push(`## Distribution

${stateChart || ""} ${priorityChart || ""}`);
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
  writeFileSync("profile/README.md", readme);  // writeFileSync imported dynamically for compat
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

#!/usr/bin/env node
/**
 * Generates QuickChart.io chart images for the GitHub org profile README.
 *
 * Data sources:
 *   - data/linear-history.json — historical data from Linear (before cutoff)
 *   - GitHub Projects API (gh CLI) — current data (cutoff onward)
 *
 * Charts:
 *   1. Burn-Up Chart — scope vs completed with creep line + projection
 *   2. Milestone Progress — horizontal bar chart
 *   3. Velocity — issues closed per week
 *   4. Priority Distribution — doughnut chart
 *   5. Issue State Breakdown — doughnut chart
 *   6. Per-Repo Breakdown — markdown table
 *
 * Usage: node scripts/burndown.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

process.env.TZ = process.env.TZ || "America/Los_Angeles";

const ORG = "wopr-network";
const PROJECT_NUMBER = 1;
const CUTOFF_DATE = "2026-03-14";

// ── QuickChart Short URL API ────────────────────────────────────────────────

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

// ── GitHub Projects API via gh CLI ──────────────────────────────────────────

function gh(args) {
  return execSync(`gh ${args}`, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

function ghGraphQL(query) {
  const escaped = query.replace(/"/g, '\\"').replace(/\n/g, " ");
  const result = gh(`api graphql -f query="${escaped}"`);
  return JSON.parse(result);
}

function fetchGitHubIssues() {
  const query = `
    query {
      organization(login: "${ORG}") {
        projectV2(number: ${PROJECT_NUMBER}) {
          items(first: 100) {
            nodes {
              content {
                ... on Issue {
                  title
                  state
                  createdAt
                  closedAt
                  labels(first: 10) { nodes { name } }
                  repository { name }
                }
              }
              fieldValues(first: 10) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2SingleSelectField { name } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = ghGraphQL(query);
    const items = data.data?.organization?.projectV2?.items?.nodes || [];
    return items
      .filter((item) => item.content?.title)
      .map((item) => {
        const fields = {};
        for (const fv of item.fieldValues?.nodes || []) {
          if (fv.field?.name && fv.name) {
            fields[fv.field.name] = fv.name;
          }
        }
        return {
          title: item.content.title,
          state: item.content.state,
          createdAt: item.content.createdAt,
          closedAt: item.content.closedAt,
          labels: (item.content.labels?.nodes || []).map((l) => l.name),
          repo: item.content.repository?.name || "unknown",
          status: fields.Status || null,
          priority: fields.Priority || null,
          size: fields.Size || null,
        };
      });
  } catch {
    console.log("  No GitHub Project items yet (or project is empty)");
    return [];
  }
}

function fetchOrgRepos() {
  try {
    const result = gh(`repo list ${ORG} --limit 200 --json name --jq '.[].name'`);
    return result.split("\n").filter(Boolean);
  } catch {
    console.log("  Could not list org repos, using empty list");
    return [];
  }
}

function fetchGitHubMilestones() {
  const repos = fetchOrgRepos();

  const milestones = [];
  for (const repo of repos) {
    try {
      const result = gh(
        `api repos/${ORG}/${repo}/milestones --jq '.[] | {title, state, open_issues, closed_issues, due_on}'`
      );
      if (result) {
        for (const line of result.split("\n").filter(Boolean)) {
          try {
            const m = JSON.parse(line);
            m.repo = repo;
            milestones.push(m);
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* repo may not have milestones */ }
  }
  return milestones;
}

function fetchAllRepoIssues() {
  const repos = fetchOrgRepos();
  const issues = [];

  for (const repo of repos) {
    try {
      // Fetch both open and closed issues (up to 200 per repo)
      for (const state of ["open", "closed"]) {
        const result = gh(
          `issue list --repo ${ORG}/${repo} --state ${state} --limit 200 --json number,title,state,createdAt,closedAt,labels`
        );
        if (result) {
          const parsed = JSON.parse(result);
          for (const issue of parsed) {
            issue.repo = repo;
            issue.labels = (issue.labels || []).map((l) => l.name || l);
            issues.push(issue);
          }
        }
      }
    } catch { /* repo may not have issues enabled */ }
  }

  return issues;
}

// ── Load historical data ────────────────────────────────────────────────────

function loadLinearHistory() {
  const historyFile = join(ROOT, "data", "linear-history.json");
  if (!existsSync(historyFile)) {
    console.error("Missing data/linear-history.json — run linear-export.mjs first");
    process.exit(1);
  }
  return JSON.parse(readFileSync(historyFile, "utf8"));
}

// ── Merge & Build Data ──────────────────────────────────────────────────────

function buildDailyTimeSeries(history, ghIssues) {
  // Start with Linear daily data
  const dailyCreated = {};
  const dailyClosed = {};

  // Reconstruct daily deltas from Linear burn-up (cumulative)
  // Treat canceled/duplicate as resolved (they're not open work)
  const canceled = history.summary.canceled || 0;
  const burnUp = history.burnUp.map((pt, i) => {
    // Distribute canceled proportionally across the timeline
    const progress = (i + 1) / history.burnUp.length;
    return { ...pt, done: pt.done + Math.round(canceled * progress) };
  });

  for (let i = 0; i < burnUp.length; i++) {
    const pt = burnUp[i];
    const prev = i > 0 ? burnUp[i - 1] : { scope: 0, done: 0 };
    dailyCreated[pt.date] = pt.scope - prev.scope;
    dailyClosed[pt.date] = pt.done - prev.done;
  }

  // Add GitHub issues after cutoff
  for (const issue of ghIssues) {
    const created = issue.createdAt?.slice(0, 10);
    if (created && created > CUTOFF_DATE) {
      dailyCreated[created] = (dailyCreated[created] || 0) + 1;
    }
    if (issue.closedAt) {
      const closed = issue.closedAt.slice(0, 10);
      if (closed > CUTOFF_DATE) {
        dailyClosed[closed] = (dailyClosed[closed] || 0) + 1;
      }
    }
  }

  // Build cumulative arrays
  const allDates = [...new Set([
    ...Object.keys(dailyCreated),
    ...Object.keys(dailyClosed),
  ])].sort();

  let cumScope = 0, cumDone = 0;
  const scopeLine = [];
  const doneLine = [];
  const creepLine = [];
  const labels = [];

  for (const date of allDates) {
    cumScope += dailyCreated[date] || 0;
    cumDone += dailyClosed[date] || 0;
    scopeLine.push(cumScope);
    doneLine.push(cumDone);
    creepLine.push(cumScope - cumDone);
    labels.push(date);
  }

  return { scopeLine, doneLine, creepLine, labels, dailyCreated, dailyClosed };
}

function computeRates(ts) {
  // Compute rates from the last 5 days of data
  const now = new Date();
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const windowDays = 5;

  let createdInWindow = 0;
  let closedInWindow = 0;

  for (const [date, count] of Object.entries(ts.dailyCreated)) {
    if (new Date(date) >= fiveDaysAgo) createdInWindow += count;
  }
  for (const [date, count] of Object.entries(ts.dailyClosed)) {
    if (new Date(date) >= fiveDaysAgo) closedInWindow += count;
  }

  const scopeRate = createdInWindow / windowDays; // per day
  const doneRate = closedInWindow / windowDays;
  const creepRate = scopeRate - doneRate;

  return { scopeRate, doneRate, creepRate };
}

function buildProjection(ts, rates) {
  const lastIdx = ts.scopeLine.length - 1;
  const { scopeRate, doneRate, creepRate } = rates;

  // Project forward 30 days (or until creep hits 0)
  let projDays = 30;
  let crossingDay = null;
  let crossingLabel = null;

  if (creepRate < 0 && ts.creepLine[lastIdx] > 0) {
    const toZero = Math.ceil(-ts.creepLine[lastIdx] / creepRate);
    projDays = Math.min(Math.max(toZero, 30), 60);
    crossingDay = toZero;
    const crossingDate = new Date(
      Date.now() + toZero * 24 * 60 * 60 * 1000
    );
    crossingLabel = `${crossingDate.toLocaleString("en", { month: "short" })} ${crossingDate.getDate()}`;
  }

  const buildProj = (line, rate) => {
    const proj = new Array(line.length).fill(null);
    proj[lastIdx] = line[lastIdx]; // connect to last real point
    for (let i = 1; i <= projDays; i++) {
      proj.push(Math.max(0, Math.round(line[lastIdx] + rate * i)));
    }
    return proj;
  };

  // Pad historical lines
  const scopePadded = [...ts.scopeLine, ...new Array(projDays).fill(null)];
  const donePadded = [...ts.doneLine, ...new Array(projDays).fill(null)];
  const creepPadded = [...ts.creepLine, ...new Array(projDays).fill(null)];

  const scopeProj = buildProj(ts.scopeLine, scopeRate);
  const doneProj = buildProj(ts.doneLine, doneRate);
  const creepProj = buildProj(ts.creepLine, creepRate);

  // Extend labels for projection
  const allLabels = [...ts.labels];
  for (let i = 1; i <= projDays; i++) {
    const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
    allLabels.push(d.toISOString().slice(0, 10));
  }

  // Sparse labels for readability
  const labelStep = Math.max(1, Math.ceil(allLabels.length / 20));
  const sparseLabels = allLabels.map((l, i) =>
    i % labelStep === 0 ? l.slice(5) : ""
  );

  return {
    scopePadded, donePadded, creepPadded,
    scopeProj, doneProj, creepProj,
    sparseLabels, crossingDay, crossingLabel,
    projDays, lastIdx,
  };
}

function buildWeeklyVelocity(history, ghIssues) {
  const weekMap = {};
  for (const entry of history.weeklyVelocity) {
    weekMap[entry.week] = entry.count;
  }

  for (const issue of ghIssues) {
    if (issue.closedAt) {
      const d = new Date(issue.closedAt);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const weekKey = weekStart.toISOString().slice(0, 10);
      weekMap[weekKey] = (weekMap[weekKey] || 0) + 1;
    }
  }

  return Object.entries(weekMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, count]) => ({ week, count }));
}

function buildPriorityDistribution(history, ghIssues) {
  const dist = { ...history.priorityDistribution };
  for (const issue of ghIssues) {
    const p = issue.priority || "No priority";
    dist[p] = (dist[p] || 0) + 1;
  }
  return dist;
}

function buildStateBreakdown(history, ghIssues) {
  const states = {
    Done: history.summary.completed,
    Canceled: history.summary.canceled,
  };

  for (const issue of ghIssues) {
    const status = issue.status || (issue.state === "CLOSED" ? "Done" : "Todo");
    states[status] = (states[status] || 0) + 1;
  }

  return states;
}

function buildMilestoneProgress(history, ghMilestones) {
  const milestones = [];

  for (const m of history.milestones) {
    const pct = Math.round(m.progress * 100);
    milestones.push({
      name: m.name,
      done: pct,
      remaining: 100 - pct,
    });
  }

  for (const m of ghMilestones) {
    const total = m.open_issues + m.closed_issues;
    if (total === 0) continue;
    milestones.push({
      name: `${m.title} (${m.repo})`,
      done: m.closed_issues,
      remaining: m.open_issues,
    });
  }

  return milestones;
}

function buildRepoBreakdown(history, ghIssues) {
  // From Linear label distribution
  const REPO_LABELS = {
    "wopr-core": "core",
    "wopr-platform": "platform",
    "wopr-platform-ui": "platform-ui",
    "platform-ui": "platform-ui",
    "platform-core": "platform-core",
    "defcon": "silo",
    "plugin-discord": "discord",
    "plugin-msteams": "msteams",
    "plugin-whatsapp": "whatsapp",
    "plugin-telegram": "telegram",
    "plugin-slack": "slack",
    "plugin-github": "github",
    "plugin-webui": "webui",
    "plugin-types": "plugin-types",
    "security": "security",
    "testing": "testing",
    "monetization": "monetization",
    "devops": "devops",
  };

  const repoStats = {};

  // From Linear labels
  for (const [label, displayName] of Object.entries(REPO_LABELS)) {
    const count = history.labelDistribution[label] || 0;
    if (count > 0) {
      repoStats[displayName] = repoStats[displayName] || { total: 0, done: 0, open: 0 };
      repoStats[displayName].total += count;
      repoStats[displayName].done += count; // all Linear issues are done
    }
  }

  // From GitHub issues
  for (const issue of ghIssues) {
    const repo = issue.repo || "other";
    repoStats[repo] = repoStats[repo] || { total: 0, done: 0, open: 0 };
    repoStats[repo].total += 1;
    if (issue.state === "CLOSED") {
      repoStats[repo].done += 1;
    } else {
      repoStats[repo].open += 1;
    }
  }

  return repoStats;
}

function generateTable(repoStats) {
  const sorted = Object.entries(repoStats).sort((a, b) => b[1].total - a[1].total);
  const lines = [];
  lines.push("| Repo | Total | Done | Open | Progress |");
  lines.push("|------|-------|------|------|----------|");

  for (const [name, stats] of sorted) {
    const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
    const bar = pct === 100 ? "\u2705" : `${pct}%`;
    lines.push(`| ${name} | ${stats.total} | ${stats.done} | ${stats.open} | ${bar} |`);
  }

  return lines.join("\n");
}

// ── Chart Generators ────────────────────────────────────────────────────────

async function burnUpChart(proj) {
  const datasets = [
    {
      label: "Scope",
      data: proj.scopePadded,
      borderColor: "#6366f1",
      backgroundColor: "rgba(99,102,241,0.1)",
      fill: true,
      pointRadius: 0,
      borderWidth: 2,
    },
    {
      label: "Completed",
      data: proj.donePadded,
      borderColor: "#10b981",
      backgroundColor: "rgba(16,185,129,0.15)",
      fill: true,
      pointRadius: 0,
      borderWidth: 2,
    },
    {
      label: "Creep",
      data: proj.creepPadded,
      borderColor: "#ef4444",
      backgroundColor: "transparent",
      fill: false,
      pointRadius: 0,
      borderWidth: 1.5,
      borderDash: [4, 3],
    },
    {
      label: "",
      data: proj.scopeProj,
      borderColor: "rgba(99,102,241,0.4)",
      backgroundColor: "transparent",
      fill: false,
      pointRadius: 0,
      borderWidth: 1.5,
      borderDash: [6, 4],
    },
    {
      label: "",
      data: proj.doneProj,
      borderColor: "rgba(16,185,129,0.4)",
      backgroundColor: "transparent",
      fill: false,
      pointRadius: 0,
      borderWidth: 1.5,
      borderDash: [6, 4],
    },
    {
      label: "",
      data: proj.creepProj,
      borderColor: "rgba(239,68,68,0.4)",
      backgroundColor: "transparent",
      fill: false,
      pointRadius: 0,
      borderWidth: 1.5,
      borderDash: [2, 2],
    },
  ];

  // Add crossing marker if creep is projected to reach zero
  if (proj.crossingDay !== null && proj.crossingDay <= proj.projDays) {
    const markerData = new Array(proj.lastIdx + proj.projDays + 1).fill(null);
    markerData[proj.lastIdx + proj.crossingDay] = 0;
    datasets.push({
      label: `Creep \u2192 0: ${proj.crossingLabel}`,
      data: markerData,
      borderColor: "#ef4444",
      backgroundColor: "#ef4444",
      fill: false,
      pointRadius: markerData.map((v) => (v !== null ? 7 : 0)),
      pointStyle: "star",
      showLine: false,
    });
  }

  // Add vertical cutoff annotation
  const cutoffIdx = proj.sparseLabels.findIndex((l) => l === CUTOFF_DATE.slice(5));

  const config = {
    type: "line",
    data: { labels: proj.sparseLabels, datasets },
    options: {
      title: { display: true, text: "Burn-Up Chart (with Projection)", fontSize: 16 },
      scales: {
        yAxes: [{ ticks: { beginAtZero: true } }],
      },
      legend: {
        position: "bottom",
        labels: { filter: (item) => item.text !== "" },
      },
      plugins: {
        annotation: {
          annotations: [
            {
              type: "line",
              mode: "vertical",
              scaleID: "x-axis-0",
              value: cutoffIdx >= 0 ? cutoffIdx : CUTOFF_DATE.slice(5),
              borderColor: "rgba(107,114,128,0.5)",
              borderWidth: 1,
              borderDash: [5, 5],
              label: {
                content: "Linear \u2192 GitHub",
                enabled: true,
                position: "top",
                fontSize: 10,
              },
            },
          ],
        },
      },
    },
  };

  return quickchartShortUrl(config, 800, 350);
}

async function velocityChart(velocity) {
  const config = {
    type: "bar",
    data: {
      labels: velocity.map((v) => v.week.slice(5)),
      datasets: [{
        label: "Issues Closed",
        data: velocity.map((v) => v.count),
        backgroundColor: "#6366f1",
      }],
    },
    options: {
      title: { display: true, text: "Weekly Velocity", fontSize: 16 },
      scales: { yAxes: [{ ticks: { beginAtZero: true } }] },
      legend: { display: false },
    },
  };

  return quickchartShortUrl(config, 700, 300);
}

async function priorityChart(dist) {
  const colors = {
    Urgent: "#ef4444",
    High: "#f97316",
    Medium: "#eab308",
    Low: "#22c55e",
    "No priority": "#94a3b8",
    None: "#94a3b8",
  };

  const labels = Object.keys(dist);
  const config = {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: labels.map((l) => dist[l]),
        backgroundColor: labels.map((l) => colors[l] || "#94a3b8"),
      }],
    },
    options: {
      title: { display: true, text: "Priority Distribution", fontSize: 16 },
      legend: { position: "bottom" },
    },
  };

  return quickchartShortUrl(config, 400, 350);
}

async function stateChart(states) {
  const colors = {
    Done: "#10b981",
    "In Progress": "#f59e0b",
    Todo: "#e5e7eb",
    Canceled: "#94a3b8",
    Duplicate: "#cbd5e1",
  };

  const labels = Object.keys(states);
  const config = {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: labels.map((l) => states[l]),
        backgroundColor: labels.map((l) => colors[l] || "#94a3b8"),
      }],
    },
    options: {
      title: { display: true, text: "Issue States", fontSize: 16 },
      legend: { position: "bottom" },
    },
  };

  return quickchartShortUrl(config, 400, 350);
}

async function milestoneChart(milestones) {
  if (milestones.length === 0) return null;

  const config = {
    type: "horizontalBar",
    data: {
      labels: milestones.map((m) => m.name),
      datasets: [
        {
          label: "Done",
          data: milestones.map((m) => m.done),
          backgroundColor: "#10b981",
        },
        {
          label: "Remaining",
          data: milestones.map((m) => m.remaining),
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

  return quickchartShortUrl(config, 700, Math.max(300, milestones.length * 30 + 100));
}

// ── Update README ───────────────────────────────────────────────────────────

function updateReadme(charts) {
  const readmePath = join(ROOT, "profile", "README.md");
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const content = `# WOPR Network

**AI-native multi-channel bot platform** — Discord, Slack, Telegram, WhatsApp, Signal, IRC, and more.

## Burn-Up

${charts.burnUpUrl ? `![Burn-Up Chart](${charts.burnUpUrl})` : "_Chart unavailable_"}

## Velocity

${charts.velocityUrl ? `![Weekly Velocity](${charts.velocityUrl})` : "_Chart unavailable_"}

## Priority Distribution &nbsp; Issue States

<p>
${charts.priorityUrl ? `<img src="${charts.priorityUrl}" width="400" alt="Priority Distribution" />` : ""}
${charts.statesUrl ? `<img src="${charts.statesUrl}" width="400" alt="Issue States" />` : ""}
</p>

${charts.milestonesUrl ? `## Milestones\n\n![Milestone Progress](${charts.milestonesUrl})` : ""}

## Repo Breakdown

${charts.repoTable}

---

**${charts.totalDone.toLocaleString()}** of **${charts.totalScope.toLocaleString()}** issues completed &bull; Updated ${now} UTC
`;

  writeFileSync(readmePath, content);
  console.log(`  Updated: ${readmePath}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("WOPR Burndown Chart Generator");
  console.log("==============================");
  console.log(`  Cutoff: ${CUTOFF_DATE} (Linear \u2192 GitHub)`);

  console.log("\n1. Loading Linear history...");
  const history = loadLinearHistory();
  console.log(`   ${history.summary.totalIssues} issues, ${history.burnUp.length} data points`);

  console.log("\n2. Fetching GitHub Project items...");
  const projectItems = fetchGitHubIssues();
  console.log(`   ${projectItems.length} items in GitHub Project`);

  console.log("\n3. Fetching issues across all org repos...");
  const repoIssues = fetchAllRepoIssues();
  console.log(`   ${repoIssues.length} issues across ${fetchOrgRepos().length} repos`);

  // Merge project items + repo issues, dedupe by title+repo
  const seen = new Set();
  const ghIssues = [];
  for (const item of [...projectItems, ...repoIssues]) {
    const key = `${item.repo || ""}:${item.title || item.number}`;
    if (!seen.has(key)) {
      seen.add(key);
      ghIssues.push(item);
    }
  }
  console.log(`   ${ghIssues.length} unique GitHub issues total`);

  console.log("\n4. Fetching GitHub milestones...");
  const ghMilestones = fetchGitHubMilestones();
  console.log(`   ${ghMilestones.length} milestones across repos`);

  console.log("\n5. Building time series...");
  const ts = buildDailyTimeSeries(history, ghIssues);
  const rates = computeRates(ts);
  const proj = buildProjection(ts, rates);
  const velocity = buildWeeklyVelocity(history, ghIssues);
  const priority = buildPriorityDistribution(history, ghIssues);
  const states = buildStateBreakdown(history, ghIssues);
  const milestones = buildMilestoneProgress(history, ghMilestones);
  const repoStats = buildRepoBreakdown(history, ghIssues);

  console.log(`   Scope rate: ${rates.scopeRate.toFixed(1)}/day`);
  console.log(`   Done rate: ${rates.doneRate.toFixed(1)}/day`);
  console.log(`   Creep rate: ${rates.creepRate.toFixed(1)}/day`);
  if (proj.crossingLabel) {
    console.log(`   Creep \u2192 0: ${proj.crossingLabel}`);
  }

  console.log("\n6. Generating charts...");
  const [burnUpUrl, velocityUrl, priorityUrl, statesUrl, milestonesUrl] =
    await Promise.all([
      burnUpChart(proj),
      velocityChart(velocity),
      priorityChart(priority),
      stateChart(states),
      milestoneChart(milestones),
    ]);

  console.log(`   Burn-Up: ${burnUpUrl ? "OK" : "FAILED"}`);
  console.log(`   Velocity: ${velocityUrl ? "OK" : "FAILED"}`);
  console.log(`   Priority: ${priorityUrl ? "OK" : "FAILED"}`);
  console.log(`   States: ${statesUrl ? "OK" : "FAILED"}`);
  console.log(`   Milestones: ${milestonesUrl ? "OK" : "FAILED"}`);

  const lastPt = ts.scopeLine.length - 1;
  const repoTable = generateTable(repoStats);

  console.log("\n7. Updating README...");
  updateReadme({
    burnUpUrl,
    velocityUrl,
    priorityUrl,
    statesUrl,
    milestonesUrl,
    repoTable,
    totalScope: ts.scopeLine[lastPt],
    totalDone: ts.doneLine[lastPt],
  });

  console.log("\nDone!");
  console.log(`  Scope: ${ts.scopeLine[lastPt]} | Done: ${ts.doneLine[lastPt]}`);
  console.log(`  Data sources: Linear (${history.burnUp.length} days) + GitHub (${ghIssues.length} items)`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});

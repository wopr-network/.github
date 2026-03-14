#!/usr/bin/env node
/**
 * Generates QuickChart.io chart images for the GitHub org profile README.
 *
 * Data sources:
 *   - data/linear-history.json — historical data from Linear (before 2026-03-14)
 *   - GitHub Projects API (gh CLI) — current data (2026-03-14 onward)
 *
 * Charts:
 *   1. Burn-Up Chart — scope vs completed over time
 *   2. Milestone Progress — horizontal bar chart
 *   3. Velocity — issues closed per week
 *   4. Priority Distribution — doughnut chart
 *   5. Issue State Breakdown — doughnut chart
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
  // Get all items from the project with their status, priority, and repo
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

function fetchGitHubMilestones() {
  // Get milestones from the project's status field as a proxy
  // Real milestones come from repo milestones across the org
  const repos = [
    "wopr", "wopr-platform", "wopr-platform-ui", "silo", "norad",
    "cheyenne-mountain", "platform-ui-core", "platform-core",
    "paperclip", "paperclip-platform", "paperclip-platform-ui",
  ];

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

// ── Load historical data ────────────────────────────────────────────────────

function loadLinearHistory() {
  const historyFile = join(ROOT, "data", "linear-history.json");
  if (!existsSync(historyFile)) {
    console.error("Missing data/linear-history.json — run linear-export.mjs first");
    process.exit(1);
  }
  return JSON.parse(readFileSync(historyFile, "utf8"));
}

// ── Merge data sources ──────────────────────────────────────────────────────

function buildBurnUp(history, ghIssues) {
  // Start with Linear historical burn-up
  const burnUp = [...history.burnUp];
  const lastLinear = burnUp[burnUp.length - 1];
  let cumScope = lastLinear.scope;
  let cumDone = lastLinear.done;

  // Add GitHub issues created/closed after cutoff
  const dailyCreated = {};
  const dailyClosed = {};

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

  const ghDates = [
    ...new Set([...Object.keys(dailyCreated), ...Object.keys(dailyClosed)]),
  ].sort();

  for (const date of ghDates) {
    cumScope += dailyCreated[date] || 0;
    cumDone += dailyClosed[date] || 0;
    burnUp.push({ date, scope: cumScope, done: cumDone });
  }

  return burnUp;
}

function buildWeeklyVelocity(history, ghIssues) {
  // Start with Linear weekly velocity
  const weekMap = {};
  for (const entry of history.weeklyVelocity) {
    weekMap[entry.week] = entry.count;
  }

  // Add GitHub closed issues
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
  // Merge Linear historical + GitHub current
  const dist = { ...history.priorityDistribution };

  for (const issue of ghIssues) {
    const p = issue.priority || "No priority";
    dist[p] = (dist[p] || 0) + 1;
  }

  return dist;
}

function buildStateBreakdown(history, ghIssues) {
  // Linear final state
  const states = {
    Done: history.summary.completed,
    Canceled: history.summary.canceled,
  };

  // GitHub current state
  for (const issue of ghIssues) {
    const status = issue.status || (issue.state === "CLOSED" ? "Done" : "Todo");
    states[status] = (states[status] || 0) + 1;
  }

  return states;
}

function buildMilestoneProgress(history, ghMilestones) {
  const milestones = [];

  // Linear historical milestones (all 100% complete at cutoff)
  for (const m of history.milestones) {
    milestones.push({
      name: `${m.name} (Linear)`,
      done: Math.round(m.progress * 100),
      remaining: Math.round((1 - m.progress) * 100),
    });
  }

  // GitHub repo milestones
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

// ── Chart URL generators ────────────────────────────────────────────────────

function encodeChart(config, width = 700, height = 400) {
  const json = JSON.stringify(config);
  return `https://quickchart.io/chart?c=${encodeURIComponent(json)}&w=${width}&h=${height}&bkg=%23ffffff`;
}

function burnUpChart(burnUp) {
  // Sample to avoid URL length limits — take every Nth point
  const maxPoints = 40;
  const step = Math.max(1, Math.floor(burnUp.length / maxPoints));
  const sampled = burnUp.filter((_, i) => i % step === 0 || i === burnUp.length - 1);

  return encodeChart({
    type: "line",
    data: {
      labels: sampled.map((d) => d.date.slice(5)), // MM-DD
      datasets: [
        {
          label: "Scope",
          data: sampled.map((d) => d.scope),
          borderColor: "#6366f1",
          backgroundColor: "rgba(99,102,241,0.1)",
          fill: true,
          pointRadius: 2,
        },
        {
          label: "Done",
          data: sampled.map((d) => d.done),
          borderColor: "#10b981",
          backgroundColor: "rgba(16,185,129,0.1)",
          fill: true,
          pointRadius: 2,
        },
      ],
    },
    options: {
      title: { display: true, text: "Burn-Up Chart", fontSize: 16 },
      scales: {
        yAxes: [{ ticks: { beginAtZero: true } }],
      },
      legend: { position: "bottom" },
      plugins: {
        annotation: {
          annotations: [{
            type: "line",
            mode: "vertical",
            scaleID: "x-axis-0",
            value: CUTOFF_DATE.slice(5),
            borderColor: "#ef4444",
            borderWidth: 1,
            borderDash: [5, 5],
            label: {
              content: "Linear → GitHub",
              enabled: true,
              position: "top",
              fontSize: 10,
            },
          }],
        },
      },
    },
  }, 700, 350);
}

function velocityChart(velocity) {
  return encodeChart({
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
  }, 700, 300);
}

function priorityChart(dist) {
  const colors = {
    Urgent: "#ef4444",
    High: "#f97316",
    Medium: "#eab308",
    Low: "#22c55e",
    "No priority": "#94a3b8",
    None: "#94a3b8",
  };

  const labels = Object.keys(dist);
  return encodeChart({
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
  }, 400, 350);
}

function stateChart(states) {
  const colors = {
    Done: "#10b981",
    "In Progress": "#f59e0b",
    Todo: "#e5e7eb",
    Canceled: "#94a3b8",
    Duplicate: "#cbd5e1",
  };

  const labels = Object.keys(states);
  return encodeChart({
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
  }, 400, 350);
}

function milestoneChart(milestones) {
  if (milestones.length === 0) return null;

  return encodeChart({
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
  }, 700, Math.max(300, milestones.length * 30 + 100));
}

// ── Update README ───────────────────────────────────────────────────────────

function updateReadme(charts) {
  const readmePath = join(ROOT, "profile", "README.md");
  const totalIssues = charts.totalScope;
  const totalDone = charts.totalDone;
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const content = `# WOPR Network

**AI-native multi-channel bot platform** — Discord, Slack, Telegram, WhatsApp, Signal, IRC, and more.

## Burn-Up

![Burn-Up Chart](${charts.burnUp})

## Velocity

![Weekly Velocity](${charts.velocity})

## Priority Distribution &nbsp; Issue States

<p>
<img src="${charts.priority}" width="400" alt="Priority Distribution" />
<img src="${charts.states}" width="400" alt="Issue States" />
</p>

${charts.milestones ? `## Milestones\n\n![Milestone Progress](${charts.milestones})` : ""}

---

**${totalDone.toLocaleString()}** of **${totalIssues.toLocaleString()}** issues completed &bull; Updated ${now} UTC
`;

  writeFileSync(readmePath, content);
  console.log(`  Updated: ${readmePath}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("WOPR Burndown Chart Generator");
  console.log("==============================");
  console.log(`  Cutoff date: ${CUTOFF_DATE} (Linear → GitHub)`);

  console.log("\n1. Loading Linear history...");
  const history = loadLinearHistory();
  console.log(`   ${history.summary.totalIssues} issues, ${history.burnUp.length} data points`);

  console.log("\n2. Fetching GitHub Project items...");
  const ghIssues = fetchGitHubIssues();
  console.log(`   ${ghIssues.length} items in GitHub Project`);

  console.log("\n3. Fetching GitHub milestones...");
  const ghMilestones = fetchGitHubMilestones();
  console.log(`   ${ghMilestones.length} milestones across repos`);

  console.log("\n4. Building charts...");
  const burnUp = buildBurnUp(history, ghIssues);
  const velocity = buildWeeklyVelocity(history, ghIssues);
  const priority = buildPriorityDistribution(history, ghIssues);
  const states = buildStateBreakdown(history, ghIssues);
  const milestones = buildMilestoneProgress(history, ghMilestones);

  const lastBurnUp = burnUp[burnUp.length - 1];

  const charts = {
    burnUp: burnUpChart(burnUp),
    velocity: velocityChart(velocity),
    priority: priorityChart(priority),
    states: stateChart(states),
    milestones: milestoneChart(milestones),
    totalScope: lastBurnUp.scope,
    totalDone: lastBurnUp.done,
  };

  console.log("\n5. Updating README...");
  updateReadme(charts);

  console.log("\nDone!");
  console.log(`  Scope: ${lastBurnUp.scope} | Done: ${lastBurnUp.done}`);
  console.log(`  Data sources: Linear (${history.burnUp.length} days) + GitHub (${ghIssues.length} items)`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});

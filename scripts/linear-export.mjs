#!/usr/bin/env node
/**
 * Exports all Linear WOPR team data to JSON for migration to GitHub Issues.
 * Outputs: ~/.github/data/linear-export-YYYY-MM-DD.json
 *
 * Requires: LINEAR_API_KEY env var or ~/.config/wopr/linear-api-key
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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
  console.error("LINEAR_API_KEY not set");
  process.exit(1);
}

async function query(q, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: API_KEY },
    body: JSON.stringify({ query: q, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
    throw new Error("GraphQL query failed");
  }
  return json.data;
}

async function fetchAllIssues() {
  const issues = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    console.log(`  Fetching issues page ${page}...`);
    const data = await query(`
      query($teamId: ID!, $cursor: String) {
        issues(
          filter: { team: { id: { eq: $teamId } } }
          first: 100
          after: $cursor
          orderBy: createdAt
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id identifier title description
            priority priorityLabel
            state { name type }
            assignee { name email }
            creator { name email }
            labels { nodes { name } }
            estimate
            createdAt updatedAt completedAt canceledAt startedAt
            dueDate
            parent { id identifier title }
            children { nodes { id identifier title } }
            comments { nodes { body createdAt user { name } } }
            relations {
              nodes {
                type
                relatedIssue { id identifier title }
              }
            }
          }
        }
      }
    `, { teamId: TEAM_ID, cursor });

    issues.push(...data.issues.nodes);

    if (!data.issues.pageInfo.hasNextPage) break;
    cursor = data.issues.pageInfo.endCursor;
  }

  return issues;
}

async function fetchMilestones() {
  console.log("  Fetching milestones (projects)...");
  const data = await query(`
    query($teamId: ID!) {
      projects(
        filter: { accessibleTeams: { id: { eq: $teamId } } }
        first: 50
      ) {
        nodes {
          id name description state
          startDate targetDate
          progress
        }
      }
    }
  `, { teamId: TEAM_ID });
  return data.projects.nodes;
}

async function fetchLabels() {
  console.log("  Fetching labels...");
  const data = await query(`
    query($teamId: ID!) {
      issueLabels(
        filter: { team: { id: { eq: $teamId } } }
        first: 200
      ) {
        nodes { id name color description }
      }
    }
  `, { teamId: TEAM_ID });
  return data.issueLabels.nodes;
}

async function fetchCycles() {
  console.log("  Fetching cycles...");
  const data = await query(`
    query($teamId: ID!) {
      cycles(
        filter: { team: { id: { eq: $teamId } } }
        first: 50
        orderBy: createdAt
      ) {
        nodes {
          id number name
          startsAt endsAt
          progress
          completedScopeHistory scopeHistory
        }
      }
    }
  `, { teamId: TEAM_ID });
  return data.cycles.nodes;
}

async function fetchWorkflowStates() {
  console.log("  Fetching workflow states...");
  const data = await query(`
    query($teamId: ID!) {
      workflowStates(
        filter: { team: { id: { eq: $teamId } } }
        first: 50
      ) {
        nodes { id name type position color description }
      }
    }
  `, { teamId: TEAM_ID });
  return data.workflowStates.nodes;
}

async function main() {
  console.log("Linear WOPR Export");
  console.log("==================");

  const [issues, milestones, labels, cycles, states] = await Promise.all([
    fetchAllIssues(),
    fetchMilestones(),
    fetchLabels(),
    fetchCycles(),
    fetchWorkflowStates(),
  ]);

  const summary = {
    total: issues.length,
    byState: {},
    byPriority: {},
  };

  for (const issue of issues) {
    const state = issue.state?.name || "Unknown";
    const priority = issue.priorityLabel || "None";
    summary.byState[state] = (summary.byState[state] || 0) + 1;
    summary.byPriority[priority] = (summary.byPriority[priority] || 0) + 1;
  }

  const exportData = {
    exportedAt: new Date().toISOString(),
    teamId: TEAM_ID,
    summary,
    workflowStates: states,
    labels,
    cycles,
    milestones,
    issues,
  };

  const dataDir = join(homedir(), ".github", "data");
  mkdirSync(dataDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const outFile = join(dataDir, `linear-export-${date}.json`);
  writeFileSync(outFile, JSON.stringify(exportData, null, 2));

  console.log(`\nExported to: ${outFile}`);
  console.log(`\nSummary:`);
  console.log(`  Total issues: ${issues.length}`);
  console.log(`  Milestones: ${milestones.length}`);
  console.log(`  Labels: ${labels.length}`);
  console.log(`  Cycles: ${cycles.length}`);
  console.log(`  Workflow states: ${states.length}`);
  console.log(`\n  By state:`);
  for (const [k, v] of Object.entries(summary.byState).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v}`);
  }
  console.log(`\n  By priority:`);
  for (const [k, v] of Object.entries(summary.byPriority).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v}`);
  }
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});

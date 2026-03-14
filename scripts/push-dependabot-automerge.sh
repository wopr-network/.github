#!/usr/bin/env bash
# Pushes dependabot-auto-merge caller workflow to all wopr-network repos
set -euo pipefail

ORG="wopr-network"
WORKFLOW_FILE=".github/workflows/dependabot-auto-merge.yml"
SKIP_REPOS=(".github" "wopr-ops" "semantic-release-config")

CALLER_CONTENT='name: Dependabot Auto-Merge

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  auto-merge:
    uses: wopr-network/.github/.github/workflows/dependabot-auto-merge.yml@main
    secrets: inherit
'

REPOS=$(gh api "orgs/${ORG}/repos" --paginate --jq '.[].name')

for repo in $REPOS; do
  # Skip excluded repos
  if printf '%s\n' "${SKIP_REPOS[@]}" | grep -qx "$repo"; then
    echo "⏭  Skipping $repo"
    continue
  fi

  # Check if workflow already exists
  if gh api "repos/${ORG}/${repo}/contents/${WORKFLOW_FILE}" &>/dev/null; then
    echo "✓  $repo — already has dependabot-auto-merge"
    continue
  fi

  # Check if repo has .github/workflows (i.e. uses workflows at all)
  if ! gh api "repos/${ORG}/${repo}/contents/.github/workflows" &>/dev/null; then
    echo "⏭  $repo — no workflows dir, skipping"
    continue
  fi

  echo "→  Adding to $repo..."
  ENCODED=$(echo "$CALLER_CONTENT" | base64 -w0)
  gh api "repos/${ORG}/${repo}/contents/${WORKFLOW_FILE}" \
    --method PUT \
    --field message="ci: add dependabot auto-merge workflow" \
    --field content="$ENCODED" \
    && echo "   ✅ done" || echo "   ❌ failed"
done

echo ""
echo "Done."

# Issue → Run Promotion Cycle: Demonstration Guide

This guide shows how to test and observe the issues-as-queue pattern.

## Prerequisites

1. Merge PR #11 into the repository
2. Ensure the GitHub Actions runtime is configured
3. Set `RLM_MAX_CONCURRENT=1` to immediately trigger queuing

## Step 1: Initial State

Before triggering any agents, check the baseline:

```bash
# No queued issues
$ gh issue list --label rlm-task --state open
# (empty)

# No active runs
$ gh run list --status in_progress,queued
# (empty)
```

## Step 2: Trigger a Spawn (Hits Ceiling)

When the fleet orchestrator receives a spawn request and the ceiling is hit:

```bash
# The runtime files an issue instead of dispatching a run
# Log output in the orchestrator:
[github-actions] Concurrency ceiling hit, filing queued issue
[github-actions] Filed queued issue #12
```

## Step 3: Verify Issue Filed

```bash
$ gh issue list --label rlm-task --state open
# TITLE                                          #STATE    #UPDATED
# [RLM Task] Fix the login bug                   open      2024-01-15

$ gh issue view 12 --json title,body,labels,createdAt
{
  "title": "[RLM Task] Fix the login bug",
  "labels": ["rlm-task"],
  "createdAt": "2024-01-15T10:30:00Z",
  "body": "<!-- rlm-queued: true -->\n\n```\nrlm-queued: true\nspawn-params:\n  prompt: |\n    Fix the login bug\n  model: claude-3-5-sonnet\n  name: login-fix\n  depth: 0\n  parent-agent-id: \n  work-dir: .rlm/sessions/fleet/abc-123\n  agent-id: abc-123\n\nqueued-at: 2024-01-15T10:30:00Z\n```"
}
```

## Step 4: Wait for Queue Promoter

The `queue-promoter.yml` workflow runs every 5 minutes. Check:

```bash
# View recent workflow runs
$ gh run list --workflow queue-promoter.yml --limit 5
# STATUS   NAME           BRANCH         EVENT    started
# success  Queue Promoter rl/issues-as-queue schedule   2024-01-15T10:35:00Z

# View the promotion log
$ gh run view <run-id> --log
[promote] Current active runs: 0 (max: 1)
[promote] Found queued issue: #12
[promote] Dispatched promotion for issue #12
```

Or trigger manually:

```bash
$ gh workflow run queue-promoter.yml
# Queued promoter run

$ gh run watch <run-id>
# ... watching ...
# ✓ Dispatched promotion for issue #12
```

## Step 5: Verify Issue Comment

```bash
$ gh issue view 12 --json comments
{
  "comments": [
    {
      "body": "Promoting to workflow run. Will dispatch shortly.",
      "createdAt": "2024-01-15T10:35:01Z"
    }
  ]
}
```

## Step 6: Verify Workflow Run Triggered

```bash
$ gh run list --status in_progress,queued
# STATUS       NAME          BRANCH         EVENT              started
# in_progress  Prime Agent   main           repository_dispatch 2024-01-15T10:35:05Z
```

## Step 7: Wait for Run Completion

```bash
$ gh run watch <run-id>
# ... watching ...
# ✓ Run completed: success
```

## Step 8: Verify Issue Closed with Run Link

```bash
$ gh issue view 12 --json state,comments
{
  "state": "closed",
  "comments": [
    {
      "body": "Promoting to workflow run. Will dispatch shortly.",
      "createdAt": "2024-01-15T10:35:01Z"
    },
    {
      "body": "Run completed: [#42](https://github.com/owner/repo/actions/runs/42)",
      "createdAt": "2024-01-15T11:00:00Z"
    }
  ]
}
```

## Run → Issue Linking (Both Directions)

1. **Issue → Run**: The queue promoter comments on the issue when dispatching
2. **Run → Issue**: The workflow posts a comment with the run URL and closes the issue

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RLM_MAX_CONCURRENT` | `10` | Max concurrent runs before queuing |
| `RLM_QUEUE_LABEL` | `rlm-task` | Label for queued issues |

Set via repository variables:
```bash
gh variable set RLM_MAX_CONCURRENT --body 1
gh variable set RLM_QUEUE_LABEL --body rlm-task
```

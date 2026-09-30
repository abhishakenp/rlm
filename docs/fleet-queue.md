---
title: GitHub Actions Queue — Issues-as-Queue Pattern
---

# Overview

When the fleet's GitHub Actions runtime would exceed its concurrency ceiling, agent spawn requests are queued by filing a GitHub Issue labeled `rlm-task` instead of immediately dispatching a workflow run. A periodic workflow (`queue-promoter.yml`) polls for queued issues and promotes them to runs as slots free up.

This pattern provides:
- Native observability: issues appear in GitHub's UI, search, and notification system
- Automatic backpressure without custom infrastructure
- Run-to-issue linking for traceability
- Persistence: queued tasks survive runtime restarts

# Design

## Why Issues, Not a Database?

GitHub Issues provide built-in:
- Labels and milestones
- Search and filter
- Notifications
- Webhooks for state changes
- REST and GraphQL APIs
- UI with full history

A custom database or queue service adds operational complexity. For most fleet sizes (dozens of concurrent agents), GitHub Issues provide sufficient throughput and better UX.

## Workflow Architecture

```
Fleet Orchestrator
  1. spawn(request)
  2. checkConcurrencyCeiling()
  3a. Slots available -> triggerWorkflow() -> return identity
  3b. Ceiling hit -> fileQueuedIssue() -> return queued identity
```

Scheduled: every 5 min
```
queue-promoter.yml (scheduled workflow)
  1. List open issues with label: rlm-task
  2. Count active workflow runs
  3. If active < ceiling and queue not empty:
     a. Get oldest queued issue
     b. Extract spawn params from issue body
     c. Call repository_dispatch event with type: rlm-promote
     d. Close issue and note the triggered run
```

repository_dispatch event:
```
prime-agent.yml (dispatch workflow)
  1. On workflow_dispatch or repository_dispatch
  2. If promoted: read issue body for spawn params
  3. Run the agent bundle
  4. On completion: close linked issue with run URL
```

## Issue Structure

Queued issues have this format:

Title: [RLM Task] {agent label}

Body:
```
rlm-queued: true
spawn-params:
  prompt: |
    {the full prompt}
  model: {model name}
  name: {agent name}
  depth: {depth}
  parent-agent-id: {parent UUID}
  work-dir: {session directory}

queued-at: {ISO timestamp}
```

## Run-to-Issue Linking

- **Issue -> Run**: When promoted, the workflow run number is added as a comment to the issue
- **Run -> Issue**: Workflow run includes INPUT_ISSUE_NUMBER env var; on completion, posts a comment with the run URL and closes the issue

## Concurrency Management

The ceiling is configurable via RLM_MAX_CONCURRENT env var (default: 10). The queue-promoter counts:
- Workflow runs with status queued or in_progress
- Does not count completed, cancelled, or action_required

# Workflow Choice: Separate File vs. YAML Extension

**Decision**: Separate workflow file (queue-promoter.yml).

Rationale:
- The prime-agent.yml workflow is generated dynamically per spawn (agent-specific prompts)
- The promoter workflow is static configuration, not derived from spawn params
- Mixing them would require complex merging logic
- Two separate files is simpler to reason about and test independently
- The promoter workflow's workflow_dispatch trigger allows manual promotion for debugging

## Alternative: Generated YAML Extension

Could extend the generated prime-agent.yml with:
```yaml
on:
  workflow_dispatch:
  repository_dispatch:
    types: [rlm-promote]
  schedule:
    - cron: '*/5 * * * *'
```

Tradeoff: Requires modifying the generated YAML on every spawn, complicates the template logic. The separate file approach keeps concerns separated.

# Implementation

## Files

| File | Purpose |
|------|---------|
| docs/fleet-queue.md | This design document |
| packages/coding-agent/src/plugins/runtimes/github-actions-runtime.ts | Queue logic when ceiling is hit |
| .github/workflows/queue-promoter.yml | Scheduled promoter workflow |
| .github/workflows/prime-agent.yml | Agent execution workflow (modified) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| RLM_MAX_CONCURRENT | 10 | Maximum concurrent workflow runs |
| RLM_QUEUE_LABEL | rlm-task | Label for queued issues |
| RLM_PROMOTE_CRON | */5 * * * * | Cron schedule for promoter |

# Edge Cases

1. **Issue filed but slot frees before promoter runs**: The promoter will find the issue and dispatch
2. **Promoter runs while spawn is mid-dispatch**: Idempotent - checks if run already triggered
3. **Spawn during promoter execution**: New issue gets queued; promoter will process on next cycle
4. **Agent run fails**: Issue is closed with error comment; no re-queue (user can re-trigger)
5. **Network failure during issue filing**: Retry with exponential backoff; log error if persistent

# Monitoring

Query queued issues:
```bash
gh issue list --label rlm-task --state open --limit 100
```

Query active runs:
```bash
gh run list --status in_progress,queued --limit 100
```

Combined observability via GitHub's built-in dashboard for Issues and Actions.

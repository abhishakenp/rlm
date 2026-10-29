# Fleet Queue: Issues-as-Queue Design

## Overview

When fleet admission would exceed a concurrency ceiling, the system files a GitHub Issue labeled `rlm-task` instead of dispatching a run immediately. A periodic GitHub Actions workflow promotes queued issues to dispatched runs as slots free up, closing the issue when the run completes and establishing a bidirectional link between the run and the issue.

## Design Principles

1. **Backpressure via Issues**: Use GitHub Issues as the natural queue for pending work
2. **Atomic Admission Check**: Before spawning, check concurrency limit; if exceeded, queue
3. **Workflow-Driven Promotion**: A scheduled workflow monitors the queue and promotes issues
4. **Bidirectional Linking**: Run execution metadata links back to the originating issue
5. **Automatic Cleanup**: Issues are closed automatically when their associated run completes

## Architecture

### Components

1. **Queue Admission Module** (`fleet-queue.ts`): Core logic for checking limits and filing issues
2. **GitHub Issue Handler** (`issue-handler.ts`): Functions to create/update/close issues
3. **Workflow File** (`.github/workflows/fleet-queue-promoter.yml`): Scheduled workflow for promotion
4. **Run Metadata** (`run-metadata.json`): File written at runtime linking run to issue

### Concurrency Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Fleet Admission Flow                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Request ──► Check Concurrency ──► Within Limit?                    │
│                 │                          │                        │
│                 │ Yes                      │ No                    │
│                 ▼                          ▼                        │
│           Spawn Run                  File GitHub Issue              │
│           (normal)                   labeled rlm-task                │
│                 │                          │                        │
│                 └──────────┬────────────────┘                       │
│                            ▼                                        │
│                    Queue (Issues)                                   │
│                            │                                        │
│                            ▼                                        │
│              ┌───────────────────────────────┐                      │
│              │  Scheduled Workflow (5 min)   │                      │
│              │  1. Count active runs          │                      │
│              │  2. Find queued issues        │                      │
│              │  3. If slot available → spawn  │                      │
│              │  4. Update issue state        │                      │
│              └───────────────────────────────┘                      │
│                            │                                        │
│                            ▼                                        │
│              ┌───────────────────────────────┐                      │
│              │        Run Completes          │                      │
│              │  → Write run-metadata.json    │                      │
│              │  → Close issue with link      │                      │
│              └───────────────────────────────┘                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Details

### 1. Queue Admission Module

```typescript
// fleet-queue.ts - Core admission logic
interface QueueConfig {
  maxConcurrency: number;       // Maximum parallel runs
  queueLabel: string;          // GitHub label for queued issues: "rlm-task"
  repoOwner: string;          // Repository owner
  repoName: string;           // Repository name
  githubToken: string;        // GitHub API token
}

interface QueueEntry {
  issueNumber: number;
  taskPrompt: string;
  createdAt: Date;
  assignedRunId?: string;
}

// checkAndAdmit: Returns { admitted: true, runId } or { admitted: false, issueNumber }
async function checkAndAdmit(
  config: QueueConfig,
  activeRunCount: number,
  taskPrompt: string
): Promise<{ admitted: boolean; runId?: string; issueNumber?: number }>

// onRunComplete: Updates issue with run metadata and closes it
async function onRunComplete(
  config: QueueConfig,
  runId: string,
  issueNumber: number,
  runMetadata: RunMetadata
): Promise<void>
```

### 2. GitHub Issue Handler

```typescript
// issue-handler.ts - Issue management functions

// Create a queued task issue
async function createQueueIssue(
  config: QueueConfig,
  taskPrompt: string
): Promise<number>  // Returns issue number

// Get all queued issues (open issues with queue label)
async function getQueuedIssues(
  config: QueueConfig
): Promise<QueueIssue[]>

// Update issue state (mark as in-progress, etc.)
async function updateIssueState(
  config: QueueConfig,
  issueNumber: number,
  state: IssueState
): Promise<void>

// Close issue with completion message and run link
async function closeQueueIssue(
  config: QueueConfig,
  issueNumber: number,
  runId: string,
  runUrl: string
): Promise<void>

// Add comment to issue with run details
async function addIssueComment(
  config: QueueConfig,
  issueNumber: number,
  comment: string
): Promise<void>
```

### 3. Run Metadata

Each dispatched run writes a `run-metadata.json` file:

```json
{
  "runId": "run-20240101-abc123",
  "issueNumber": 42,
  "issueUrl": "https://github.com/owner/repo/issues/42",
  "dispatchedAt": "2024-01-01T12:00:00Z",
  "completedAt": "2024-01-01T12:30:00Z",
  "status": "success",
  "repoUrl": "https://github.com/owner/repo"
}
```

### 4. Scheduled Workflow

File: `.github/workflows/fleet-queue-promoter.yml`

Trigger: `schedule: "*/5 * * * *"` (every 5 minutes)

```yaml
name: Fleet Queue Promoter

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:  # Manual trigger support

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - name: Get active run count
        run: |
          # Count runs from fleet-admission API or stored state
          echo "ACTIVE_RUNS=${{ vars.FLEET_ACTIVE_RUNS }}" >> $GITHUB_ENV

      - name: Check queue and promote
        run: |
          # Query open rlm-task issues
          # If ACTIVE_RUNS < maxConcurrency, dispatch next issue
          # Update issue state to in-progress
          # Decrement active run count
```

## Workflow Justification

**Choice: Second workflow file (`.github/workflows/fleet-queue-promoter.yml`)**

Rationale:
1. **Separation of Concerns**: The queue promotion logic is distinct from the main admission workflow
2. **Independent Trigger**: Runs on a schedule independently of the main admission event
3. **Maintainability**: Clear separation makes each workflow easier to understand and modify
4. **No Coupling**: Main admission workflow doesn't need to know about scheduling details
5. **Scalability**: Can be extended to multiple promotion strategies without cluttering main workflow

Alternative considered: Extend the generated/main workflow YAML
- Rejected because: schedule triggers can't be conditionally added to workflow files; mixing concerns increases complexity

## Issue Lifecycle

```
┌─────────────┐
│   Created   │  (when concurrency exceeded)
│  labeled    │
│  rlm-task   │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌─────────────────────┐
│   Waiting   │────►│   In Progress       │  (workflow promotes)
│   (open)    │     │   (dispatched run) │
└─────────────┘     └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │    Completed       │
                    │  (issue closed,    │
                    │   run linked)      │
                    └─────────────────────┘
```

## GitHub Labels

- `rlm-task`: Applied to all queued/pending task issues
- `rlm-in-progress`: Applied when issue is promoted to active run
- `rlm-completed`: Applied when associated run finishes (then issue is closed)

## State Machine

### Issue States

| State | Label | Condition |
|-------|-------|-----------|
| Queued | `rlm-task` | Created when concurrency exceeded |
| Promoted | `rlm-task`, `rlm-in-progress` | Workflow dispatched run |
| Completed | closed | Run finished, issue linked |

### API Interactions

```typescript
// All GitHub API calls via @actions/github

// Create issue
POST /repos/{owner}/{repo}/issues
{ title, body, labels: ["rlm-task"] }

// List issues
GET /repos/{owner}/{repo}/issues?labels=rlm-task&state=open

// Update issue
PATCH /repos/{owner}/{repo}/issues/{issue_number}
{ labels: ["rlm-task", "rlm-in-progress"] }

// Close issue  
PATCH /repos/{owner}/{repo}/issues/{issue_number}
{ state: "closed", body: "..." }

// Add comment
POST /repos/{owner}/{repo}/issues/{issue_number}/comments
{ body: "..." }
```

## Error Handling

1. **Workflow Failure**: If promotion fails, issue remains in queue; next cycle retries
2. **Run Failure**: Close issue with failure status and error details
3. **GitHub API Limits**: Implement exponential backoff with max retries
4. **Concurrent Promotion**: Use GitHub's compare-and-swap patterns to prevent double-promotion

## Configuration

```yaml
# .github/workflows/fleet-queue-promoter.yml configuration

env:
  FLEET_MAX_CONCURRENCY: 10  # From repo secrets/vars
  QUEUE_LABEL: rlm-task
```

## Testing Strategy

1. **Unit Tests**: Test queue admission logic with mocked GitHub API
2. **Integration Tests**: Full cycle with test repository
3. **Demonstration**: Show issue→run promotion cycle with `gh` CLI

## Future Enhancements

- Priority levels for queued tasks
- Timeout handling for stalled runs
- Webhook-based completion notification
- Metrics collection for queue depth and wait times

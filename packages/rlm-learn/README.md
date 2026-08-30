# @rlm/learn

Self-evolution plugin — learns from workflow outcomes and feeds learnings into the system prompt.

## Overview

Listens to `rlm/workflow-*` events from `@rlm/workflow` and records every workflow run (name, input, result, duration, success) to `~/.rlm/agent/workflows/learnings.jsonl`. Also captures delegator review scores and input classifications. After N runs, reflects via LLM to identify success/failure patterns and proposes workflow modifications. Proposals are written to `proposals/` for operator review — approval moves them to `workflows/` where HMR picks them up automatically. Registers a prompt fragment at priority 5 so the agent sees past failures and avoids repeating them.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `learningsDir` | `string` | `~/.rlm/agent/workflows` | Directory for `learnings.jsonl` |
| `proposalsDir` | `string` | `~/.rlm/agent/workflows/proposals` | Directory for proposal files |
| `reflectInterval` | `number` | `60000` | Reflection check interval (ms) |
| `maxLearningsBeforeReflect` | `number` | `10` | Min runs before triggering reflection |

## Dependencies

- `@rlm/sdk` (`rlmSdk`) — resolved at runtime for LLM-based reflection
- `@rlm/workflow` (`rlmWorkflow`) — listens to its events; calls `reload()` on proposal approval
- `@rlm/prompt` — registers past-learnings prompt fragment (optional, degrades gracefully)

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `readLearnings()` | `LearningEntry[]` | All recorded learnings from JSONL |
| `reflect()` | `Promise<Reflection>` | LLM-powered reflection on accumulated learnings |
| `listProposals()` | `string[]` | Pending proposal filenames in `proposals/` |
| `approveProposal(filename, workflowName)` | `void` | Move proposal to `workflows/` + trigger HMR reload |
| `stats()` | `object` | Aggregate stats: total, successes, failures, successRate, avgReviewScore, proposals |
| `buildLearningsPrompt()` | `string \| undefined` | Concise prompt fragment from recent failures/reflections |

Events listened to: `rlm/workflow-start`, `rlm/workflow-complete`, `rlm/workflow-error`, `rlm/delegator-review`, `rlm/delegator-classified`.
Events emitted: `rlm/learn-reflection`, `rlm/learn-proposal-approved`.

## Usage

```ts
const learn = ctx.get("rlmLearn");

// Check stats
const s = learn.stats();
console.log(s);
// { total: 42, successes: 38, failures: 4, successRate: 0.90, avgReviewScore: 4.2, proposals: 2 }

// Trigger reflection manually
const reflection = await learn.reflect();
console.log(reflection.patterns);   // ["parallel spawning improves throughput", ...]
console.log(reflection.proposals);  // ["Add retry logic to executor workflow", ...]

// Review and approve proposals
const proposals = learn.listProposals();
// ["proposal-1700000000-abc123.md", "proposal-1700000100-def456.md"]

learn.approveProposal("proposal-1700000000-abc123.md", "delegator");
// → moves to workflows/delegator.ts → HMR auto-reloads
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. The reflection timer is cleared on dispose. The prompt fragment handle is disposed and re-registered on restart. Learnings JSONL and proposal files persist on disk across hot-swaps. The reflection timer uses `.unref()` so it never keeps the process alive.

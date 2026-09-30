---
name: wayfinder
description: Plan a large effort as a shared map of decision tickets on GitHub issues, resolve them until the route is clear.
disable-model-invocation: true
---

# Wayfinder Workflow

Find the way to a destination too large for one session, as a map of decision tickets on GitHub Issues.

## What it is

A **map** is a GitHub issue with label `wayfinder:map` on abhishakenp/prime-agent-runs. Its child issues are **tickets** — questions whose answers are decisions, not deliverables.

The **frontier** is the next takeable tickets: open, unblocked, unclaimed.

## How to invoke

Use the wayfinder workflow via the code kernel:

```js
// Chart a new map
result = await rlm_workflow.run("wayfinder", "chart Implement OAuth refresh flow")

// Work the map (picks next frontier ticket)
result = await rlm_workflow.run("wayfinder", "work 42")

// Work a specific ticket
result = await rlm_workflow.run("wayfinder", "work 42 43")

// Claim a ticket
result = await rlm_workflow.run("wayfinder", "claim 43")

// Resolve a ticket with decision
result = await rlm_workflow.run("wayfinder", "resolve 43 Decided to use PKCE with 15min refresh tokens")
```

## Ticket types

| Label | Type | Description |
|-------|------|-------------|
| `wayfinder:research` | AFK | Reading docs, APIs, resources |
| `wayfinder:prototype` | HITL | Make a concrete artifact to react to |
| `wayfinder:grilling` | HITL | Conversation with human |
| `wayfinder:task` | HITL/AFK | Manual work that unblocks a decision |

## Blocking

Tickets reference blockers in body: `Blocked by: #N`

## Fleet bridge

For `wayfinder:task` tickets that say "build X", the workflow spawns on GitHub Actions:

```js
// Fleet task spawned automatically when ticket body contains "build"
handle = await rlm.run(prompt, { host: "github-actions", env: { GH_TOKEN } })
```

## Source

See `packages/rlm-workflow/src/workflows/wayfinder.ts` for full implementation.

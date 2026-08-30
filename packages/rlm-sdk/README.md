# @rlm/sdk

TypeScript SDK for in-process subagent spawning and goal management.

## Overview

Cordis service that wraps `createAgentSession()` for recursive agent tree composition. Other plugins (workflow, learn) inject this service to spawn child agents, manage long-running goals, and transfer context variables atomically. Each child gets its own agent loop, tools, model, and session persistence. Registers a mandatory prompt doctrine at priority 80 instructing the agent to use `rlm.*` at every decomposable step and spawn independent tasks in parallel.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxDepth` | `number` | `10` | Maximum recursion depth for subagent spawning |
| `defaultModel` | `string` | `undefined` | Default model for child agents if not specified per-spawn |

## Dependencies

- `@rlm/code` (`rlmCode`) — resolved at runtime; child code tool connected to shared service
- `@rlm/context` (`rlmContext`) — resolved at runtime for context copy/move transfer
- `@rlm/prompt` — registers SDK doctrine prompt fragment (optional, retries on load)

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `run(prompt, opts?)` | `Promise<SubagentHandle>` | Spawn a child agent, return handle (await for result) |
| `spawn(prompt, opts?)` | `Promise<string>` | Spawn and await the result string directly |
| `listSubagents()` | `SubagentInfo[]` | List active + completed children |
| `deleteSubagent(target)` | `Promise<SubagentHandle \| null>` | Dispose a child by id or name |
| `cancelAll()` | `void` | Cancel all active children |
| `goal.create(objective, opts?)` | `GoalInfo` | Create a long-running goal |
| `goal.get()` | `GoalInfo` | Get current goal state |
| `goal.complete()` | `void` | Mark goal as complete |
| `goal.pause()` | `void` | Pause the current goal |

`SpawnOptions`: `{ name?, model?, thinking?, cwd?, depth?, context?, contextMove?, contextStrategy? }`

Events emitted: `rlm/sdk-spawn`, `rlm/sdk-complete`, `rlm/sdk-error`, `rlm/sdk-context-copy`, `rlm/sdk-context-move`, `rlm/goal-create`, `rlm/goal-complete`.

## Usage

```ts
const sdk = ctx.get("rlmSdk");

// Spawn and await result
const result = await sdk.spawn("Analyze auth patterns in this codebase", {
  name: "auth-analyzer",
  model: "omniroute/auto",
});

// Spawn without awaiting (returns handle immediately)
const handle = await sdk.run("Research competitor APIs", { name: "researcher" });
// ... do other work ...
// handle.result is populated when status === "completed"

// Parallel spawning — spawn all, then wait
const h1 = sdk.run("Research auth", { name: "auth-research" });
const h2 = sdk.run("Research db", { name: "db-research" });
const h3 = sdk.run("Research api", { name: "api-research" });
const [r1, r2, r3] = await Promise.all([h1, h2, h3]);

// Context transfer — copy (non-destructive)
await sdk.run("Audit auth files", {
  name: "auditor",
  context: ["auth.*", "project.*"],
});

// Context transfer — move (destructive, parent loses vars)
await sdk.run("Offload auth context", {
  name: "auth-worker",
  contextMove: ["auth.*"],
});

// Goal management
sdk.goal.create("Build complete auth system", { tokenBudget: 100000 });
console.log(sdk.goal.get()); // { objective, status: "active", tokensUsed, ... }
sdk.goal.complete();

// List and clean up
console.log(sdk.listSubagents());
await sdk.deleteSubagent("researcher");
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. The prompt doctrine fragment is disposed and re-registered on restart. All active child sessions are cancelled on `[Symbol.dispose]()` via `cancelAll()`. The `createAgentSession` function is re-imported on restart. Child sessions in progress are disposed; completed results in the `children` map are cleared.

# @rlm/workflow

Hot-swappable TS workflow orchestrator with file-watching HMR.

## Overview

Loads workflow definitions from `~/.rlm/agent/workflows/*.ts` (or `.js`/`.mjs`), hot-reloads them on file change via Node's built-in `fs.watch`, and exposes them through the Cordis service container. Workflows compose recursive agent trees using `@rlm/sdk` — spawning subagents, managing goals, and coordinating plan → exec → review → test loops. Active work is never interrupted on reload; only the workflow definition is swapped.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workflowsDir` | `string` | `~/.rlm/agent/workflows` | Directory containing workflow files |

## Dependencies

- `@rlm/sdk` (`rlmSdk`) — resolved at runtime via `ctx.get("rlmSdk")` for subagent spawning and goal management

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `getWorkflow(name)` | `Workflow \| undefined` | Get a loaded workflow by name |
| `listWorkflows()` | `string[]` | List all loaded workflow names |
| `run(name, input)` | `Promise<string>` | Execute a workflow by name with input |
| `reload(name)` | `Promise<void>` | Manually reload a specific workflow file |

Events emitted: `rlm/workflow-loaded`, `rlm/workflow-removed`, `rlm/workflow-start`, `rlm/workflow-complete`, `rlm/workflow-error`.

## Usage

```ts
// Define a workflow file at ~/.rlm/agent/workflows/delegator.ts:
export default define((api) => ({
  name: "delegator",
  async run(input: string) {
    const plan = await api.sdk.spawn("Decompose: " + input, { name: "planner" });
    const exec = await api.sdk.spawn("Execute: " + plan, { name: "executor" });
    const review = await api.sdk.spawn("Review: " + exec, { name: "reviewer" });
    return review;
  }
}));

// Run it:
const wf = ctx.get("rlmWorkflow");
const result = await wf.run("delegator", "build auth system");
console.log(result);

// List loaded workflows:
console.log(wf.listWorkflows()); // ["delegator", "researcher", ...]

// Manual reload after editing:
await wf.reload("delegator");
```

## Hot-Swap

Two levels of hot-swap:
1. **Workflow files**: `fs.watch` detects changes to any `.ts`/`.js`/`.mjs` file in the workflows directory → old workflow is disposed, new one imported with cache-busting (`?t=Date.now()`). Active runs are never interrupted — only the definition swaps.
2. **Plugin itself**: editing `index.ts` triggers `fiber.restart()` → the watcher is closed, workflows cleared, and reloaded fresh on restart.

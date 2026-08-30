# @rlm/context

Persistent typed variable registry for agent working memory.

## Overview

Implements the "everything is a variable" philosophy: the user prompt, skills, system prompt, and model config are all inspectable, transferable, and mutable context variables. Three scopes (project, session, task) with `const`/`let` semantics. Supports copy/move for transferring variables to subagents. Registers a mandatory prompt doctrine fragment so the agent uses context automatically at every step.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `projectRoot` | `string` | `process.cwd()` | Root for `.rlm/context.json` persistence |
| `enableClone` | `boolean` | `true` | Gate `clone` / `cloneMany` operations |
| `enableMutate` | `boolean` | `true` | Gate `mutate` / `mutateMany` operations |
| `enableBulkOps` | `boolean` | `true` | Gate `cloneMany` / `mutateMany` / `batch` / `copy-many` |
| `enableSubagentTransfer` | `boolean` | `true` | Gate `copy` / `move` transfer to subagents |
| `showContextPanel` | `boolean` | `true` | Render context panel in TUI |
| `coloredBars` | `boolean` | `true` | Color-code scope bars in TUI |
| `perVariableExpand` | `boolean` | `true` | Allow per-variable expand/collapse in TUI |

## Dependencies

- `@rlm/tui` — registers inline context panel component (optional, degrades gracefully)
- `@rlm/prompt` — registers context doctrine prompt fragment (optional, retries on load)

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `set(name, value, opts)` | `void` | Create a variable (default scope: session) |
| `get(name)` | `any` | Read a variable's value |
| `update(name, value)` | `void` | Update a `let` (mutable) variable |
| `mutate(name, fn)` | `void` | Mutate via `fn(oldValue) => newValue` |
| `mutateMany(pattern, fn)` | `void` | Mutate all glob-matching mutable vars |
| `clone(name, newName, opts?)` | `void` | Deep-copy single var to new name |
| `cloneMany(patterns, prefixOrTransform?)` | `void` | Clone many vars with prefix or transform |
| `list(pattern)` | `string[]` | List variable names matching a glob |
| `copy(patterns)` / `snapshot(patterns)` | `ContextSnapshot` | Non-destructive snapshot for subagents |
| `move(patterns)` | `ContextSnapshot` | Destructive transfer (deletes from this scope) |
| `delete(name)` | `void` | Remove a variable |
| `clear(scope, force?)` | `void` | Clear an entire scope |
| `batch(ops)` | `void` | Atomic batch of set/mutate/clone operations |
| `summarize()` | `string` | Formatted summary of all variables |
| `meta(name)` | `ContextVariable` | Full metadata for a variable |
| `all()` | `ContextVariable[]` | All variables across scopes |
| `getEpoch()` | `number` | Mutation counter (cache invalidation) |

## Usage

```ts
// In the code kernel (rlm-code sandbox):
context.set("user.prompt", "list packages", { mutable: false });
context.set("files.packages", dirs, { description: "Package directories" });

// Reuse — don't re-run
const prev = context.get("files.packages");
const rlmDirs = prev.filter(d => d.startsWith("rlm-"));
context.set("files.rlm-packages", rlmDirs);

// Power operations
context.clone("files.packages", "files.packages.bak");
context.cloneMany(["files.*"], "backup.files.");
context.mutate("files.rlm-packages", v => [...v, "rlm-new"]);
context.mutateMany("files.*", v => Array.isArray(v) ? [...v].sort() : v);

// Transfer to subagent (copy vs move)
await rlm.run("audit packages", { context: ["files.*", "backup.*"] });
await rlm.run("offload auth", { contextMove: ["auth.*"] });
```

## Hot-Swap

Part of the Cordis plugin system. On `fiber.restart()`, the TUI component handle and prompt fragment handle are disposed automatically. Project-scoped variables persist to `.rlm/context.json` and reload on restart. Session and task scopes are in-memory and lost on hot-swap. The epoch counter resets, triggering a prompt re-invalidation.

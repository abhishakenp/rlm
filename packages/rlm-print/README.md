# @rlm/print

Print mode (single-shot) as a Cordis Service.

## Overview

Wraps `runPrintMode` behind a service. Creates the full agent runtime via `@rlm/agent`, then runs print mode — sends a prompt, outputs the result, and exits. No fallbacks. Used for `--print` / `-p` CLI flag execution where a single prompt is processed without launching the interactive TUI.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cwd` | `string` | `process.cwd()` | Working directory passed to the agent runtime |

## Dependencies

- `@rlm/agent` (`rlmAgent`) — provides `createRuntime()` for the full agent runtime

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `run(options)` | `Promise<number>` | Create runtime, run print mode, return exit code |
| `stop()` | `Promise<void>` | Dispose the runtime |

`PrintModeOptions` is the coding-agent print mode options type (prompt, model, thinking level, etc.).

## Usage

```ts
const print = ctx.get("rlmPrint");

// Run a single-shot prompt
const exitCode = await print.run({
  prompt: "List all TypeScript files in the src directory",
  model: "omniroute/auto",
  thinking: "medium",
});

console.log(`Exited with code ${exitCode}`);

// Clean up
await print.stop();
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. The runtime is disposed on `stop()` or `[Symbol.dispose]()`. Since print mode is single-shot, hot-swap typically applies between runs — the next `run()` call creates a fresh runtime with the updated plugin code.

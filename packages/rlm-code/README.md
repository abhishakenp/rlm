# @rlm/code

Persistent JS code execution tool with kernel-style syntax.

## Overview

Replaces kernel + bash + edit with a single persistent JS execution tool. Uses a `vm.Context` sandbox where variables persist across calls. Supports `!command` line magic for shell-out and `%%bash` cell magic for multi-line shell blocks. Exposes Node builtins (fs, path, os, exec, fetch, import, require) and a lazy `rlm` proxy for subagent spawning. Captures `console.log` as stdout and the last expression value as result — same shape as a kernel `ExecuteResult`.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `30000` | Execution timeout in milliseconds |
| `cwd` | `string` | `process.cwd()` | Working directory exposed as `cwd` in sandbox |
| `maxOutputChars` | `number` | `65536` | Max stdout/stderr chars before truncation |

## Dependencies

None (standalone). Optionally resolves `rlmSdk` at runtime via `ctx.get("rlmSdk")` for the `rlm` proxy — works even if SDK loads after Code.

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `execute(code)` | `Promise<CodeResult>` | Execute JS code in persistent context |
| `get(name)` | `any` | Read a variable from the persistent context |
| `set(name, value)` | `void` | Set a variable in the persistent context |
| `vars()` | `string[]` | List user-defined variables (excludes builtins) |
| `resetContext()` | `void` | Recreate a fresh vm context |

`CodeResult`: `{ stdout, stderr, result?, status, error?, durationMs }`

## Usage

```ts
const code = ctx.get("rlmCode");

// Execute JS — variables persist across calls
const r1 = await code.execute("var x = 42; x * 2");
console.log(r1.result); // "84"

const r2 = await code.execute("x + 8");
console.log(r2.result); // "50" — x persisted

// Shell via ! line magic
const r3 = await code.execute("!ls -la packages/");
console.log(r3.stdout);

// Multi-line shell via %%bash cell magic
const r4 = await code.execute("%%bash\necho hello\necho world");
console.log(r4.stdout); // "hello\nworld\n"

// Top-level await
const r5 = await code.execute("await fetch('https://api.github.com').then(r => r.status)");
console.log(r5.result); // "200"

// Spawn subagents via rlm proxy
const r6 = await code.execute("await rlm.spawn('list files in packages/', { name: 'lister' })");
console.log(r6.result);
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. The vm context is disposed on `[Symbol.dispose]()` and recreated on next init. Variables do NOT persist across hot-swaps — the context is reset. The `rlm` proxy resolves dynamically so it always points to the latest SDK instance regardless of load order.

<div align="center">

# rlm

**Self-evolving terminal agent — JavaScript-native, Cordis plugin architecture, HMR hot-swap.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.8-brightgreen.svg)](https://nodejs.org)
[![Cordis](https://img.shields.io/badge/Cordis-%E2%89%A54.0-purple.svg)](https://www.npmjs.com/package/@deepseek-ai/cordis)
[![Language](https://img.shields.io/badge/lang-TypeScript-orange.svg)](https://www.typescriptlang.org)
[![Package Manager](https://img.shields.io/badge/pkg-bun-f472b6.svg)](https://bun.sh)

</div>

rlm takes the ideas you already love from prime-agent — recursive subagents, persistent memory, self-evolution — and rebuilds them for people who live in the terminal. The host is tiny. Everything else is a plugin. You can hot-swap any of them while rlm is running and it just keeps going.

Everything is a Cordis micro-plugin. Each feature has its own config flag. All flags are `true` by default so it works out of the box — turn off what you don't want, keep the rest.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Plugin Reference](#plugin-reference)
- [Context Registry](#context-registry)
- [Self-Learning](#self-learning)
- [Recursive Subagents](#recursive-subagents)
- [HMR (Hot Module Replacement)](#hmr-hot-module-replacement)
- [Shell Access](#shell-access)
- [Workflows](#workflows)
- [Development](#development)
- [License](#license)

---

## Overview

rlm is a **prime-agent in JavaScript**. It takes the behavioral concepts of prime-agent — recursive subagents, persistent memory, self-evolution, refinement — and rebuilds them as a terminal-native agent with no Python dependency.

### Philosophy

- **Prime-agent in JS** — Everything the AI has is a variable. The user prompt is a const variable. Skills are variables. The system prompt is a variable. The model config is a variable. Everything is inspectable, transferable, and mutable (or immutable).
- **Cordis architecture** — The host (`cordis-shell.mjs`) owns almost nothing. It boots a Cordis Context, installs Loader + Include plugins, watches source dirs for HMR, loads plugins from `cordis.yml`, then runs the TUI or print mode. Every capability is a Cordis `Service` plugin.
- **Self-evolving** — The agent tracks its own outcomes, learns from patterns, proposes workflow modifications, and refines its own harness. No restart needed — every plugin, config, skill, and system prompt is hot-swappable.
- **No AGENTS.md duplication** — Plugins register their doctrine directly into the system prompt via `rlm-prompt`. One source of truth, always in sync.
- **Foreground-only** — No daemon. No background process. Everything runs in-process. Exits when the terminal closes.

---

## Features

### Agent

- JavaScript-native agent loop (LLM → tool dispatch → response)
- Persistent JS code execution via `vm.Context` (no Python, no IPython, no kernel process)
- Tool registry with `code` and `edit` tools
- Session persistence (JSONL)
- Model registry with OmniRoute support

### Plugins

- 14 Cordis plugins in 4 layers (Foundation → Core → Agent → Presentation)
- Every plugin independently testable and hot-swappable
- Micro-plugin config flags — all `true` by default, toggle without touching code
- Plugin composition via `cordis.yml` (YAML, hot-reloadable)

### HMR

- Hot-swap any plugin source while running — no restart
- Config file changes trigger `Include.refresh()` (transactional entry update)
- Plugin source changes trigger `fiber.restart()` (dispose old, re-import new)
- Active work is **never** interrupted — old fiber finishes, new fiber serves next turn
- System prompt rebuilds automatically on prompt/skill/refinement changes

### Self-Learning

- Auto-refine on repeated tool errors (shell-as-JS, Python-in-JS, top-level return)
- Learn plugin tracks workflow outcomes, identifies patterns, proposes modifications
- Reflection loop — LLM analyzes accumulated learnings, extracts success/failure patterns
- Proposals written for operator review → approve → HMR picks up the new workflow
- Past learnings fed into system prompt so mistakes aren't repeated

### Context

- Persistent typed variable registry — the agent's working memory
- `const` (immutable) / `let` (mutable) semantics
- 3 scopes: `project` (survives all sessions), `session` (one session), `task` (one subagent invocation)
- Copy / move / mutate / clone / batch operations (1 or many variables)
- Epoch-based cache invalidation — mutations auto-invalidate the next turn's prompt
- Elegant TUI panel with colored scope bars, per-variable expand, scroll, followup queue

### Subagents

- Recursive agent trees via `rlm.run()` / `rlm.spawn()`
- Depth limit (default 10) prevents infinite recursion
- Context transfer: copy (parent keeps) or move (destructive, parent loses)
- Parallel spawning — spawn all, then wait (never await sequentially in a loop)
- Goal management for long-running objectives

### TUI

- InteractiveMode with theme, syntax highlighting, code highlighter
- UiProvider override — full UI replacement via highest-priority provider
- Slash commands, status bar items, custom components (all registerable)
- Context panel with colored scope bars, focused navigation, auto-focus typing
- Followup queue — keep typing while agent is busy, double-Enter to send

### Shell

- `!command` — shell out (line magic, kernel-style)
- `%%bash` cell — multi-line shell block
- No separate bash tool — shell access is built into the code tool
- `fs`, `path`, `os`, `child_process`, `fetch`, `import()`, `require` all available

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         cordis-shell.mjs (HOST)                         │
│  Boots Cordis Context → Loader + Include → reads cordis.yml → HMR       │
│  Watches packages/*/src + config files. Foreground-only. No daemon.     │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ loads via cordis.yml
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  FOUNDATION LAYER (no dependencies)                                     │
│                                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                │
│  │  config  │  │ context  │  │   tui    │  │  prompt  │                │
│  │rlmConfig │  │rlmContext│  │  rlmTui  │  │rlmPrompt │                │
│  │settings, │  │typed var │  │UI ext +  │  │prompt    │                │
│  │models,   │  │registry  │  │providers │  │fragments │                │
│  │auth      │  │+ panel   │  │          │  │registry  │                │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘                │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ depends on
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  CORE LAYER (depends on foundation)                                     │
│                                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                │
│  │ session  │  │  tools   │  │  refine  │  │   code   │                │
│  │rlmSession│  │ rlmTools │  │rlmRefine │  │ rlmCode  │                │
│  │persist + │  │registry  │  │refine +  │  │JS exec + │                │
│  │manager   │  │(code,    │  │auto-     │  │shell +   │                │
│  │          │  │ edit)    │  │refine    │  │rlm SDK   │                │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘                │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐                            │
│  │    workflow      │  │      learn       │                            │
│  │   rlmWorkflow    │  │     rlmLearn     │                            │
│  │ hot-swap TS      │  │ self-evolution:  │                            │
│  │ workflows from   │  │ track outcomes,  │                            │
│  │ ~/.rlm/agent/    │  │ reflect, propose │                            │
│  │ workflows/       │  │ modifications    │                            │
│  └──────────────────┘  └──────────────────┘                            │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ depends on
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  AGENT LAYER (depends on core)                                          │
│                                                                         │
│  ┌──────────────────────────────────────────────────┐                   │
│  │                      agent                        │                  │
│  │                    rlmAgent                       │                  │
│  │  AgentSession runtime — LLM loop, tool dispatch, │                  │
│  │  subagent spawning, session services              │                  │
│  └──────────────────────────────────────────────────┘                   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ depends on
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER (depends on agent)                                  │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │
│  │    renderer      │  │      print       │  │       sdk        │      │
│  │   rlmRenderer    │  │     rlmPrint     │  │      rlmSdk      │      │
│  │ InteractiveMode  │  │ single-shot      │  │ in-process       │      │
│  │ TUI wrapper,     │  │ prompt → output  │  │ subagent spawn + │      │
│  │ event forwarding │  │ → exit           │  │ rlm.run/spawn    │      │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘      │
└─────────────────────────────────────────────────────────────────────────┘
```

**Dependency order:** `config → context/tui/prompt → session/tools/refine/code/workflow/learn → agent → renderer/print/sdk`

**HMR:** editing ANY plugin source triggers `fiber.restart()` on that plugin. Active work continues on old fiber; new work uses reloaded plugin.

---

## Quick Start

### Prerequisites

- Node.js >= 22.8.0
- [bun](https://bun.sh) (package manager)

### Install

```bash
# From source (dev mode with HMR on TS source)
git clone <repo-url> rlm
cd rlm
npm install -g .
```

### Configure

rlm uses OmniRoute for model access. Set up auth:

```bash
# Auth config lives at ~/.rlm/config.json or ~/.rlm/agent/auth.json
# Configure your provider and API key there
```

Default model: `auto/best-free` (configurable in `cordis.yml` and `~/.rlm/agent/settings.json`).

### Run

```bash
# Interactive TUI
rlm

# Print mode (one-shot, exit)
rlm -p "Say only the word OK"

# Pipe stdin (also print mode)
echo "List the packages in this repo" | rlm

# Verbose (show tool calls)
rlm --verbose

# Custom config
rlm --config /path/to/cordis.yml

# Help
rlm --help
```

---

## Configuration

### cordis.yml structure

Plugins are composed in `cordis.yml`. Each entry has an `id`, `name` (module path), and optional `config`. Every flag is optional — all features default on.

```yml
# cordis.yml (excerpt) — full file in repo root

# ─── Foundation ──────────────────────────────────────────────────────────
- id: config
  name: './packages/rlm-config/src/index.ts'
  config:
    cwd: .

- id: context
  name: './packages/rlm-context/src/index.ts'
  config:
    projectRoot: .
    # — UI micro-plugins (all true by default) —
    showContextPanel: true
    coloredBars: true
    perVariableExpand: true
    hjklNavigation: true
    autoFocusTyping: true
    doubleEnterToSend: true
    followupQueueUi: true
    scrollablePanel: true
    # — power micro-behaviours (all true by default) —
    enableClone: true
    enableMutate: true
    enableBulkOps: true
    enableSubagentTransfer: true

- id: tui
  name: './packages/rlm-tui/src/index.ts'

- id: prompt
  name: './packages/rlm-prompt/src/index.ts'

# ─── Core ────────────────────────────────────────────────────────────────
- id: session
  name: './packages/rlm-session/src/index.ts'

- id: tools
  name: './packages/rlm-tools/src/index.ts'
  config:
    timeout: 60000
    maxOutputChars: 65536

- id: refine
  name: './packages/rlm-refine/src/index.ts'

- id: code
  name: './packages/rlm-code/src/index.ts'
  config:
    timeout: 60000
    maxOutputChars: 65536

- id: workflow
  name: './packages/rlm-workflow/src/index.ts'
  config:
    workflowsDir: ~/.rlm/agent/workflows

- id: learn
  name: './packages/rlm-learn/src/index.ts'
  config:
    reflectInterval: 60000
    maxLearningsBeforeReflect: 10

# ─── Agent ───────────────────────────────────────────────────────────────
- id: agent
  name: './packages/rlm-agent/src/index.ts'
  config:
    cwd: .

# ─── Presentation ────────────────────────────────────────────────────────
- id: renderer
  name: './packages/rlm-tui-renderer/src/index.ts'
  config:
    cwd: .

- id: print
  name: './packages/rlm-print/src/index.ts'
  config:
    cwd: .

- id: sdk
  name: './packages/rlm-sdk/src/index.ts'
  config:
    maxDepth: 10
    defaultModel: auto/best-free
```

### Config resolution (DSH-style layering)

Priority (highest first):

1. **CLI override**: `--config /path/to/cordis.yml`
2. **Project-local**: `.rlm/cordis.yml` (if present)
3. **Root**: `cordis.yml` at repo root
4. **Patches** (applied last): `~/.rlm/cordis.patch.yml` or `.rlm/cordis.patch.yml`

### ~/.rlm/ directory layout

| Path | Level | Contents |
|------|-------|----------|
| `~/.rlm/agent/settings.json` | Global | Provider, model, maxDepth, thinking level |
| `~/.rlm/agent/auth.json` | Global | API keys / auth storage |
| `~/.rlm/agent/sessions/` | Global | JSONL session persistence |
| `~/.rlm/agent/skills/` | Global | Installed skills |
| `~/.rlm/agent/extensions/` | Global | Installed extensions |
| `~/.rlm/agent/workflows/` | Global | Hot-swappable TS workflows |
| `~/.rlm/agent/workflows/learnings.jsonl` | Global | Learning entries (append-only) |
| `~/.rlm/agent/workflows/proposals/` | Global | LLM-proposed workflow modifications |
| `~/.rlm/agent/memory/` | Global | Persistent key-value memory |
| `~/.rlm/runtimes/` | Global | User plugin overrides (`.mjs` + `.json`) |
| `~/.rlm/config.json` | Global | Auth config |
| `~/.rlm/cordis.patch.yml` | Global | Config patches (applied after base) |
| `.rlm/context.json` | Project | Project-scoped context variables |
| `.rlm/cordis.yml` | Project | Project-local plugin composition |
| `.rlm/cordis.patch.yml` | Project | Project-local config patches |
| `cordis.yml` | Bundled | Cordis plugin composition (repo root) |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOME` | system | Used for `~` path expansion in config |
| `NODE_OPTIONS` | — | `--expose-internals` added automatically in dev mode for HMR |

---

## Plugin Reference

All 14 plugins. Service ID = how you access it via `ctx.get("serviceId")`.

### Foundation Layer

| Plugin | Package | Service ID | What it does | Dependencies | Config options |
|--------|---------|------------|--------------|--------------|----------------|
| `config` | `rlm-config` | `rlmConfig` | Settings manager, model registry, auth storage | none | `cwd`, `agentDir` |
| `context` | `rlm-context` | `rlmContext` | Persistent typed variable registry (agent working memory) + elegant TUI panel | none | `projectRoot`, `showContextPanel`, `coloredBars`, `perVariableExpand`, `hjklNavigation`, `autoFocusTyping`, `doubleEnterToSend`, `followupQueueUi`, `scrollablePanel`, `enableClone`, `enableMutate`, `enableBulkOps`, `enableSubagentTransfer` |
| `tui` | `rlm-tui` | `rlmTui` | TUI extension service (slash commands, status bar items, components, UiProvider override) | none | keybindings |
| `prompt` | `rlm-prompt` | `rlmPrompt` | Registry for system-prompt fragments (priority-sorted, hot-reloadable) | none | — |

### Core Layer

| Plugin | Package | Service ID | What it does | Dependencies | Config options |
|--------|---------|------------|--------------|--------------|----------------|
| `session` | `rlm-session` | `rlmSession` | Session manager + JSONL persistence | foundation | — |
| `tools` | `rlm-tools` | `rlmTools` | Tool registry (`code`, `edit`) | foundation | `timeout`, `maxOutputChars` |
| `refine` | `rlm-refine` | `rlmRefine` | Refinement + auto-refine (contributes `refine-doctrine` prompt at priority 70) | `rlmConfig` | — |
| `code` | `rlm-code` | `rlmCode` | Persistent JS code execution (`vm.Context` + `!` shell + `%%bash` + `rlm.*` SDK) | foundation | `timeout`, `cwd`, `maxOutputChars` |
| `workflow` | `rlm-workflow` | `rlmWorkflow` | Hot-swappable TS workflows from `~/.rlm/agent/workflows/` | foundation | `workflowsDir` |
| `learn` | `rlm-learn` | `rlmLearn` | Self-evolution — tracks outcomes, reflects, proposes workflow modifications (contributes `past-learnings` prompt at priority 5) | foundation | `learningsDir`, `proposalsDir`, `reflectInterval`, `maxLearningsBeforeReflect` |

### Agent Layer

| Plugin | Package | Service ID | What it does | Dependencies | Config options |
|--------|---------|------------|--------------|--------------|----------------|
| `agent` | `rlm-agent` | `rlmAgent` | AgentSession runtime — LLM loop, tool dispatch, subagent spawning, session services | `rlmConfig`, `rlmSession`, `rlmTools`, `rlmRefine` | `cwd`, `agentDir` |

### Presentation Layer

| Plugin | Package | Service ID | What it does | Dependencies | Config options |
|--------|---------|------------|--------------|--------------|----------------|
| `renderer` | `rlm-tui-renderer` | `rlmRenderer` | InteractiveMode wrapper — forwards all events to active UiProvider | `rlmAgent` | `cwd` |
| `print` | `rlm-print` | `rlmPrint` | Print mode (single-shot prompt → output → exit) | `rlmAgent` | `cwd` |
| `sdk` | `rlm-sdk` | `rlmSdk` | In-process subagent spawning + `rlm.run` / `rlm.spawn` (contributes `sdk-doctrine` prompt at priority 80) | foundation | `maxDepth`, `defaultModel` |

### Prompt fragment priorities

| Fragment | Plugin | Priority | When |
|----------|--------|----------|------|
| `context-doctrine` | `rlm-context` | 100 | always |
| `sdk-doctrine` | `rlm-sdk` | 80 | always |
| `refine-doctrine` | `rlm-refine` | 70 | always |
| `past-learnings` | `rlm-learn` | 5 | always |

---

## Context Registry

All agent knowledge lives in typed variables — `const` (immutable) or `let` (mutable). This is the agent's working memory. The harness doesn't keep a shadow copy — every mutation bumps `rlmContext.getEpoch()`, emits `rlm/prompt-changed`, and the next turn's system prompt is rebuilt with `context.summarize()` already inside it.

### Scopes

| Scope | Persistence | Use case |
|-------|-------------|----------|
| `project` | `.rlm/context.json`, survives all sessions | Project facts (test commands, architecture decisions) |
| `session` | One session, in session artifact dir | Current task state, findings |
| `task` | In-memory, passed from parent via `rlm.spawn()` | One subagent invocation |

### API

```js
// create — const by default for decision/prompt, let otherwise
context.set("user.prompt", prompt, { mutable: false, type: "prompt", description: "User request" })
context.set("files.packages", dirs, { description: "Package directories" })

// read / update
context.get("files.packages")           // value or undefined
context.meta("files.packages")          // full metadata
context.update("files.packages", next)  // mutable only
context.mutate("files.packages", v => [...v, "rlm-new"])            // single
context.mutateMany("files.*", (v, name) => Array.isArray(v) ? [...v].sort() : v) // many

// copy / clone — deep copy, with transform + scope control
context.clone("files.packages", "files.packages.bak")
context.cloneMany(["auth.*"], "backup.")              // prefix
context.cloneMany(["auth.*"], n => "backup."+n)       // function
context.cloneMany(["auth.*"], "backup.", { transform: v => v.slice(0,10) })

// list / snapshot / transfer
context.list("auth.*")                  // glob filter
context.copy(["auth.*", "db.*"])        // non-destructive snapshot (alias: snapshot)
context.move(["auth.*"])                // destructive transfer (you lose it)
context.batch([                          // atomic batch, one epoch bump
  { op: "set", name: "a", value: 1 },
  { op: "mutate", name: "b", fn: v => v + 1 },
  { op: "cloneMany", patterns: ["a.*"], prefixOrTransform: "backup." },
  { op: "copy", patterns: ["auth.*"] },
])
context.summarize()                     // what the LLM actually sees next turn
context.delete("tmp.note")
context.clear("task")                   // or clear("session", true) to force through const
```

### Usage example — full turn loop

```js
// First turn: capture runtime state
context.set('runtime.model', 'omniroute/auto', { mutable: false });
context.set('runtime.tools', ['code'], { mutable: false });

// User asks: 'list packages'
context.set('user.prompt', 'list packages', { mutable: false });
const dirs = fs.readdirSync('./packages');
context.set('files.packages', dirs, { description: 'Package directories' });

// Follow-up: 'which ones start with rlm?'
const prev = context.get('files.packages'); // reuse, don't re-run
const rlmDirs = prev.filter(d => d.startsWith('rlm-'));
context.set('files.rlm-packages', rlmDirs, { description: 'RLM package directories' });

// Power operations: copy/move/mutate/clone many + transfer
context.clone('files.packages', 'files.packages.bak'); // deep copy single
context.cloneMany(['files.*'], 'backup.files.'); // backup many with prefix
context.mutate('files.rlm-packages', v => [...v, 'rlm-new']); // mutate one
context.mutateMany('files.*', v => Array.isArray(v) ? [...v].sort() : v); // mutate many
```

### Micro-behaviour flags (all `true` by default, no LLM needed to toggle)

| Flag | Gates |
|------|-------|
| `enableClone` | `clone` / `cloneMany` |
| `enableMutate` | `mutate` / `mutateMany` |
| `enableBulkOps` | `cloneMany` / `mutateMany` / `batch` / `copy-many` |
| `enableSubagentTransfer` | `copy` / `move` transfer to subagents |

### System-generated variables

The system creates `runtime.*` (model, tools, skills, depth), `skill.*`, and `session.*` infrastructure variables. The LLM creates everything else with meaningful names.

---

## Self-Learning

rlm evolves its own harness over time. Two mechanisms work together:

### Auto-refine (rlm-refine)

Detects repeated tool errors and schedules refinement automatically:

- **Triggers**: `tool_error` events, `tool_discovery` (5+ tool calls without progress)
- **What it does**: adds prompt notes + memories so mistakes never repeat
- **Scope**: local (session-scoped) by default; global (`global_=True`) for stable cross-session lessons
- **API**: `await refine.run()` — schedules refinement, returns immediately `{ scheduled: true }`, runs when the current turn ends

```js
// explicit refinement with focus
await refine.run("create a memory about always checking git status before committing")

// global refinement (cross-session)
await refine.run("promote the error-handling pattern to a global skill", global_=True)

// check status
await refine.status()  // { pending: boolean, in_flight: boolean }
```

### Learn plugin (rlm-learn)

Tracks workflow execution outcomes and proposes modifications:

```
1. Workflow runs → outcome recorded (learnings.jsonl)
2. After N runs (default 10), reflect on patterns
3. LLM proposes modifications to workflow files
4. Proposals written to ~/.rlm/agent/workflows/proposals/
5. Operator approves → file moves to workflows/ → HMR picks it up
```

The learning loop:

- **Listens to**: `rlm/workflow-start`, `rlm/workflow-complete`, `rlm/workflow-error`, `rlm/delegator-review`, `rlm/delegator-classified`
- **Records**: timestamp, workflow name, input, result, duration, success
- **Reflects**: uses `rlmSdk.spawn()` to ask the LLM to identify success/failure patterns and propose modifications
- **Feeds back**: past failures, low-score reviews, and reflection patterns are injected into the system prompt (priority 5) so the agent doesn't repeat mistakes

```js
// inspect learning stats
const stats = rlmLearn.stats()
// { total, successes, failures, successRate, avgReviewScore, proposals }

// list pending proposals
const proposals = rlmLearn.listProposals()

// approve a proposal → moves to workflows/ → HMR reloads
rlmLearn.approveProposal("proposal-1234-abc.md", "improved-delegator")
```

### How learnings feed into the prompt

The `rlm-learn` plugin registers a prompt fragment (`past-learnings`, priority 5) that builds a concise summary:

```markdown
## Past Learnings (don't repeat these mistakes)
- [FAIL] delegator: timeout after 60s on large repo
- [LOW SCORE] review: score 2/5 (attempt 3)
- [PATTERNS] parallel spawns succeed; sequential loops timeout
```

This is rebuilt on every prompt invalidation — the agent always sees its recent failures.

---

## Recursive Subagents

The SDK plugin (`rlm-sdk`) spawns child agent loops with incremented depth. Each child gets its own agent loop, tools, model, and session persistence.

### API

```js
// spawn and get a handle (returns immediately at admission)
const handle = rlm.run("Analyze the auth module", { name: "auth-analyst" })
// { id, name, status: "running" }

// spawn and await result string
const result = await rlm.spawn("Summarize this file", { name: "summarizer" })

// list active children (use after kernel restart or compaction)
const children = rlm.listSubagents()
// [{ id, name, status, sessionName }]

// dispose a child when done
await rlm.deleteSubagent("auth-analyst")

// goal management
rlm.goal.create("Refactor the auth system", { tokenBudget: 50000 })
rlm.goal.get()      // { objective, status, tokensUsed, ... }
rlm.goal.complete()
rlm.goal.pause()
```

### Spawn options

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Child name (for tracking) |
| `model` | `string` | Override model (default: `auto/best-free`) |
| `thinking` | `string` | Thinking level |
| `cwd` | `string` | Working directory |
| `depth` | `number` | Recursion depth (auto-incremented) |
| `context` | `string[]` | Context patterns to COPY (non-destructive, parent keeps) |
| `contextMove` | `string[]` | Context patterns to MOVE (destructive, parent loses) |
| `contextStrategy` | `"copy"` \| `"move"` | Treat `context` as move when set to `"move"` |

### Depth limits

Default max depth: `10` (configurable via `sdk.maxDepth` in `cordis.yml`). When exceeded, the spawn returns an error handle — no infinite recursion.

### Context passing

```js
// COPY many — parent keeps, child gets snapshot in task scope
await rlm.run("audit rlm packages", { context: ["files.*", "backup.*"] })

// MOVE many — parent loses, child owns
await rlm.run("offload auth", { contextMove: ["auth.*"] })

// Prep before transfer
context.cloneMany(["auth.*"], "backup.")           // backup many
context.mutate("auth.files", v => v.filter(...))   // transform one
context.mutateMany("auth.*", v => ...)              // transform many
await rlm.run("task", { context: ["auth.*"] })      // then spawn
```

### Parallel spawning (MANDATORY)

Spawn independent tasks in parallel — never await sequentially in a loop:

```js
// CORRECT — spawn all, then wait
const h1 = rlm.run("research auth", { name: "r1" })
const h2 = rlm.run("research db", { name: "r2" })
const h3 = rlm.run("research api", { name: "r3" })
// end turn — children write files, read them for fan-in

// WRONG — never do this
for (const task of tasks) {
  await rlm.spawn(task)  // sequential, wastes time
}
```

---

## HMR (Hot Module Replacement)

HMR follows the Cordis philosophy: plugins are disposable, reloadable fibers. No `chokidar` — only Node built-in `fs.watch` registered as `ctx.effect()` (cleaned up on dispose).

### Two kinds of watching

| What changes | Trigger | Effect |
|--------------|---------|--------|
| Config files (`cordis.yml`, patches) | `fs.watch` → `Include.refresh()` | Re-reads YAML, transactionally updates entries, old fibers dispose |
| Plugin source (`packages/*/src/*.ts`) | `fs.watch` → `entry.fiber.restart()` | Re-imports module, old fiber disposes, new fiber loads |

### What triggers HMR

- Editing any `.ts` or `.js` file in `packages/*/src/`
- Editing `cordis.yml` or `cordis.patch.yml`
- Editing workflow files in `~/.rlm/agent/workflows/`
- Editing files in `prompts/`, `skills/`, or `refinement/` dirs (triggers `rlm/prompt-changed`)

### What does NOT interrupt

- **Active work** — continues on the old fiber; only the next turn uses new code
- **Active sessions** — never interrupted, only the next turn uses reloaded plugin
- **The process** — stays foreground, no restart, no re-exec

### Ignored paths

HMR ignores: `.test.ts` / `.test.js`, `node_modules`, `dist`, `.map`, `.d.ts`, `.cache`, `.tsbuildinfo`.

### Dev mode vs installed mode

| Mode | HMR | TS source | tsx |
|------|-----|-----------|-----|
| Dev (local) | Yes | Yes (via `tsx`) | Required |
| Installed (global) | No | No (compiled JS) | Not needed |

In dev mode, `cordis-shell.mjs` re-execs with `--expose-internals` + `tsx` loader for HMR on TS source. In installed mode, paths are rewritten to `dist/index.js` at runtime (no HMR, no source to watch).

---

## Shell Access

There is **no separate bash tool**. Shell access is built into the code tool (`rlm-code`). JavaScript-only execution via `vm.Context`.

### `!command` — line magic (shell out)

```js
!ls -la packages/
!git status
!npm run check
```

### `%%bash` cell — multi-line shell block

```js
%%bash
echo "Starting build..."
npm run build
echo "Done"
```

### Persistent JS context

The `vm.Context` is the kernel namespace — variables persist across calls:

```js
// Call 1
const dirs = fs.readdirSync('./packages')
var results = []  // persists via vm.Context

// Call 2 (later)
results.push(dirs.filter(d => d.startsWith('rlm-')))
console.log(results)  // still here
```

### Available builtins

`fs`, `path`, `os`, `child_process`, `fetch`, `import()`, `require`, `console.log`, `rlm.run()`, `rlm.spawn()`, `context.*`, `refine.*`

### Return shape

```ts
interface CodeResult {
  stdout: string      // console.log output captured
  stderr: string
  result?: string     // last expression value
  status: "ok" | "error" | "aborted"
  error?: { name: string; message: string; stack: string[] }
  durationMs: number
}
```

---

## Workflows

Workflows are hot-swappable TS files in `~/.rlm/agent/workflows/`. They use the `rlm-sdk` to compose recursive agent trees.

### Writing a workflow

A workflow is a TS module that exports a default function (via `define()` helper):

```ts
// ~/.rlm/agent/workflows/delegator.ts
export default define((api) => ({
  name: "delegator",
  async run(input: string) {
    // Decompose the task
    const plan = await api.sdk.spawn("Decompose this task: " + input, {
      name: "planner",
    });

    // Spawn parallel executors
    const tasks = plan.split("\n").filter(Boolean);
    const handles = tasks.map((task, i) =>
      api.sdk.run(task, { name: `executor-${i}` })
    );

    // Fan-in: children write files, read them here
    // (don't await sequentially — spawn all, then read)

    // Review
    const review = await api.sdk.spawn(
      "Review the results in ./results/",
      { name: "reviewer" }
    );

    return review;
  },
}));
```

### Workflow API

```ts
interface WorkflowApi {
  sdk: any          // rlmSdk service — rlm.run, rlm.spawn, rlm.goal, etc.
  ctx: any          // Cordis context — emit events, get other services
  emit: (event: string, data: any) => void
}
```

### Using workflows

```js
// Run a workflow by name
const result = await rlmWorkflow.run("delegator", "refactor the auth module")

// List loaded workflows
const names = rlmWorkflow.listWorkflows()
// ["delegator", "researcher", "implementer"]

// Reload a specific workflow manually
await rlmWorkflow.reload("delegator")
```

### Hot-swap

Editing a workflow file triggers `fs.watch` → dispose old → re-import. The new workflow is active immediately — no restart. Active work is never interrupted.

### Events emitted

| Event | When |
|-------|------|
| `rlm/workflow-loaded` | Workflow file loaded/reloaded |
| `rlm/workflow-removed` | Workflow file deleted |
| `rlm/workflow-start` | Workflow execution begins |
| `rlm/workflow-complete` | Workflow execution succeeds |
| `rlm/workflow-error` | Workflow execution fails |

The `rlm-learn` plugin listens to these events to track outcomes and learn.

---

## Development

### Project structure

```
rlm/
├── cordis-shell.mjs          # Host — boots Cordis, HMR, launches agent
├── cordis.yml                # Plugin composition (14 plugins, 4 layers)
├── package.json              # Root workspace (bin: rlm → cordis-shell.mjs)
├── packages/
│   ├── rlm-config/           # Foundation: settings, models, auth
│   ├── rlm-context/          # Foundation: typed variable registry + TUI panel
│   ├── rlm-tui/              # Foundation: TUI extension service
│   ├── rlm-prompt/           # Foundation: prompt fragment registry
│   ├── rlm-session/          # Core: session manager + persistence
│   ├── rlm-tools/            # Core: tool registry (code, edit)
│   ├── rlm-refine/           # Core: refinement + auto-refine
│   ├── rlm-code/             # Core: persistent JS execution + shell
│   ├── rlm-workflow/         # Core: hot-swappable TS workflows
│   ├── rlm-learn/            # Core: self-evolution
│   ├── rlm-agent/            # Agent: AgentSession runtime
│   ├── rlm-tui-renderer/     # Presentation: InteractiveMode wrapper
│   ├── rlm-print/            # Presentation: print mode
│   ├── rlm-sdk/              # Presentation: subagent spawning
│   ├── coding-agent/         # Core agent runtime (pi-coding-agent)
│   ├── ai/                   # AI provider abstractions (pi-ai)
│   ├── agent/                # Agent core (pi-agent-core)
│   └── tui/                  # TUI primitives (pi-tui)
├── scripts/                  # Build/install scripts
├── test.sh                   # Test runner
└── install.sh                # Install script
```

### Building

```bash
# Build all core packages (tui → ai → agent → coding-agent)
npm run build
```

### Testing

```bash
# Run specific tests (from package root, not repo root)
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts

# Full test suite
./test.sh
```

### Development mode

```bash
# Run with HMR (dev mode — tsx + --expose-internals)
npm run dev
# or
node cordis-shell.mjs
```

### Adding a new plugin

1. Create `packages/rlm-<name>/src/index.ts`
2. Export a `Service` class with `static provide = "rlm<Name>"` and `static inject = [...]`
3. Add to `cordis.yml` in the correct layer
4. HMR picks it up on next file save — no restart

### npm packages

| Package | Description |
|---------|-------------|
| [`rlm-code`](https://www.npmjs.com/package/rlm-code) | Persistent JS code execution tool — vm.Context + shell + rlm SDK |

### References

- **Cordis** (`@deepseek-ai/cordis`): plugin runtime and dependency injection.
- **Cordis Loader** (`@deepseek-ai/cordis-plugin-loader`): module loading + fiber management.
- **Cordis Include** (`@deepseek-ai/cordis-plugin-include`): YAML config reading + entry management.
- **DeepSeek Harness (DSH)**: architectural philosophy — the host is minimal, every capability is a plugin.
- **Prime-agent**: behavioral reference for TUI, recursive subagents, memory, refinement, and reflection concepts. No prime-agent code is used.

---

## License

[MIT](LICENSE)

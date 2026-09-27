<div align="center">

# rlm

**A self-evolving terminal agent.** JavaScript-native, built on the Cordis plugin runtime — every capability is a hot-swappable row in a YAML file, including the host shell itself.

[![npm](https://img.shields.io/npm/v/rlm-sh.svg)](https://www.npmjs.com/package/rlm-sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.8-brightgreen.svg)](https://nodejs.org)

</div>

rlm grew out of a heavy fork of [prime-agent](https://github.com/badlogic/pi-mono) — recursive subagents, persistent memory, self-refinement — rebuilt so that **nothing in the process needs a restart**. The bootstrap is 30 lines. Everything else, from the agent loop to the file watchers to the shell that loads them, is a plugin that can be edited while it runs.

---

## Install

```bash
npm install -g rlm-sh
```

This gives you the `rlm` command. Requires **Node.js ≥ 22.8** on your `PATH` (check with `node --version`; rlm refuses to boot below it because hot reload needs `--expose-internals`).

Alternatively run it with [Bun](https://bun.sh) — same command, different runtime: `bunx rlm-sh` or install globally with `bun install -g rlm-sh`.

> The npm package is `rlm-sh` because `rlm` was taken years ago. The binary is still `rlm`.

## Quick start

```bash
rlm                          # interactive TUI
rlm --print "Say only OK"    # one-shot, exits when done
echo "list this repo's packages" | rlm   # piped input also works
```

### First run: give it a model

rlm talks to ~30 providers. Easiest path — inside the TUI:

```
/login        # OAuth or paste an API key
/model        # pick a model (opens the selector)
```

Or set an environment variable before you launch:

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # or ANTHROPIC_OAUTH_TOKEN
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...
export OPENROUTER_API_KEY=...            # one key, every model
```

Or pass one for a single run: `rlm --provider openai --model gpt-5 --api-key sk-...`

Settings live in `~/.rlm/agent/settings.json`; credentials in `~/.rlm/agent/auth.json`. `rlm model list` shows everything currently resolvable.

---

## The CLI

### Modes

What `rlm` does on a given invocation is decided by the **modes row** — plugins claim the command line, highest priority wins:

| Invocation | What runs |
|---|---|
| `rlm` (TTY) | Interactive TUI |
| `rlm --print "..."` / `rlm -p "..."` / `echo hi \| rlm` | One-shot print → exit |
| `rlm --mode daemon` | Daemon supervisor (usually spawned for you, not run by hand) |
| `rlm drive …`, `rlm tasks`, `rlm lesson …`, `rlm olympus …` | Verb modes registered by plugins |

### Agent & session commands

| Command | What it does |
|---|---|
| `rlm agents` | Agent dashboard — all running/resident agents |
| `rlm list [--all] [--json]` | List sessions |
| `rlm -c` / `--continue` | Continue the previous session |
| `rlm -r [id]` / `--resume` | Agents view, or resume a specific session |
| `rlm --fork <id>` | Fork a saved session |
| `rlm attach <agent>` | Attach to a live agent |
| `rlm send <agent> <msg>` | Send a message to a running agent |
| `rlm stop <agent>` | Stop an agent |
| `rlm rename <agent> <name>` | Rename one |
| `rlm session export <file> [out]` | Export a session (.html/.jsonl) |

### Daemon & system

| Command | What it does |
|---|---|
| `rlm status` / `rlm doctor [--fix]` | Daemon health; doctor repairs common issues |
| `rlm shutdown [--force]` | Stop the daemon supervisor |
| `rlm update [--force]` | Update rlm + installed packages |
| `rlm config` | Open config |
| `rlm mcp add/list/get/remove` | Manage MCP servers |
| `rlm package install/list/remove/update` | Install packages (extensions, skills, prompts, themes) |
| `rlm model list [search]` | List resolvable models |
| `rlm fleet …` | Distributed execution across machines (list/discover/add/connect/status/bootstrap) |
| `rlm help <command>` | Per-command help |

### The drive loop (delegation)

`rlm-delegate` registers its own modes — a durable, journaled task queue that farms work out to subagents and external executors:

```bash
rlm drive            # run a sweep: pick up owed tasks, spawn workers, review
rlm drive status     # what is owed, blocked, in flight, per graph
rlm tasks [--why]    # one line per task across all graphs — nothing is ever lost
rlm lesson "<his words>" -- <what happened>   # record a correction as a standing review criterion
```

Every `--print` request is journaled before it runs, so work is never silently dropped.

### In the TUI

Press `/` for the slash-command menu. Notable: `/login` `/logout` `/model` `/effort` `/scoped-models` `/fast` `/compact` `/context` `/fork` `/clone` `/tree` `/share` `/export` `/import` `/goal` `/autonomous` `/lessons` `/refine` `/heartbeat` `/fleet` `/settings` `/new` `/name` `/resume` `/reload` `/btw` (side question) `/system-prompt` `/logs` `/traces` `/changelog` `/hotkeys`.

---

## What's inside

### Everything is a variable

The agent's working memory is a typed variable registry (`rlm-context`) — the user prompt, model config, discovered files, task state. `const`/`let` semantics, three scopes (`project` survives sessions in `.rlm/context.json`, `session`, `task`), plus `copy`/`move`/`clone`/`mutate`/`batch` — single or by glob. Every mutation bumps the epoch and rebuilds the next turn's system prompt. The TUI shows it all as a colored block panel: `hjkl` to move, Enter to expand, follow-up queue while the agent is busy.

### JavaScript code tool — no separate bash tool

The `code` tool is a persistent `vm.Context` — variables survive between calls. `!cmd` is shell line-magic, `%%bash` is a multi-line shell cell, and `fs`, `path`, `os`, `child_process`, `fetch`, `import()`, `require`, `console.log` are in scope — plus `rlm.*` (subagents), `context.*`, `refine.*`, `tui.*`, `self.*`.

### Recursive subagents

`rlm.run("task", { name })` returns a handle immediately; `rlm.spawn(...)` awaits the result. Depth-limited (default 10). Context transfers by copy or move. Spawn in parallel — never `await` inside a loop.

### Workflows — hot-swappable TypeScript

Drop a `.ts` file in `~/.rlm/agent/workflows/` and it's live — `rlmWorkflow.run("delegator", input)`, no restart. The learn row watches outcomes and proposes modifications for review.

### Self-improvement, three ways

- **Auto-refine** — repeated tool errors trigger `refine.run()`; lessons get written to the harness.
- **Learn plugin** — workflow outcomes are journaled, reflected on, and turned into proposals in `~/.rlm/agent/workflows/proposals/` you can approve.
- **Self-extension** — `compose` / `plugins` / `self` rows let the agent edit its own composition (`~/.rlm/cordis.patch.yml`), scaffold and mount new packages, all reachable as `self.*` inside code cells.

### Hot reload, all the way down

Two reloaders work together: the official `cordis-plugin-hmr` reloads plugin source (cache-evict → re-import → registry swap, rollback on failure), and `rlm-hmr` watches the resource dirs (skills, extensions, prompts, workflows) that aren't modules. The host shell **watches itself** — editing `shell.ts` swaps the running shell around the same Context; editing `cordis-shell.mjs` triggers an execve-in-place (same pid, same terminal). Active work is never interrupted: the old fiber finishes, the new one serves the next turn. If a row won't import, rlm boots without it and tells you which ones and why.

### A daemon that takes over running chats

The daemon is the default: a supervisor + resident workers serve every invocation, and a session whose owner died mid-turn **resumes where it left off** (inflight journal, `RLM_INFLIGHT_AUTORESUME=0` to opt out). `RLM_DAEMON=0` disables the daemon path entirely. Daemon socket: `$TMPDIR/rlm-<uid>/daemon.sock`; `scripts/install-rlm-daemon.sh` installs a launchd agent (`com.abhi.rlm-daemon`) to keep it resident.

### An HTTP API for callers that aren't rlm

`rlm-integration` serves the agent on `127.0.0.1:20130`: `/v1/chat/completions` routes through the model registry, `/v1/delegate` writes to the durable task journal. Headless sibling processes (e.g. Iris) use it instead of holding provider keys.

### Guard

`rlm-guard` watches protected files (e.g. the fleet's capacity bounds) and restores them if anything — including the agent — edits them. `protect` can only grow the list, never shrink it.

### Pixel

`rlm-pixel` is the local indexer/enforcer row (on-demand factory, warms on start, watches only when someone's watching).

### Claude/Codex/Gemini subscriptions

`rlm-cliproxy` surfaces a local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) as the `cliproxy` provider — subscription auths, live model list.

### Olympus

`rlm olympus <stage>` — the shipd.ai quest pipeline (calibration, rubrics, grading tools under `packages/rlm-olympus/`).

### Thinking as steps

`rlm-thinking-steps` renders reasoning as a collapsible step tree (Alt+T or `/thinking-steps`).

---

## Architecture

`cordis-shell.mjs` (30 lines, frozen) → `rlm-host/shell.ts` (self-reloading host) → Cordis `Context` → Loader + Include → `cordis.yml` → the modes row picks a surface.

```
Recording     log                     everything after it can be explained from the log
Boot          boot                    paths, the user overlay, shutdown
Reload        timer, hmr, rlm-hmr     module graph + resource dirs
Detection     headless                is anyone watching this invocation?
Foundation    config, context, tui, prompt
Self-ext.     compose, plugins, self  rlm's hands on its own composition
Core          session, tools, refine, code, workflow, delegate, integration,
              guard, learn, pixel, thinking-steps, inflight, cliproxy
Meta          olympus                 quest pipeline
Agent         agent                   the LLM loop
Presentation  renderer, print, sdk, modes
```

Load order comes from what each row `inject`s — row position in `cordis.yml` is for reading, not loading.

## Configuration

rlm composes itself from `cordis.yml` (shipped) + `~/.rlm/cordis.patch.yml` (your overlay — applied on top, re-applied on change) + `.rlm/cordis.yml` / `.rlm/cordis.patch.yml` (project-local). Resolution: `--config` > project `.rlm/cordis.yml` > shipped `cordis.yml`. Everything rlm decides about itself is written to the overlay, so `git diff cordis.yml` only ever shows what a person did.

Each row is `{ id, name, config, disabled? }`. `disabled` can be a `!!js` expression — the shipped file uses it to park terminal rows in daemon workers.

`~/.rlm/` holds all state: `agent/auth.json` (credentials), `settings.json`, `sessions/`, `skills/`, `extensions/`, `prompts/`, `themes/`, `workflows/` (+ `learnings.jsonl`, `proposals/`), `memory/`, `logs/`, `cron-jobs.json`.

## Developing

```bash
git clone https://github.com/abhishakenp/rlm.git
cd rlm
bun install            # or npm install
bun run dev            # node cordis-shell.mjs works too
```

Run it from source: `node cordis-shell.mjs` (Node path) or `bun cordis-shell.mjs` (Bun path — skips the tsx re-exec entirely).

Per-package tests use vitest — run from the package dir:

```bash
cd packages/rlm-context && npx tsx ../../node_modules/vitest/dist/cli.js --run
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full config reference.

## Publishing

`npm publish` runs automatically in CI when a GitHub **release** is published or a `v*` tag is pushed (`.github/workflows/publish.yml`, `NPM_TOKEN` secret). The package ships TypeScript sources and runs them through `tsx` — there is no build step.

## License

[MIT](LICENSE)

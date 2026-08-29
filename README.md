# rlm

Self-evolving terminal agent — **Cordis plugin kernel + prime-agent brain**.

`rlm` is a verbatim fork of [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) rebranded and wrapped in a [Cordis](https://github.com/deepseek-ai/cordis) lifecycle shell. It keeps prime-agent's complete terminal-native UX and agent runtime, and adds Cordis as the outer plugin host with hot-module replacement.

## What you get

- **Terminal UI** — prime-agent's full differential-rendering TUI (`packages/tui`), not a simplified renderer.
- **IPython / RLM kernel** — real ZMQ + Jupyter comm protocol (`packages/coding-agent/src/core/kernel`), with namespace snapshot/restore across sessions.
- **Recursive subagents** — real `AgentSession` child sessions via `rlm.run`, with depth limits and inter-agent messaging.
- **Model-backed refinement** — `refinement.ts` drives LLM-proposed edits to persistent prompt notes, memories, skills, and subagent specs.
- **Memory & harness state** — on-disk persistent store under `~/.prime/agent` (revived across runs).
- **Wound detection & self-healing** — failure-triggered refinement proposes fixes; reflection periodically consolidates learning.
- **Hot reload / hot swap** — Cordis HMR watches `packages/` and reloads plugins in-process.
- **Foreground-only** — no daemon survives the terminal. Session/memory/harness data persists on disk.

## Architecture

```
cordis-shell.mjs          ← Cordis outer lifecycle (loader + timer + include + HMR)
  └─ spawns → packages/coding-agent/dist/bundle/cli.js   ← prime-agent agent brain
                ├─ TUI (packages/tui)
                ├─ Kernel (ZMQ + ipykernel)
                ├─ Refinement (LLM-backed)
                ├─ AgentSession + recursive rlm.run
                ├─ Memory / harness state
                └─ Extension API
```

The Cordis host owns process lifecycle and HMR; the coding-agent CLI owns everything user-visible. The shell degrades gracefully — if Cordis fails to boot, the agent brain runs directly.

## Install

```bash
npm install -g .          # installs `rlm` and `pi` binaries from packages/coding-agent
```

Or run the Cordis-wrapped entry directly:

```bash
node cordis-shell.mjs --help
```

## Build

```bash
npm install
npm run build             # builds tui → ai → agent → coding-agent in order
```

## Run

```bash
rlm                       # interactive TUI
rlm -p "message"          # print mode
rlm --help                # full options
```

## Project layout

- `packages/tui` — terminal UI library (verbatim from prime-agent)
- `packages/ai` — model provider abstractions
- `packages/agent` — agent core loop
- `packages/coding-agent` — CLI, kernel, refinement, sessions, extensions
- `prime-agent-runtime` — Python `rlm` module loaded into the IPython kernel
- `cordis-shell.mjs` — Cordis lifecycle wrapper
- `cordis-scaffold/` — earlier Cordis-only scaffold (kept for reference)

## Notes

- Internal workspace package names (`@earendil-works/pi-*`) and env var prefixes (`PRIME_AGENT_*`) are preserved verbatim from prime-agent. The config dir remains `~/.prime/agent`.
- The Python kernel venv is auto-provisioned under `~/.prime/agent/kernel-venv` on first run (requires `uv`).
- This is a fork for personal use; upstream credit goes to the prime-agent authors.

## License

MIT

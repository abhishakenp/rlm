# rlm

Self-evolving terminal agent — Cordis plugin kernel + prime-agent brain.

## What it is

A terminal-native agent harness where everything is a hot-swappable plugin and the system can modify, heal, and learn from itself at runtime.

- **Cordis kernel** (from DeepSeek Harness) — plugin mount/unmount/restart, services, events, session log, HMR hot-swap
- **prime-agent brain** — TUI, ipython kernel, subagent control, refinement, memory
- **Self-evolving loop** — wound detection → refinement → HMR hot-swap → reflection → memory

## Architecture

```
Cordis Kernel (bedrock)
├── plugin-tui          — terminal UI (raw ANSI renderer)
├── plugin-kernel        — ipython + ZMQ + RLM (persistent Python kernel)
├── plugin-subagent      — recursive subagent delegation (depth-limited)
├── plugin-refine        — self-evolution engine (HarnessState + plugin source edits)
├── plugin-memory        — HarnessState storage + refinement history
├── plugin-wound         — failure detection → triggers refine
├── plugin-reflect       — open-ended reflection → learns from outcomes
├── plugin-peers         — peer mesh (Tailscale discovery, no daemon)
└── plugin-extensions    — prime-agent ExtensionAPI compatibility
```

### The self-evolving loop

```
wound detects failure → refine plans edit → sandbox test → HMR hot-swap
  → session log records → reflect evaluates outcome → memory learns
  → next failure gets better fix → peers sync the fix
  → repeat. system improves every cycle.
```

### Two philosophies

**Cordis:** Everything is a plugin. Swappable at runtime. Compose via config. Communicate via services + events.

**Recursive:** The system operates on itself. Self-modification (refine rewrites refine). Self-healing (wound detects wound). Self-learning (memory stores which fixes worked). Recursive delegation (subagents spawn subagents).

## Install

```bash
git clone https://github.com/abhishakenp/rlm.git
cd rlm
bun install
bun src/cli/index.ts
```

## Commands

| Command | Description |
|---|---|
| `/refine [plugin]` | Trigger refinement (manual) |
| `/reflect` | Trigger reflection |
| `/wounds` | Show detected wounds |
| `/memory` | Show stored memories |
| `/plugins` | Show loaded plugins |
| `/exit` | Shut down |

## Development

```bash
bun test          # run tests (8 tests, all passing)
bun src/cli/index.ts  # start the agent
```

## Tech stack

- **Runtime:** Bun
- **Kernel:** @deepseek-ai/cordis 4.0.1
- **Hot-swap:** @deepseek-ai/cordis-plugin-hmr 1.0.16
- **Language:** TypeScript
- **Python:** ipython kernel (lazy-started, in-process, no daemon)

## License

MIT

# rlm

Self-evolving terminal agent — **modified Cordis host + prime-agent brain, DSH philosophy**.

`rlm` is a modified [Cordis](https://github.com/deepseek-ai/cordis) plugin host that decomposes a prime-agent-derived agent runtime into small, hot-swappable Cordis plugins. The architecture follows [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) philosophy: everything is a plugin, the core is just the host, HMR reloads any plugin at runtime.

## What you get

- **Cordis plugin host** — modified to run prime-agent subsystems as Services
- **12 plugins** — llm, session, kernel, agent, subagent, refinement, wound, reflect, memory, extensions, skills, tui (each a separate package under `packages/rlm-*`)
- **Terminal UI** — prime-agent's full differential-rendering TUI, wrapped as a Cordis plugin (the direct analog of DSH's `dsh-host-frontend-static` web GUI plugin)
- **IPython / RLM kernel** — real ZMQ + Jupyter comm protocol, wrapped as a Cordis plugin
- **Recursive subagents** — real `AgentSession` child sessions via `rlm.run`, with depth limits and inter-agent messaging
- **Model-backed refinement** — LLM-proposed edits to persistent prompt notes, memories, skills, and subagent specs
- **Memory & harness state** — on-disk persistent store under `~/.prime/agent`
- **Wound detection & self-healing** — failure-triggered refinement proposes fixes
- **Hot reload / hot swap** — Cordis HMR watches plugin source dirs and reloads plugins in-process
- **Foreground-only** — no daemon survives the terminal. Session/memory/harness data persists on disk.

## Architecture

```
cordis-shell.mjs          ← Modified Cordis host (loader + timer + include + HMR)
  └─ mounts config/profile.yml  ← Entry-list composing all plugins
       ├─ @rlm/llm         ← pi-ai stream/complete, omniroute provider
       ├─ @rlm/session     ← SessionManager
       ├─ @rlm/kernel      ← KernelManager (IPython/ZMQ)
       ├─ @rlm/memory      ← Persistent memory on disk
       ├─ @rlm/agent       ← AgentSession (injects: session, llm)
       ├─ @rlm/subagent    ← Recursive subagent spawn (injects: agent, kernel)
       ├─ @rlm/refinement  ← refineHarness (injects: agent, llm)
       ├─ @rlm/wound       ← Failure detection (injects: agent)
       ├─ @rlm/reflect     ← Periodic reflection (injects: agent, memory)
       ├─ @rlm/extensions  ← Extension loader (injects: agent)
       ├─ @rlm/skills      ← Skill discovery (injects: agent)
       └─ @rlm/tui         ← TUI renderer (injects: agent)
  └─ spawns → packages/coding-agent/dist/bundle/cli.js  ← agent brain
```

The Cordis host owns process lifecycle and HMR; the plugin tree owns all agent capabilities. Each plugin is a Cordis `Service` with dependency injection. HMR can reload any plugin at runtime — that's the hot-swap primitive.

## Install

```bash
npm install -g .          # installs the `rlm` binary
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

- `packages/rlm-*` — Cordis plugins (each wraps a prime-agent subsystem as a Service)
- `packages/tui` — terminal UI library
- `packages/ai` — model provider abstractions
- `packages/agent` — agent core loop
- `packages/coding-agent` — CLI, kernel, refinement, sessions, extensions
- `prime-agent-runtime` — Python `rlm` module loaded into the IPython kernel
- `cordis-shell.mjs` — modified Cordis lifecycle host
- `config/profile.yml` — plugin composition (entry-list YAML)
- `cordis-scaffold/` — earlier Cordis-only scaffold (kept for reference)

## Notes

- The `rlm` binary is the only installed command. There is no `pi` binary.
- Internal workspace package names (`@earendil-works/pi-*`) and env var prefixes (`PRIME_AGENT_*`) are preserved from the upstream codebase for compatibility. The config dir remains `~/.prime/agent`.
- The Python kernel venv is auto-provisioned under `~/.prime/agent/kernel-venv` on first run (requires `uv`).
- OmniRoute (`localhost:20128`) is the default model provider, configured via `~/.prime/agent/models.json`.

## License

MIT

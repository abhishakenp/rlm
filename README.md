# rlm

Self-evolving terminal agent. JavaScript-native. Cordis plugin architecture. No Python.

Everything is a plugin. The host boots Cordis, loads plugins from `config/profile.yml`, and runs a terminal UI. HMR watches plugin source dirs — any plugin can be hot-swapped at runtime without restarting the process.

## Architecture

- **Host** (`cordis-shell.mjs`): boots Cordis Context, installs Loader + Timer, starts HMR watcher, loads plugins from profile YAML, runs TUI or print mode.
- **Plugins** (`packages/rlm-*`): each is a Cordis `Service` that owns a runtime subsystem.

### Plugins

| Plugin | npm package | Service | Owns |
|--------|-------------|---------|------|
| `@rlm/tui` | `rlm-tui` | `rlmTui` | Terminal UI (interactive + print mode) |
| `@rlm/context` | `rlm-context` | `rlmContext` | Persistent typed variable registry (agent working memory) |
| `@rlm/code` | `rlm-code` | `rlmCode` | Persistent JS code execution (vm.Context + `!` shell + `%%bash`) |
| `@rlm/sdk` | `rlm-sdk` | `rlmSdk` | In-process subagent spawning, goal management |
| `@rlm/workflow` | `rlm-workflow` | `rlmWorkflow` | Hot-swappable TS workflows from `~/.rlm/workflows/` |
| `@rlm/learn` | `rlm-learn` | `rlmLearn` | Self-evolution — tracks outcomes, proposes modifications |

### Code tool

The code tool is JavaScript-only. No Python, no IPython, no kernel process.

- `!command` → shell out (line magic)
- `%%bash` cell → multi-line shell block
- Persistent variables across calls (`vm.Context` = kernel namespace)
- `console.log()` output captured as stdout
- Last expression value captured as result
- `rlm.run()` for in-process subagent spawning
- `fs`, `path`, `os`, `child_process`, `fetch`, `import()` all available

### Context registry

All agent knowledge lives in typed variables — `const` (immutable) or `let` (mutable).

- `context.set(name, value, { type, mutable, description, scope })`
- `context.get(name)`
- `context.update(name, value)` — mutable only
- `context.list("auth.*")` — glob filter
- `context.copy(["auth.*"])` — copy to subagent
- `context.move(["auth.*"])` — transfer to subagent
- `context.delete(name)`
- `context.summarize()`

Scopes: `project` (persists to `.rlm/context.json`), `session`, `task` (in-memory, passed to children).

System-generated: `runtime.*` (model, tools, skills, depth, maxDepth, systemPrompt), `skill.*` (each installed skill).
LLM-generated: task-specific variables (user prompts, findings, decisions, tool results).

### Data paths

- Sessions: `~/.rlm/sessions/`
- Settings: `~/.rlm/settings.json`
- Context: `.rlm/context.json` (project-scoped)
- Extensions: `~/.rlm/extensions/`
- Skills: `~/.rlm/skills/`

## Install

```bash
npm install -g .
```

## Usage

```bash
# Interactive TUI
rlm

# Print mode (one-shot, exit)
rlm -p "Say only the word OK"

# Verbose (show tool calls)
rlm --verbose

# Help
rlm --help
```

## HMR

Plugin source files are watched. Editing any `packages/rlm-*/src/index.ts` while the host is running triggers:

1. File change detected by chokidar
2. Old plugin service disposed (via Cordis fiber disposal)
3. Module re-imported with cache-busting query param
4. New plugin instance registered with same config
5. Agent continues using the new service

No restart required. The process stays foreground — exits when terminal closes.

## Model

OmniRoute-only. Default model: `auto/best-free`. Configured in `config/profile.yml` and `~/.rlm/settings.json`.

## Recursive subagents

The SDK plugin spawns child agent loops with incremented depth. Depth limit (default 10) prevents infinite recursion. Context variables are copied to children by default; `context.move()` transfers ownership.

## Self-evolution

- **Auto-refine**: detects repeated tool errors (shell-as-JS, Python-in-JS, top-level return) and schedules refinement to add prompt notes + memories so mistakes never repeat.
- **Learn plugin**: tracks workflow outcomes, proposes modifications, learns over time.
- **HMR**: every plugin, config, skill, and system prompt is hot-swappable without interrupting active work.

## npm packages

| Package | Description |
|---------|-------------|
| [`rlm-code`](https://www.npmjs.com/package/rlm-code) | Persistent JS code execution tool — vm.Context + shell + rlm SDK |

## References

- **Cordis** (`@deepseek-ai/cordis`): plugin runtime and dependency injection.
- **DeepSeek Harness (DSH)**: architectural philosophy — the host is minimal, every capability is a plugin.
- **Prime-agent**: behavioral reference for TUI, recursive subagents, memory, refinement, and reflection concepts. No prime-agent code is used.

## License

MIT

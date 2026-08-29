# rlm

Self-evolving terminal agent. Modified Cordis host, DeepSeek Harness philosophy, no prime-agent code.

Everything is a plugin. The host boots Cordis, loads plugins from `config/profile.yml`, and runs a terminal UI. HMR watches plugin source dirs — any plugin can be hot-swapped at runtime without restarting the process.

## Architecture

- **Host** (`cordis-shell.mjs`): boots Cordis Context, installs Loader + Timer, starts HMR watcher, loads plugins from profile YAML, runs TUI or print mode.
- **Plugins** (`packages/rlm-*`): each is a Cordis `Service` that owns a runtime subsystem.

### Plugins

| Plugin | Service | Owns |
|--------|---------|------|
| `@rlm/llm` | `rlmLlm` | OmniRoute OpenAI-compatible client (stream + complete) |
| `@rlm/agent` | `rlmAgent` | Agent loop (system prompt → model → tools → repeat) |
| `@rlm/subagent` | `rlmSubagent` | Recursive subagent spawning with depth limits |
| `@rlm/session` | `rlmSession` | JSONL session persistence on disk |
| `@rlm/memory` | `rlmMemory` | Persistent key-value memory on disk |
| `@rlm/kernel` | `rlmKernel` | IPython/ZMQ kernel (Jupyter protocol 5.3) |
| `@rlm/tui` | `rlmTui` | Terminal UI (interactive + print mode) |
| `@rlm/wound` | `rlmWound` | Failure detection / self-healing triggers |
| `@rlm/refinement` | `rlmRefinement` | LLM-backed self-improvement proposals |
| `@rlm/reflect` | `rlmReflect` | Periodic reflection / self-learning |
| `@rlm/extensions` | `rlmExtensions` | Extension loader from `~/.rlm/extensions` |
| `@rlm/skills` | `rlmSkills` | Skill discovery from `~/.rlm/skills` |

### Data paths

- Sessions: `~/.rlm/sessions/`
- Memory: `~/.rlm/memory/`
- Extensions: `~/.rlm/extensions/`
- Skills: `~/.rlm/skills/`
- Kernel connections: `~/.rlm/kernel-connections/`

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

OmniRoute-only. Default endpoint: `http://localhost:20128/v1`. Default model: `auto/best-free`. Configured in `config/profile.yml`.

## Recursive subagents

The `subagent` tool is registered with `rlmAgent` by `rlmSubagent`. The LLM can call it to spawn a child agent loop with incremented depth. Depth limit (default 10) prevents infinite recursion.

## Self-healing

- `rlmWound` monitors `rlm/agent-error` events. After N failures on the same plugin, emits `rlm/wound-detected`.
- `rlmRefinement` listens for wounds and asks the LLM to propose a fix.
- `rlmReflect` runs every N turns, consolidating insights into persistent memory.

## References

- **Cordis** (`@deepseek-ai/cordis`): plugin runtime and dependency injection.
- **DeepSeek Harness (DSH)**: architectural philosophy — the host is minimal, every capability is a plugin.
- **Prime-agent**: behavioral reference for TUI, recursive subagents, memory, refinement, and reflection concepts. No prime-agent code is used.

## License

MIT

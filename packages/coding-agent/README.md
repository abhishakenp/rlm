# rlm coding-agent

The coding-agent CLI bundled inside `rlm`. JavaScript-native. No Python.

This is the agent runtime that powers `rlm` — the self-evolving terminal agent. It provides:

- Agent loop (system prompt → model → tools → repeat)
- JS code tool (`vm.Context` — persistent variables, `!` shell, `%%bash`)
- Session persistence (JSONL)
- Context registry (typed variables: `const`/`let`, copy/move)
- Recursive subagents with depth limits
- Auto-refine on tool errors (shell-as-JS, Python-in-JS, top-level return)
- HMR for system prompt, skills, and plugins
- OmniRoute model routing

## Install

```bash
npm install -g rlm
```

## Usage

```bash
# Interactive TUI
rlm

# Print mode (one-shot)
rlm -p "Say only the word OK"

# Help
rlm --help
```

## Code tool

JavaScript only. No Python, no IPython, no kernel process.

- `!command` → shell out
- `%%bash` cell → multi-line shell block
- `fs`, `path`, `os`, `child_process`, `fetch`, `import()` available
- `console.log()` captured as stdout
- Last expression value captured as result
- `rlm.run()` for subagent spawning

## Context registry

All agent knowledge in typed variables:

- `context.set(name, value, { type, mutable, scope })`
- `context.get(name)`, `context.update(name, value)`
- `context.list("auth.*")`, `context.copy(["auth.*"])`, `context.move(["auth.*"])`

Scopes: `project` (`.rlm/context.json`), `session`, `task`.

## Configuration

Settings: `~/.rlm/agent/settings.json`

```json
{
  "defaultProvider": "omniroute",
  "defaultModel": "auto/best-free",
  "rlmMaxDepth": 10
}
```

## License

MIT

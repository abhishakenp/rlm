# rlm Configuration Guide

rlm is a Cordis plugin host: fourteen hot-swappable plugins composed from a YAML
entry list. This guide covers config resolution, the `~/.rlm/` directory layout,
environment variables, per-plugin options, HMR, and model configuration.

---

## 1. Config resolution order

rlm resolves its `cordis.yml` using DSH-style layering. The first match wins;
later sources are never merged in.

| Priority | Source | Location | Notes |
|---|---|---|---|
| 1 | CLI override | `--config <path>` | Skips patch resolution entirely |
| 2 | Project config | `<cwd>/.rlm/cordis.yml` | Per-repo plugin set |
| 3 | Root config | `<repo>/cordis.yml` | Shipped default profile |
| 4 | Patches | `~/.rlm/cordis.patch.yml` or `<cwd>/.rlm/cordis.patch.yml` | Applied after base config |

Resolution logic lives in `resolveConfigPath()` / `resolvePatchPath()` in
`cordis-shell.mjs`:

- `--config` short-circuits: no patches are loaded.
- Project config is checked before root config.
- Patches are only loaded when a base config was found at priority 2 or 3.
  The global patch (`~/.rlm/cordis.patch.yml`) is preferred over a project
  patch (`<cwd>/.rlm/cordis.patch.yml`).
- If no `cordis.yml` is found anywhere, rlm exits with
  `[rlm] No cordis.yml found`.

Patches are parsed as YAML and passed to the Cordis Include plugin's `patches`
option, which transactionally updates entries without restarting the host.

---

## 2. cordis.yml structure

`cordis.yml` is a YAML array of plugin entries. Each entry has:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Plugin identifier (Cordis entry id) |
| `name` | string | yes | Module specifier: relative path, bare package, or `cordis:` builtin |
| `config` | object | no | Plugin-specific config (see [§5](#5-per-plugin-config-options)) |

The shipped `cordis.yml` loads fourteen plugins in dependency order:

```
Foundation:  config, context, tui, prompt
Core:        session, tools, refine, code, workflow, learn
Agent:       agent
Presentation: renderer, print, sdk
```

Example entry:

```yaml
- id: workflow
  name: './packages/rlm-workflow/src/index.ts'
  config:
    workflowsDir: ~/.rlm/agent/workflows
```

Paths in `config` that start with `~` are expanded to `$HOME` by
`expandPaths()` in the fallback manual loader. The Include plugin resolves
`name` relative to `ctx.baseUrl` (the repo root).

---

## 3. ~/.rlm/ directory layout

rlm stores all user data under `~/.rlm/`. The agent data root is
`~/.rlm/agent/` (the `CONFIG_DIR_NAME` from `package.json` `piConfig`).

```
~/.rlm/
├── cordis.yml              # Global Cordis config (optional; overrides root)
├── cordis.patch.yml        # Global patches (applied after base config)
└── agent/                  # Agent data root (~/.rlm/agent)
    ├── auth.json           # Credential storage (API keys, OAuth tokens)
    ├── settings.json       # User settings (default model, rlmMaxDepth, ...)
    ├── models.json         # Custom model/provider registry
    ├── skills/             # User-installed skills (SKILL.md per dir)
    ├── harness/            # Global continual harness state
    │   ├── harness_state.json    # Prompt notes, memories, skills, subagent specs
    │   └── refinements.jsonl     # Appended refinement history (one JSON per line)
    ├── workflows/          # Hot-swappable TS workflow definitions
    │   ├── *.ts                  # Workflow files (auto-reloaded on edit)
    │   ├── learnings.jsonl       # Self-evolution learning log
    │   └── proposals/            # Pending workflow modification proposals
    ├── sessions/           # Session JSONL storage
    ├── themes/             # Custom themes
    ├── extensions/         # Custom extensions
    ├── prompts/            # Custom prompt templates
    ├── bin/                # Managed binaries (fd, rg)
    ├── logs/               # Diagnostic logs
    │   ├── agent.jsonl           # Shared structured client/provider log
    │   ├── agent-traces.log      # Agent trace log
    │   └── client-errors.log     # Client-side agent-open failures
    ├── cron-jobs.json      # Cron job store
    └── rlm-debug.log       # Debug log
```

### Key files

| Path | Purpose | Source |
|---|---|---|
| `~/.rlm/agent/auth.json` | API keys, OAuth tokens | `AuthStorage.create()` in `rlm-config` |
| `~/.rlm/agent/settings.json` | User settings (global scope) | `FileSettingsStorage` |
| `~/.rlm/agent/models.json` | Custom providers/models | `ModelRegistry.create()` |
| `~/.rlm/agent/skills/` | User skills | `DefaultResourceLoader` (agentDir + `skills`) |
| `~/.rlm/agent/harness/harness_state.json` | Global continual harness | `getGlobalHarnessStateDir()` |
| `~/.rlm/agent/harness/refinements.jsonl` | Refinement audit history | `appendGlobalRefinement()` |
| `~/.rlm/agent/workflows/*.ts` | Workflow definitions | `rlm-workflow` (fs.watch hot-reload) |
| `~/.rlm/agent/workflows/learnings.jsonl` | Learning log | `rlm-learn` |
| `~/.rlm/agent/workflows/proposals/` | Pending proposals | `rlm-learn` |

Project-scoped equivalents live under `<cwd>/.rlm/agent/` (settings, skills,
prompts, themes, extensions) and are merged with global settings via
`deepMergeSettings()` (project overrides win).

---

## 4. Environment variables

| Variable | Default | Description |
|---|---|---|
| `RLM_CODING_AGENT_DIR` | `~/.rlm/agent` | Override the agent data root (`getAgentDir()`) |
| `RLM_SESSION_DIR` | `<agentDir>/sessions` | Override session storage directory |
| `RLM_CODING_AGENT_SESSION_DIR` | — | Legacy session dir override (same as `RLM_SESSION_DIR`) |
| `RLM_DEPTH` | `0` | Current rlm recursion depth (set on child spawns) |
| `RLM_MAX_DEPTH` | `2` (or `settings.rlmMaxDepth`) | Max subagent recursion depth |
| `RLM_GLOBAL_HARNESS_STATE_DIR` | `<agentDir>/harness` | Injected into child kernels |
| `RLM_SESSION_DIR` (kernel) | — | Per-child session dir, injected into kernel env |
| `RLM_PARENT_NODE_ID` | — | Parent agent id for child spawns |
| `PI_PACKAGE_DIR` | — | Override package asset dir (Nix/Guix store paths) |
| `PI_SHARE_VIEWER_URL` | `https://pi.dev/session/` | Base URL for shared session viewer |

`RLM_*` names are derived from `package.json` `piConfig.name` ("rlm"). The
prefix is uppercased and sanitized (`RLM`), then suffixed with
`_CODING_AGENT_DIR` / `_SESSION_DIR` / `_CODING_AGENT_SESSION_DIR`.

`RLM_DEPTH` and `RLM_MAX_DEPTH` are primarily set internally on child spawns;
you can set `RLM_MAX_DEPTH` in your shell to raise the recursion ceiling for a
session, or configure `rlmMaxDepth` in `settings.json`.

---

## 5. Per-plugin config options

All config is optional unless noted. Defaults shown are from the shipped
`cordis.yml`.

### Foundation layer

| Plugin | Config key | Type | Default | Description |
|---|---|---|---|---|
| `config` | `agentDir` | string | `getAgentDir()` | Override agent data root |
| `config` | `cwd` | string | `.` | Working directory |
| `context` | `projectRoot` | string | `.` | Project root for context registry |
| `tui` | — | — | — | No config |
| `prompt` | — | — | — | No config |

### Core layer

| Plugin | Config key | Type | Default | Description |
|---|---|---|---|---|
| `session` | — | — | — | No config |
| `tools` | `timeout` | number | `60000` | Tool execution timeout (ms) |
| `tools` | `maxOutputChars` | number | `65536` | Max output chars per tool |
| `refine` | — | — | — | No config |
| `code` | `timeout` | number | `60000` | Code cell execution timeout (ms) |
| `code` | `maxOutputChars` | number | `65536` | Max output chars per cell |
| `workflow` | `workflowsDir` | string | `~/.rlm/agent/workflows` | Workflow TS directory |
| `learn` | `learningsDir` | string | `~/.rlm/agent/workflows` | Learnings base dir |
| `learn` | `proposalsDir` | string | `<learningsDir>/proposals` | Pending proposals dir |
| `learn` | `reflectInterval` | number | `60000` | Reflection interval (ms) |
| `learn` | `maxLearningsBeforeReflect` | number | `10` | Learnings before auto-reflect |

### Agent layer

| Plugin | Config key | Type | Default | Description |
|---|---|---|---|---|
| `agent` | `cwd` | string | `.` | Working directory |

### Presentation layer

| Plugin | Config key | Type | Default | Description |
|---|---|---|---|---|
| `renderer` | `cwd` | string | `.` | Working directory |
| `print` | `cwd` | string | `.` | Working directory |
| `sdk` | `maxDepth` | number | `10` | Max subagent recursion depth |
| `sdk` | `defaultModel` | string | `auto/best-free` | Default model for subagents |

---

## 6. HMR configuration

rlm uses Cordis-native HMR via Node's `fs.watch` (no `chokidar`). Watchers are
registered as `ctx.effect()` and cleaned up on dispose. HMR only runs in dev
mode (when `tsx` is available locally); installed mode runs compiled JS with no
file watching.

### What is watched

| Target | Watch mechanism | Trigger |
|---|---|---|
| `cordis.yml` (base config) | `fs.watch` recursive | `Include.refresh()` — re-reads YAML, transactionally updates entries |
| Patch file (`cordis.patch.yml`) | `fs.watch` recursive | `Include.refresh()` |
| `packages/*/src/` dirs | `fs.watch` recursive | `entry.fiber.restart()` — re-imports module, old fiber disposes |

### What triggers reload

- Editing any `.ts` / `.js` file under `packages/*/src/` restarts the affected
  plugin's fiber.
- Changes to files under `/prompts/`, `/skills/`, or `/refinement/` also emit
  `rlm/prompt-changed` so the agent rebuilds its system prompt on the next turn.
- Changes to `cordis.yml` or patch files trigger `Include.refresh()`.

### What is ignored

`.test.ts`, `.test.js`, `.map`, `.d.ts`, `node_modules/`, `dist/`, `.cache/`,
`.tsbuildinfo` files are all skipped by the source watcher.

### How to disable HMR

HMR is automatically disabled in installed mode (no local `tsx`). To disable
in dev mode, remove the local `tsx` install or run via the compiled `dist/`
plugins. There is no explicit flag; the presence of
`node_modules/tsx/dist/loader.mjs` is the gate.

Active work is never interrupted by HMR — the old fiber disposes in the
background and only the next turn uses reloaded code.

---

## 7. Model configuration

### settings.json

`~/.rlm/agent/settings.json` controls default model selection:

```json
{
  "defaultProvider": "omniroute",
  "defaultModel": "auto/best-free",
  "rlmMaxDepth": 10
}
```

| Key | Type | Description |
|---|---|---|
| `defaultProvider` | string | Default provider (e.g. `omniroute`, `anthropic`) |
| `defaultModel` | string | Default model id or alias (e.g. `auto/best-free`) |
| `rlmMaxDepth` | number | Default max recursion depth for new sessions |
| `defaultThinkingLevel` | string | `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` |
| `recentModels` | string[] | MRU list of `provider/id` keys |
| `enabledModels` | string[] | Model patterns for cycling |

The `auto/best-free` alias routes to the best available free model via the
omniroute provider. Subagent spawns default to `auto/best-free` unless
overridden by `sdk.defaultModel` in `cordis.yml`.

### models.json

`~/.rlm/agent/models.json` adds custom providers and models (Ollama, vLLM, LM
Studio, proxies) and overrides built-in providers. JSONC (comments + trailing
commas) is supported.

Top-level schema:

```json
{
  "providers": {
    "<providerName>": {
      "name": "string?",
      "baseUrl": "string?",
      "apiKey": "string?",
      "api": "string?",
      "headers": { "string": "string" }?,
      "compat": ProviderCompat?,
      "authHeader": boolean?,
      "models": [ModelDefinition]?,
      "modelOverrides": { "<modelId>": ModelOverride }?
    }
  }
}
```

`ModelDefinition` fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Model id |
| `name` | string | no | Display name |
| `api` | string | no | API type (e.g. `openai-completions`) |
| `baseUrl` | string | no | Override provider baseUrl for this model |
| `reasoning` | boolean | no | Model supports reasoning |
| `thinkingLevelMap` | object | no | Thinking level map |
| `input` | `["text"]` / `["text","image"]` | no | Supported input types |
| `cost` | `{input,output,cacheRead,cacheWrite}` | no | Per-token costs |
| `contextWindow` | number | no | Context window size |
| `maxTokens` | number | no | Max output tokens |
| `headers` | object | no | Per-model headers |
| `compat` | ProviderCompat | no | Compatibility flags |

`ProviderCompat` controls protocol quirks (`supportsDeveloperRole`,
`supportsReasoningEffort`, etc.) — set at provider level to apply to all
models, or at model level to override.

Minimal local model example:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "llama3.1:8b" }]
    }
  }
}
```

`apiKey` supports shell commands (resolved at request time) for dynamic
credentials. See `packages/coding-agent/docs/models.md` for the full reference.

---

## 8. Example configurations

### Minimal

Project `.rlm/cordis.yml` — load only foundation + agent + renderer:

```yaml
- id: config
  name: './packages/rlm-config/src/index.ts'
  config:
    cwd: .

- id: agent
  name: './packages/rlm-agent/src/index.ts'
  config:
    cwd: .

- id: renderer
  name: './packages/rlm-tui-renderer/src/index.ts'
  config:
    cwd: .
```

### Full (shipped default)

The repo-root `cordis.yml` is the full fourteen-plugin profile. See
[`cordis.yml`](../cordis.yml) for the canonical version.

### Development

Override `workflowsDir` and tighten tool timeouts via a project
`.rlm/cordis.yml`:

```yaml
- id: config
  name: './packages/rlm-config/src/index.ts'
  config:
    cwd: .

- id: tools
  name: './packages/rlm-tools/src/index.ts'
  config:
    timeout: 30000
    maxOutputChars: 32768

- id: workflow
  name: './packages/rlm-workflow/src/index.ts'
  config:
    workflowsDir: ./test-workflows

- id: learn
  name: './packages/rlm-learn/src/index.ts'
  config:
    reflectInterval: 10000
    maxLearningsBeforeReflect: 3
```

### Global patch

`~/.rlm/cordis.patch.yml` — swap the renderer to print mode across all
projects:

```yaml
- id: renderer
  remove: true
- id: print
  name: './packages/rlm-print/src/index.ts'
  config:
    cwd: .
```

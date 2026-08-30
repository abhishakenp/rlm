# rlm

Self-evolving terminal agent. JavaScript-native. Cordis plugin architecture. No Python.

rlm takes the ideas you already love from prime-agent — recursive subagents, persistent memory, self-evolution — and rebuilds them for people who live in the terminal. The host is tiny. Everything else is a plugin. You can hot-swap any of them while rlm is running and it just keeps going.

Everything is a Chordis micro-plugin. Each feature has its own config flag. All flags are `true` by default so it works out of the box — turn off what you don't want, keep the rest.

---

## Architecture

**Host** (`cordis-shell.mjs` / `cordis.yml`): boots a Cordis Context, installs Loader + Timer, watches plugin source dirs for HMR, loads plugins from `cordis.yml`, then runs the TUI or print mode. That's it — the host owns almost nothing.

**Plugins** (`packages/rlm-*`): each is a Cordis `Service` that owns one subsystem. Order matters — foundation first, then core, then agent, then presentation — so later plugins can depend on earlier ones.

- **Foundation** — no dependencies: `config`, `context`, `tui`, `prompt`
- **Core** — depends on foundation: `session`, `tools`, `refine`, `code`, `workflow`, `learn`
- **Agent** — the LLM loop: `agent`
- **Presentation** — what you see: `renderer`, `print`, `sdk`

HMR watches `packages/*/src`. Edit any `src/index.ts` while the host is running and Cordis disposes the old fiber, re-imports with a cache-busted import, and registers the new service. No restart. Active work stays on the old fiber; new work uses the new code.

### Plugins

| Plugin | npm package | Service | What it owns |
|--------|-------------|---------|--------------|
| `@rlm/config` | `rlm-config` | `rlmConfig` | Settings, model registry, auth storage |
| `@rlm/context` | `rlm-context` | `rlmContext` | Persistent typed variables + elegant context panel (see below) |
| `@rlm/tui` | `rlm-tui` | `rlmTui` | Extension points + UiProvider override for full UI replacement |
| `@rlm/prompt` | `rlm-prompt` | `rlmPrompt` | Registry for system-prompt fragments (priority-sorted, hot-reloadable) |
| `@rlm/session` | `rlm-session` | `rlmSession` | Session manager + persistence |
| `@rlm/tools` | `rlm-tools` | `rlmTools` | Tool registry (code, edit, etc.) |
| `@rlm/refine` | `rlm-refine` | `rlmRefine` | Refinement + auto-refine (also contributes `refine-doctrine` prompt) |
| `@rlm/code` | `rlm-code` | `rlmCode` | Persistent JS execution (`vm.Context` + `!` shell + `%%bash`) |
| `@rlm/workflow` | `rlm-workflow` | `rlmWorkflow` | Hot-swappable TS workflows from `~/.rlm/agent/workflows/` |
| `@rlm/learn` | `rlm-learn` | `rlmLearn` | Self-evolution — tracks outcomes, proposes improvements |
| `@rlm/agent` | `rlm-agent` | `rlmAgent` | AgentSession creation (LLM loop, tool dispatch) |
| `@rlm/tui-renderer` | `rlm-tui-renderer` | `rlmRenderer` | InteractiveMode wrapper — forwards all events to the active UiProvider |
| `@rlm/print` | `rlm-print` | `rlmPrint` | Print mode (single-shot prompt → output → exit) |
| `@rlm/sdk` | `rlm-sdk` | `rlmSdk` | In-process subagent spawning + `rlm.run` / `rlm.spawn` (also contributes `sdk-doctrine` prompt) |

Every plugin is independently testable and hot-swappable. If you can toggle it in config, you can disable it without touching code.

### rlm-tui extension points

`rlm-tui` isn't just chrome — it's where Chordis philosophy lives for the UI. Other plugins never patch core files; they register:

- `registerSlashCommand(name, handler, description, opts)` — `/my-command`
- `registerStatusBarItem(id, renderer)` — `ctx:3` in the status bar
- `registerComponent(id, renderer)` — custom lines in the TUI (context panel uses this)
- `registerUiProvider(pluginId, provider)` / `registerRendererOverride(...)` — **full UI replacement**. Highest `priority` wins. The provider gets `activate(api)`, `deactivate()`, `onEvent(event)`, and optional `render(ctx)` that suppresses the default `InteractiveMode` rendering. Disposing the handle falls back to the next provider or the default renderer. The renderer service forwards every `AgentSession` event through `rlmTui.emitEvent()` so a replacement UI receives the same events without modifying core.

Shortcuts and every parameter are configurable — see `DEFAULT_TUI_KEYBINDINGS` and per-plugin `keybindings` in config below.

---

## Prompt Fragments (no AGENTS.md duplication)

We used to have two sources of truth: code and `AGENTS.md`. Not anymore.

`rlm-prompt` is the single registry where plugins contribute the system prompt. No copy-pasting doctrine between files.

```ts
// any plugin
rlmPrompt.registerFragment("my-plugin", {
  id: "my-doctrine",
  priority: 60,          // higher = earlier in prompt
  when: "always",        // or "depth0" / "depth>0"
  content: () => "...",  // string or live function
})
```

- `priority` decides ordering — today: `context-doctrine` 100, `sdk-doctrine` 80, `refine-doctrine` 70, others 50–60.
- `buildCompositePrompt()` concatenates them sorted by priority. `getFragments(depth)` filters by depth.
- `ctx.emit("rlm/prompt-changed")` invalidates the cached system prompt so the **next LLM turn** already sees the new content. No restart.
- Fragments are disposed when the owning fiber is disposed — hot-reload a plugin and its prompt updates live.
- Exposed as `globalThis.__rlmPrompt` so `coding-agent` can read it without a hard import cycle. Fallback doctrine stays in core only if the plugin isn't loaded.

What this means for you: install the context plugin and you automatically get the context doctrine. Install the SDK plugin and you automatically get the parallel-subagent doctrine. No second `AGENTS.md` to keep in sync.

---

## Elegant Context UI

The context panel isn't an afterthought — it's a first-class, human-friendly view of your working memory. It feels good to look at, and it gets out of your way when you don't need it.

**What you see:** each variable is one line with a **colored bar** on the left by scope — cyan for `project`, yellow for `session`, magenta for `task`. `let` vs `const` is styled, the name is bold, the value is a dim preview. Expand one and you get a detailed view with type, scope, and full value (up to 6 lines, then "… +N more").

**How you use it (all Chordis micro-plugins, all toggleable):**

- **Per-variable expand** — click a variable (or focus + Enter) and *only* that one opens. `perVariableExpand: true` by default. When disabled, Enter toggles the whole panel.
- **Focused navigation** — `↑`/`↓` (or `k`/`j` with `hjklNavigation`) moves focus, `←`/`→` / `h`/`l` also work. Focused line is highlighted with inverse video and an accent arrow — you always know where you are.
- **Enter to expand/retract only the focused variable** — no global thrash. `Ctrl+O` still toggles all when you want the overview (expands all if any collapsed, collapses all if all expanded).
- **Scrollable** — `scrollablePanel: true` keeps a 10-row window, with `↑ 3 more above` / `↓ 5 more below` indicators. `PageUp`/`PageDown` and `Ctrl+U`/`Ctrl+D` scroll by a page.
- **Auto-focus typing** — `autoFocusTyping: true` means you just start typing. Any printable key (except Enter) focuses the input immediately — you never have to click the input first. A subtle hint line appears when the panel is focusable but idle: `hjkl/arrows: navigate • enter: expand • type to auto-focus`.
- **Followup queue** — keep typing while the agent is busy and your text is collected as unassigned followups below the panel (`followupQueueUi: true`). It shows the last 3 with a dim preview. **Press Enter twice** (within ~400ms) to send them immediately — the same gesture `Ctrl+O` uses, shown as a hint: `press Enter twice to send immediately`.

Every one of these is a tiny toggle: `showContextPanel`, `coloredBars`, `perVariableExpand`, `hjklNavigation`, `autoFocusTyping`, `doubleEnterToSend`, `followupQueueUi`, `scrollablePanel` — all `true` by default. Shortcuts are Chordis too — `keybindings` merges over `DEFAULT_CONTEXT_KEYBINDINGS` / `DEFAULT_TUI_KEYBINDINGS`, hot-reloadable.

The panel hugs the input elegantly — variables above, queue right below, hint where you'd naturally look next. It was designed to feel like a human curated it, not a debug dump.

---

## Harness Operates On Its Own Context

This is the core idea that makes rlm different from a thin chat wrapper:

**The LLM's context *is* all previous context.** The harness doesn't keep a shadow copy the LLM can't see. Every `context.set`, `update`, `mutate`, `clone`, `move`, or `batch` you (or the LLM) do bumps `rlmContext.getEpoch()`, emits `rlm/prompt-changed`, and the next turn's system prompt is rebuilt with `context.summarize()` already inside it. The LLM edits its own memory, live.

- **Harness facilitates** — the SDK, the code tool, and the context service are infrastructure. They give the LLM verbs (`context.*`, `rlm.run`, `rlm.spawn`) and they handle epoch invalidation and task-scope hydration for you. The LLM just thinks in variables.
- **Plugins facilitate via system-prompt auto-injection** — each plugin registers its doctrine through `rlm-prompt` (context 100, SDK 80, refine 70, all hot-reloadable). The agent doesn't read a separate `AGENTS.md`; the doctrine *is* the prompt. One source of truth, always in sync.
- **Transfer is first-class** — `context.copy(["auth.*"])` stays, `context.move(["auth.*"])` deletes locally, both work with one or many variables via globs. Pass them when spawning: `rlm.run("task", { context: ["auth.*","db.*"] })` copies, `rlm.run("task", { contextMove: ["auth.*"] })` moves. The harness snapshots atomically and rehydrates in the child's `task` scope.

You don't manage two memories. You do: read context → act → write context. That's the whole loop.

---

## Code tool

JavaScript-only. No Python, no IPython, no kernel process.

- `!command` → shell out (line magic)
- `%%bash` cell → multi-line shell block
- Persistent variables across calls (`vm.Context` = kernel namespace, `var` / `globalThis.x` persist)
- `console.log()` output captured as stdout
- Last expression value captured as result
- `rlm.run()` / `rlm.spawn()` for in-process subagent spawning (via Proxy, always the latest SDK)
- `fs`, `path`, `os`, `child_process`, `fetch`, `import()`, `require` available

---

## Context registry

All agent knowledge lives in typed variables — `const` (immutable) or `let` (mutable).

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

Scopes: `project` (persists to `.rlm/context.json`), `session` (persists for this session), `task` (in-memory, passed to children).

System-generated: `runtime.*` (model, tools, skills, depth), `skill.*`, `session.*`. LLM-generated: everything task-specific.

**Transfer to subagents (1 or many variables, via SDK):**

```js
// copy — parent keeps
await rlm.run("audit rlm packages", { context: ["files.*", "backup.*"] })
// move — parent loses (explicit offload)
await rlm.run("offload auth", { contextMove: ["auth.*"] })
// also: contextStrategy: "move" makes `context:` behave as move
```

Micro-behaviour power flags (all `true` by default, no LLM needed to toggle): `enableClone`, `enableMutate`, `enableBulkOps`, `enableSubagentTransfer` — plus the UI flags above. Harness is most powerful without you asking.

---

## Config

Plugins are composed in `cordis.yml` and per-plugin config lives right there. Every flag is optional — all features default on.

```yml
# cordis.yml (excerpt) — add plugins, reorder, or toggle flags without restarting
- id: tui
  name: './packages/rlm-tui/src/index.ts'

- id: prompt
  name: './packages/rlm-prompt/src/index.ts'

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
    # keybindings: { "panel.toggle": "enter", "panel.navUp": "k,ArrowUp" }
    # — power micro-behaviours (all true by default) —
    enableClone: true
    enableMutate: true
    enableBulkOps: true
    enableSubagentTransfer: true

- id: code
  name: './packages/rlm-code/src/index.ts'
  config:
    timeout: 60000
    maxOutputChars: 65536

- id: sdk
  name: './packages/rlm-sdk/src/index.ts'
  config:
    maxDepth: 10
    defaultModel: auto/best-free
```

Full order today is `config → context, tui, prompt → session, tools, refine, code, workflow, learn → agent → renderer, print, sdk` (see `cordis.yml` in repo). Drop a plugin, change a flag, save — HMR picks it up.

### Data paths

- **Project-level**: `.rlm/` in the project root (context, sessions, skills)
- **Global**: `~/.rlm/agent/` (settings, sessions, skills, extensions, workflows, memory)
- **Bundled**: `cordis.yml` in the rlm repo (plugin composition)

| Path | Level | Contents |
|------|-------|----------|
| `~/.rlm/agent/settings.json` | Global | Provider, model, maxDepth, thinking level |
| `~/.rlm/agent/sessions/` | Global | JSONL session persistence |
| `~/.rlm/agent/skills/` | Global | Installed skills |
| `~/.rlm/agent/extensions/` | Global | Installed extensions |
| `~/.rlm/agent/workflows/` | Global | Hot-swappable TS workflows |
| `~/.rlm/agent/memory/` | Global | Persistent key-value memory |
| `~/.rlm/runtimes/` | Global | User plugin overrides (`.mjs` + `.json`) |
| `~/.rlm/config.json` | Global | Auth config |
| `.rlm/context.json` | Project | Project-scoped context variables |
| `cordis.yml` | Bundled | Cordis plugin composition |

---

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
5. Agent continues using the new service — including prompt fragments and UiProvider handover

No restart required. The process stays foreground — exits when terminal closes.

## Model

OmniRoute-only. Default model: `auto/best-free`. Configured in `cordis.yml` and `~/.rlm/agent/settings.json`.

## Recursive subagents

The SDK plugin spawns child agent loops with incremented depth. Depth limit (default 10) prevents infinite recursion. Context variables are copied to children by default; `context.move()` or `contextMove`/`contextStrategy: "move"` transfers ownership. Batch and clone helpers let you prep context before spawning — `cloneMany` to backup, `mutate` to filter, then `rlm.run`.

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

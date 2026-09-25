# @rlm/thinking-steps

[pi-thinking-steps](https://github.com/crustyhacker/pi-thinking-steps) v1.0.11 (MIT, commit d0a59a4) as an rlm row. Thinking renders as steps in three modes — `collapsed`, `summary` (default), `expanded` — cycled with **Alt+T** or set with `/thinking-steps [project|global] <mode|clear>`. See `README.md` (upstream) for the full behaviour.

## Why a row and not an extension

Upstream is a pi extension whose `session_start` patches `AssistantMessageComponent.prototype`. In rlm that alone never reaches the screen in two cases: a row added to an rlm that is already running (no `session_start` comes), and daemon mode (the extension runs in the worker; the client draws). So `src/row.ts`, imported natively by bun in every process that mounts it:

1. installs the render patch itself at mount and releases it on removal (on-screen messages repaint once, via a generation check on `render()`);
2. contributes the unchanged extension (commands, Alt+T, streaming state) through `globalThis.__rlmExtensionFactories` and emits `rlm/resources-changed` so live sessions attach or drop it at once;
3. restores the saved project/global mode where no extension runs, and carries mode changes between rlm processes through `~/.rlm/agent/state/thinking-steps.live.json`.

## Adaptations (everything else in `src/` is upstream verbatim)

| File | Change | Why |
|---|---|---|
| `tsconfig.json` | `paths` map `@mariozechner/pi-{coding-agent,tui,ai}` → `../{coding-agent,tui,ai}/src/index.ts` | bun honours tsconfig paths at runtime, so upstream imports stay as written and resolve to the live workspace sources |
| `src/internal-patch.ts` | internal module paths `dist/...js` → `src/...ts` | the TUI runs `src/` as TypeScript; `dist/` is a stale copy |
| `src/internal-patch.ts` | renderer installed on rlm's `reconcile()` when present, fallbacks call the original `reconcile()` | rlm's component is lazy (`updateContent` only marks dirty; `render()` calls `reconcile()`), so patching `updateContent` would be overwritten on the next dirty frame |
| `src/internal-patch.ts` | reuse text `Markdown` (via `setText`) and the steps component across updates of one message; re-derive steps at most every 150ms (or 4× the last derive time) while thinking streams, always exactly once it ends; `invalidate()` drops the reuse | upstream rebuilt everything per token: 12.65ms/token vs rlm's 1.35 over a 1,500-token reply, 24.74ms/token over a 3,000-token trace |
| `src/internal-patch.ts` | keep rlm's tail: `↻ … — retried`, login-recovery error component, abort shown with tool calls, spacer before tool blocks | only the thinking rendering should change |
| `src/internal-patch.ts` | after a setter fallback the component stays on the native renderer | upstream semantics, needed because rlm renders lazily |
| `src/internal-patch.ts` | rlm's Ctrl+T (`hideThinkingBlock`) picks the mode: hidden → `summary` tree, visible → `expanded`; upstream's setter semantics kept (value tracked separately) | the plugin owns thinking display; no more `Thinking... ·` row |
| `src/internal-patch.ts` | raw `<think>`/`</think>`/`<thinking>` stripped from step text | defensive; the provider layer strips them too |
| `src/state.ts` | `onThinkingStepsModeChange` listeners on the shared state | cross-process mode sync |
| `src/persistence.ts` | `.pi/` → `.rlm/`, `~/.pi/agent/state` → `~/.rlm/agent/state` | rlm's config dirs |
| `test/*.ts` | imports → `../src/`, the path/`.pi` expectations above, `reconcile` identity in the concurrency test; npm-publishing metadata test skipped | same adaptations; the row is not an npm package |

Ctrl+T (`app.thinking.toggle`) still toggles the "Thinking blocks: hidden/visible" status, but as upstream intends the steps stay visible — Alt+T (collapsed/summary/expanded) is its equivalent.

## Tests

- `bun run test` (upstream suites under node + tsx): 153 pass, 0 fail, 1 skipped.
- `bun test test/rlm-integration.test.ts`: row registration, rlm's live component with a real MiniMax inline-`<think>` stream, retried errors, streaming throttle, theme invalidate, patch release.

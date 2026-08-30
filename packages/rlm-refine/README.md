# @rlm/refine

Continual harness refinement and self-evolution system.

## Overview

Wraps the coding-agent refinement functions as a Cordis service. Provides planning, execution, and auto-refine review for the harness state (memories, skills, prompt addenda, subagent specs). Registers a mandatory prompt doctrine at priority 70 instructing the agent to persist learnings when it observes repeated failures or reusable patterns. Supports both local (session-scoped) and global (cross-session) refinement.

## Configuration

No configurable options (`RlmRefineConfig` is empty). The agent directory is resolved from `@rlm/config`.

## Dependencies

- `@rlm/config` (`rlmConfig`) — provides `agentDir` for harness state directory resolution
- `@rlm/prompt` — registers refine doctrine prompt fragment (optional, retries on load)

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `planRefinement(messages, state, history, model, apiKey, options?, headers?, signal?, thinking?)` | `Promise<RefinementPlan>` | Analyze messages and propose a refinement plan |
| `refineHarness(messages, state, history, model, apiKey, options?, headers?, signal?, thinking?)` | `Promise<RefinementResult>` | Execute refinement and return result |
| `reviewAutoRefine(messages, state, history, model, apiKey, context, headers?, signal?, thinking?)` | `Promise<AutoRefineReview>` | Auto-refine review on tool_error / tool_discovery |
| `loadHarnessState(dir?, scope?)` | `HarnessState` | Load harness state from disk |
| `saveHarnessState(dir, state)` | `string` | Persist harness state to disk |
| `applyRefinementProposal(proposal, state, options)` | `RefinementResult` | Apply a proposal to harness state |
| `getGlobalHarnessStateDir()` | `string` | Global harness state directory path |
| `getLocalHarnessStateDir(sessionDir?)` | `string \| undefined` | Local (session) harness state directory |

## Usage

```ts
const refine = ctx.get("rlmRefine");

// Load current harness state
const state = refine.loadHarnessState(undefined, "global");

// Plan a refinement from conversation history
const plan = await refine.planRefinement(
  messages, state, history, model, apiKey,
  { scope: "global" }
);

// Execute refinement
const result = await refine.refineHarness(
  messages, state, history, model, apiKey,
  { scope: "global" }
);

// Auto-refine review (triggered on tool_error / 5+ tool calls)
const review = await refine.reviewAutoRefine(
  messages, state, history, model, apiKey,
  { trigger: "tool_error", toolName: "code" }
);

// Apply a proposal manually
const applied = refine.applyRefinementProposal(proposal, state, {
  id: "refine-001",
  scope: "global",
});
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. The prompt doctrine fragment is disposed and re-registered on restart, emitting `rlm/prompt-changed`. Harness state on disk persists across hot-swaps. The `rlmRefine` service itself is hot-reloadable — refine logic can be updated without losing session state.

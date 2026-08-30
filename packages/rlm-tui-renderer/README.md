# @rlm/tui-renderer

InteractiveMode TUI as a Cordis Service.

## Overview

Wraps the coding-agent `InteractiveMode` behind a service. Creates the full agent runtime via `@rlm/agent`, wires up an `InProcessAgentConnection` and local session host, initializes the theme, and launches the interactive TUI. Supports full UI provider replacement via `@rlm/tui` — if a provider with a `render` method is active, session events are forwarded to it. Listens to provider-changed, config-changed, keybindings-changed, and followup-send events for hot-swap without restart.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cwd` | `string` | `process.cwd()` | Working directory passed to the agent runtime |

## Dependencies

- `@rlm/agent` (`rlmAgent`) — provides `createRuntime()` for the full agent runtime
- `@rlm/tui` (`rlmTui`) — resolved at runtime for UI provider access and event forwarding (optional, degrades to ctx events)

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `start(opts?)` | `Promise<InteractiveModeRunResult>` | Create runtime, wire connection, launch InteractiveMode |
| `stop()` | `Promise<void>` | Stop InteractiveMode and dispose the runtime |
| `getTui()` | `any` | Resolve the rlmTui service (ctx or globalThis fallback) |
| `forwardEvent(type, payload)` | `void` | Forward an event to the active UI provider |

`RlmRendererStartOptions`: `{ initialMessage?, initialMessages?, verbose? }`

## Usage

```ts
const renderer = ctx.get("rlmRenderer");

// Launch the interactive TUI
const result = await renderer.start({
  initialMessage: "Hello, what can you do?",
  verbose: true,
});

// Stop when done
await renderer.stop();

// With a custom UI provider registered via @rlm/tui:
const tui = renderer.getTui();
tui.registerUiProvider("my-plugin", {
  id: "custom-ui",
  priority: 100,
  render: (ctx) => ["Custom rendering at width " + ctx.width],
});
// Events from the agent session are forwarded to the provider automatically
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. All event listeners (provider-changed, config-changed, keybindings-changed, followup-send, component-registered) are disposed via `ctx.effect()` cleanup. If `InteractiveMode` is running during a provider hot-swap, event forwarding continues to the new active provider without restart. The `InteractiveMode` instance and runtime are disposed on `[Symbol.dispose]()`.

# @rlm/tui

TUI extension service — slash commands, status bar items, components, and UI providers.

## Overview

Provides extension points so any plugin can add slash commands, status bar items, custom components, and full UI provider overrides to the TUI without modifying core TUI code. When a plugin is hot-swapped or removed, its extensions are automatically unregistered and the TUI rolls back to its core state. Also manages generic TUI micro-plugins: followup queue, double-enter send, hjkl navigation, and configurable keybindings.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `followupQueueUi` | `boolean` | `true` | Enable followup queue while streaming |
| `doubleEnterToSend` | `boolean` | `true` | Double-Enter sends queued followups |
| `autoFocusTyping` | `boolean` | `true` | Auto-focus input on any typing key |
| `hjklNavigation` | `boolean` | `true` | Enable hjkl navigation keys |
| `keybindings` | `Record<string,string>` | `DEFAULT_TUI_KEYBINDINGS` | Override any keybinding (see defaults) |

Default keybindings: `context.toggle`→`enter`, `context.navUp`→`k,ArrowUp`, `context.navDown`→`j,ArrowDown`, `context.scrollUp`→`ctrl+u,pageup`, `context.scrollDown`→`ctrl+d,pagedown`, `panel.toggleAll`→`ctrl+o`.

## Dependencies

None — standalone extension registry.

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `registerSlashCommand(pluginId, ext)` | `ExtensionHandle` | Add a `/command` to the TUI |
| `registerStatusBarItem(pluginId, ext)` | `ExtensionHandle` | Add a status bar item |
| `registerComponent(pluginId, ext)` | `ExtensionHandle` | Add a custom render component |
| `registerUiProvider(pluginId, provider)` | `ExtensionHandle` | Register full UI override (highest priority wins) |
| `registerRendererOverride(pluginId, provider)` | `ExtensionHandle` | Alias for `registerUiProvider` |
| `getSlashCommands()` | `SlashCommandExtension[]` | All registered slash commands |
| `getStatusBarItems()` | `StatusBarItemExtension[]` | All status bar items |
| `getComponents()` | `ComponentExtension[]` | All custom components |
| `getActiveProvider()` | `UiProvider \| undefined` | Currently active UI provider |
| `getKeybindings()` / `getKeybinding(action)` | `Record<string,string>` / `string` | Resolved keybindings |
| `updateKeybindings(patch)` | `void` | Patch keybindings at runtime |
| `updateConfig(patch)` | `void` | Patch TUI flags at runtime |
| `enqueueFollowup(text)` | `void` | Queue a followup message |
| `clearFollowupQueue()` | `string[]` | Clear and return queued followups |
| `handleFollowupKey(key)` | `boolean` | Double-Enter detection (returns true if sent) |
| `setRenderCallback(cb)` | `void` | Called by TUI to register re-render trigger |

## Usage

```ts
const tui = ctx.get("rlmTui");

// Register a slash command
tui.registerSlashCommand("my-plugin", {
  name: "/hello",
  description: "Say hello",
  handler: async (args, ctx) => ctx.showMessage(`Hello ${args}!`),
});

// Register a status bar item
tui.registerStatusBarItem("my-plugin", {
  id: "clock",
  renderer: (ctx) => new Date().toLocaleTimeString(),
});

// Register a custom component
tui.registerComponent("my-plugin", {
  id: "banner",
  renderer: (ctx) => [`Width: ${ctx.width}`],
});

// Register a full UI provider (priority-based)
tui.registerUiProvider("my-plugin", {
  id: "custom-ui",
  priority: 100,
  activate: (api) => console.log("activated"),
  render: (ctx) => ["Custom UI rendering"],
});
```

## Hot-Swap

Each registration returns a handle with `dispose()`. When a plugin's Cordis fiber is disposed, its handles are disposed too, removing extensions from the registry. The TUI re-renders after each registration/unregistration. Keybindings and config flags are patchable at runtime via `updateKeybindings()` / `updateConfig()` — both emit events (`rlm/tui-keybindings-changed`, `rlm/tui-config-changed`) that trigger re-render.

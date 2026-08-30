# @rlm/config

Settings, model registry, and auth storage as a Cordis Service.

## Overview

Foundation plugin with zero dependencies. Provides `SettingsManager`, `ModelRegistry`, and `AuthStorage` to every other plugin via dependency injection. All other rlm plugins inject `rlmConfig` to access the agent directory, cwd, and credential storage.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentDir` | `string` | `getAgentDir()` | Directory for agent state (auth.json, harness state) |
| `cwd` | `string` | `process.cwd()` | Working directory passed to settings manager |

## Dependencies

None — this is the root plugin.

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `getSettingsManager()` | `SettingsManager` | Project + global settings (theme, cwd, model prefs) |
| `getModelRegistry()` | `ModelRegistry` | Available models keyed by provider |
| `getAuthStorage()` | `AuthStorage` | API keys / OAuth tokens from `auth.json` |

## Usage

```ts
import { RlmConfig } from "@rlm/config";

// In cordis.yml or programmatically:
ctx.plugin(RlmConfig, { agentDir: "~/.rlm/agent", cwd: process.cwd() });

// Other plugins access it:
const config = ctx.get("rlmConfig");
const settings = config.getSettingsManager();
const models = config.getModelRegistry();
const auth = config.getAuthStorage();
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. Downstream plugins that inject `rlmConfig` are restarted automatically when the service is disposed and recreated.

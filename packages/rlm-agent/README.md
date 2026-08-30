# @rlm/agent

AgentSession runtime as a Cordis Service.

## Overview

Core plugin that wraps `createAgentSessionRuntime` behind a service so other plugins (renderer, print) can build full agent runtimes via dependency injection instead of importing coding-agent internals. Creates `AgentSessionServices` (settings, model registry, auth, tools) and `AgentSessionRuntime` (session + services + runtime metadata). This is the integration point that ties config, session, tools, and refine together into a runnable agent.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cwd` | `string` | From `rlmConfig.settingsManager` | Working directory for the agent |
| `agentDir` | `string` | `getAgentDir()` | Agent state directory |

## Dependencies

- `@rlm/config` (`rlmConfig`) — settings manager, model registry, auth storage
- `@rlm/session` (`rlmSession`) — session manager for session creation
- `@rlm/tools` (`rlmTools`) — tool registry (injected, used for service creation)
- `@rlm/refine` (`rlmRefine`) — refine runtime (injected, used for service creation)

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `createServices(opts?)` | `Promise<AgentSessionServices>` | Create a fresh services bundle (cwd, agentDir, auth, settings, models) |
| `createSession(opts?)` | `Promise<CreateAgentSessionResult>` | Create an agent session from services + session manager |
| `createRuntime(options?)` | `Promise<AgentSessionRuntime>` | Create the full runtime (services + session + metadata) |
| `getServices()` | `AgentSessionServices \| undefined` | The shared services bundle created at init |

## Usage

```ts
const agent = ctx.get("rlmAgent");

// Create the full runtime (what InteractiveMode and print mode need)
const runtime = await agent.createRuntime({
  sessionConfig: { model: "omniroute/auto" },
  sessionOptions: { thinking: "high" },
});

// Or create services + session separately
const services = await agent.createServices({ cwd: "/my/project" });
const session = await agent.createSession({ services });

// The runtime is ready to wire into a UI mode
// (see @rlm/tui-renderer for InteractiveMode, @rlm/print for print mode)
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. The `AgentSessionServices` bundle is recreated on restart from the current `rlmConfig` / `rlmSession` state. Existing runtimes created before the swap remain valid until disposed; new calls produce fresh runtimes with updated service configuration.

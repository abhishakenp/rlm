# @rlm/tools

Tool registry (code, edit) as a Cordis Service.

## Overview

Wraps the coding-agent tool definitions behind a service so other plugins can resolve tools via dependency injection instead of importing coding-agent internals directly. Provides factory methods for creating all tool definitions or just the code tool, with configurable timeout and output limits.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `undefined` | Default timeout for the code tool (ms) |
| `maxOutputChars` | `number` | `undefined` | Max output chars before truncation |

## Dependencies

- `@rlm/config` (`rlmConfig`) — provides default `cwd` for tool execution

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `createTools(cwd?, options?)` | `ToolDefinition[]` | All tool definitions (code, edit, etc.) |
| `createCodeTool(cwd?, options?)` | `Tool` | Code execution tool instance |
| `createCodeToolDefinition(cwd?, options?)` | `ToolDefinition` | Code tool definition for agent registration |

## Usage

```ts
import { RlmTools } from "@rlm/tools";

ctx.plugin(RlmTools, { timeout: 60000, maxOutputChars: 131072 });

const tools = ctx.get("rlmTools");
const allTools = tools.createTools(process.cwd());
const codeTool = tools.createCodeTool(process.cwd(), { timeout: 120000 });
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. The service re-reads `cwd` from `rlmConfig` on restart. Existing tool instances created before the swap remain valid; new calls produce fresh instances with updated config.

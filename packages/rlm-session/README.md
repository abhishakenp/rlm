# @rlm/session

SessionManager as a Cordis Service.

## Overview

Wraps the coding-agent `SessionManager` behind a Cordis service so other plugins can resolve session management via dependency injection. Handles session creation, persistence, and artifact directories. Depends on `@rlm/config` for the working directory used to compute the default session directory.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessionDir` | `string` | `getDefaultSessionDir(cwd)` | Directory for session artifacts |

## Dependencies

- `@rlm/config` (`rlmConfig`) — provides `cwd` for default session directory resolution

## Service API

| Method | Returns | Description |
|--------|---------|-------------|
| `getSessionManager()` | `SessionManager` | The underlying session manager instance |

## Usage

```ts
import { RlmSession } from "@rlm/session";

ctx.plugin(RlmSession, { sessionDir: "~/.rlm/sessions" });

const session = ctx.get("rlmSession");
const manager = session.getSessionManager();
// manager.createSession(), manager.getSession(id), etc.
```

## Hot-Swap

Editing this file triggers `fiber.restart()` → fresh import. The `SessionManager` instance is recreated on restart. Session artifacts on disk persist across hot-swaps; only the in-memory manager handle is replaced.

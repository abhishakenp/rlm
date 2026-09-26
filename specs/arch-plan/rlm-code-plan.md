# RLM Code Plan — `~/proj/rlm`

Architecture: `../2026-09-07T18-47-iris-rlm-omniroute-provisioner-ecosystem-rewrite.md`
Cross-project index: `README.md`

## Scopes Owned

| Scope | What | Cross-project deps | Status |
|---|---|---|---|
| 5 (rlm side) | worker pool: fix pool-worker bug, extend AgentPool, add rlm-integration | none (build against current RLM) | done |
| 5b (rlm side) | memory reduction: in-process workers, shared pixel, lazy load coding-agent | needs Scope 5 | done |
| 11 (rlm side) | session-management API endpoints in rlm-integration | needs Scope 5 | done |

## Current State (from research)

- RLM is already a Cordis host (`cordis-shell.mjs` + `cordis.yml`)
- `AgentPool` (`packages/rlm-delegate/src/pool.ts:190-710`) already implements persistent workers via Node IPC
- `rlm-integration` HTTP service exists (`packages/rlm-integration/src/index.ts`) but:
  - NOT in default `cordis.yml`
  - Proxies to upstream provider, NOT to RLM agent
  - No session-management endpoints
- `rlm-sdk` is in-process recursion — NOT safe for multi-tenant (shared `rlmCode` VM, global `__rlmTaskContextSnapshot`)
- Hybrid model: persistent control-plane host + isolated per-request child/pool execution

## Scope 5 (rlm side): worker pool extension

### Files
| File | Line(s) | Change |
|---|---|---|
| `packages/rlm-delegate/src/pool.ts` | 190-710 | Add heartbeat, per-session lock, graceful drain, streaming chunks |
| `packages/rlm-delegate/src/pool.ts` | 209-217 | Remove `maxWorkers` static default (4), use `ceiling()` from Scope 6 |
| `packages/rlm-delegate/src/pool.ts` | 209-211 | Remove `slots` static default (8), make resource-based per-worker |
| `packages/rlm-delegate/src/pool-worker.ts` | 245, 574 | **CRITICAL BUG FIX**: agent type mismatch |
| `packages/rlm-delegate/src/pool-worker.ts` | 234 | Stream events instead of one final chunk |
| `packages/rlm-delegate/src/pool-worker.ts` | new | Worker-side resource check: refuse new tasks when own `process.memoryUsage()` exceeds threshold |
| `packages/rlm-delegate/src/index.ts` | 574 | Pass `ctx.get('rlmAgent')` instead of `rlmAgent` |
| `packages/rlm-delegate/src/index.ts` | new | Add public `delegate()` API |
| `packages/rlm-delegate/src/index.ts` | 1121 | Replace `Math.ceil(capacity().limit / slots)` with `ceiling()` from Scope 6 |
| `packages/rlm-integration/src/index.ts` | 83-213 | Add session-management endpoints, inject rlmDelegate |
| `cordis.yml` | after line 218 | Add `rlm-integration` row |
| `packages/rlm-headless/src/index.ts` | 123-168 | Add heartbeat config fields |
| `packages/rlm-headless/src/index.ts` | 167 | `childPoolSlots` becomes resource-based — remove static `DEFAULT_POOL_SLOTS = 8` |

### Resource-based admission (shared with Iris Scope 6)
RLM's `AgentPool` must use the same `ceiling()` logic as Iris's `iris-rlm`:
- `ceiling()` checks only memory: `<20% free → 1 worker, else spin until <20%`
- No FD pre-limiting, no CPU pre-limiting — OS handles EMFILE/ENOMEM, we catch them
- `maxWorkers` getter (default 4) → removed, replaced by `ceiling()`
- `slots` getter (default 8) → removed, worker accepts tasks until memory-constrained
- `childPoolSlots` in `rlm-headless` (default 8) → removed, worker accepts tasks until memory-constrained
- `queueLimit` stays (queue safety valve, not concurrency)
- `maxTasksPerWorker` stays (memory-leak prevention, not concurrency)

See `~/proj/sensei/iris-mama/specs/arch-plan/iris-code-plan.md` Scope 6 for the `ceiling()` implementation.

### Measured worker cost (for reference, NOT used as limits)
Measured on M3 16GB via `ps -o rss` on running `bun cordis-shell.mjs --print`:

**Current (eager-load everything):**
- Full composition (27 plugins): 178MB
- pixel child (separate process, one-time indexing): 335MB
- Worker FDs: 31 total (22 worker + 9 pixel child) — measured via `lsof -p`
- Delegation latency: median 16.8s, avg 95.5s — measured from 273 journal entries

**Memory breakdown (plugin removal experiments):**
| Composition | RSS |
|---|---|
| Full (27 plugins) | 178MB |
| Minimal pool worker (9 plugins) | 122MB |
| Absolute minimum (3: boot+headless+agent) | 108MB |
| Loader only (no plugins) | ~50MB |

**Post-plan targets (based on measured components, NOT verified):**
- Pool worker boots minimal composition: 122MB (measured) instead of 178MB
- Shared pixel: 335MB once, not per worker (architectural change)
- Lazy loading: idle below 122MB (not implemented)
- Eager offloading: unload after task (not implemented)
- 10 workers: ~1,555MB instead of ~5,130MB (70% reduction)

### CRITICAL BUG: pool-worker agent type mismatch

**Problem:** `PoolWorkerOptions.agent` (line 245) is typed `Runner` (a function `(task, graph) => Promise<string>` from `scheduler.ts:28`). But `runOne` at line 159 calls `agent.createRuntime({ sessionManager })` — which doesn't exist on `Runner`. The pool-worker mode at `index.ts:574` passes `rlmAgent` from `agent.ts` (a `Runner` factory), not the Cordis service.

**Fix:**
1. Change `PoolWorkerOptions.agent` type to `{ createRuntime(opts: { sessionManager?: SessionManager }): Promise<AgentSessionRuntime> }`
2. In `index.ts:574`, change `agent: rlmAgent` to `agent: this.ctx.get('rlmAgent')` (the Cordis service from `packages/rlm-agent/src/index.ts` which has `createRuntime` at line 208)
3. Verify `rlmAgent` service is loaded before pool-worker mode is claimed

### pool.ts — heartbeat (new)
Add `heartbeatMs` (default 5000) and `heartbeatTimeoutMs` (default 15000) to `PoolOptions`. Add `PoolReply` type:
```ts
| { type: "heartbeat"; id: string; ts: number }
```
Parent tracks last heartbeat per worker. On timeout, kill worker and requeue its tasks.

### pool.ts — per-session lock (new)
```ts
private sessionLocks = new Map<string, Promise<void>>()
private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(r => release = r)
  this.sessionLocks.set(sessionId, prev.then(() => next))
  await prev
  try { return await fn() } finally { release(); if (this.sessionLocks.get(sessionId) === next) this.sessionLocks.delete(sessionId) }
}
```

### pool.ts — graceful drain (new)
Add `drain(timeoutMs: number): Promise<void>`. Stop accepting new tasks. Wait for in-flight (bounded by timeout). Kill workers on timeout.

### pool-worker.ts — stream events (line 234)
Instead of one `onChunk(text)`, subscribe to connection events:
```ts
connection.subscribe((event) => {
  if (event.type === 'assistant_message' || event.type === 'tool_call') {
    send({ type: 'chunk', id: request.id, text: JSON.stringify(event) })
  }
})
```

### rlm-integration — session endpoints (new)
```
POST /v1/delegate       — { prompt, session?, timeout? } → { ok, output, ms, events }
POST /v1/sessions       — create session → { id }
DELETE /v1/sessions/:id — cancel + cleanup
GET /v1/sessions        — list active
GET /v1/health          — existing
```
Inject `rlmDelegate` service. Route `/v1/delegate` to `rlmDelegate.delegate()`.

### rlm-delegate — public delegate API (new)
```ts
async delegate(opts: { prompt: string; session?: string; timeout?: number }): Promise<{ ok: boolean; output: string; ms: number; events: string[] }> {
  const { graph, taskId } = this.intake(opts.prompt)
  await this.drive({ signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined })
  // Extract result from store
}
```

### cordis.yml — add integration row (after line 218)
```yaml
- id: integration
  name: './packages/rlm-integration/src/index.ts'
  config:
    port: 20129
    host: localhost
    enabled: true
```

### rlm-headless — heartbeat config
Add `workerHeartbeatMs` (default 5000) and `workerHeartbeatTimeoutMs` (default 15000) to `RlmHeadlessConfig`.

### Test
```bash
cd ~/proj/rlm
npm run check
# Start RLM with integration:
node cordis-shell.mjs --headless
# Test delegate:
curl -X POST http://localhost:20129/v1/delegate \
  -H 'content-type: application/json' \
  -d '{"prompt":"say hello","timeout":30000}'
```

### Rollback
Remove `rlm-integration` row from `cordis.yml`. Pool-worker fix is backward-compatible (type widening).

### Hot-reload
`rlm-integration` row addition is hot-reloadable. Pool workers drain on unload.

### Cross-project: unblocks iris/Scope 5 + iris/Scope 11
Once RLM is serving `/v1/delegate`, Iris can switch `useHttp: true`.

---

## Scope 5b (rlm side): memory reduction — in-process workers, shared pixel, lazy load coding-agent

### Goal
Reduce per-worker memory from 90MB (child process, measured with Bun Rust 1.4.3) to ~100KB (in-process session state, measured). Share pixel's 332MB indexing across all workers.

### Measured baseline (all via `ps -o rss` and session file analysis)
| Component | Bun 1.3.14 (Zig) | Bun 1.4.3 (Rust) | How measured |
|---|---|---|---|
| Bun runtime (empty) | 27MB | 9MB | `ps -o rss` on `bun -e ""` |
| Minimal composition (9 plugins) | 122MB | 90MB | `ps -o rss` on `bun cordis-shell.mjs --print` |
| Full composition (27 plugins) | 178MB | 152MB | same |
| coding-agent framework | ~50MB | ~45MB | 92,663 lines, dominant plugin cost |
| Session state (median) | 14KB | 14KB | 6,216 session files analyzed |
| pixel child (shared) | 335MB | 332MB | `ps -o rss` on child PID |

**Bun 1.4.3 (Rust rewrite, merged May 2026) cuts runtime RSS 67% and minimal composition 26%.** Plan should require Bun ≥1.4.x.

### Architecture: in-process workers (default), child process fallback

| Tier | Isolation | Cost/worker | When |
|---|---|---|---|
| **In-process** (default) | Per-task VM context, no globals | ~100KB (session state only) | All trusted tasks |
| **Child process** (fallback) | Full process isolation | 122MB | Crash-prone or untrusted tasks |

Worker threads dropped — in-process is safe with per-task VM fix, and session state is negligible (100KB). No need for the 79MB/thread tier.

**Multiplexing applies to both** — each worker handles multiple sessions over its lifetime. No spawn-per-turn.

### 50-worker fleet memory
| Architecture | Bun Zig (1.3.14) | Bun Rust (1.4.3) | Saving |
|---|---|---|---|
| Current (50 child processes) | 6,100MB | 4,600MB | — |
| In-process (median sessions) | 127MB | 95MB | 98% |
| In-process + shared pixel | 462MB | 427MB | 91% |
| In-process + lazy load | 55MB idle / 127MB | 45MB idle / 95MB | 98% |

### Changes

#### 1. In-process workers (default tier)
Fix the two safety issues that currently prevent in-process execution:

**Fix A: Per-task VM context** (`packages/rlm-code/src/index.ts`)
- Current: ONE `vm.Context` at line 60, shared across all tasks (persistent kernel namespace)
- Fix: Context pool — `Map<taskId, vm.Context>`. Each task gets its own VM context. Context recycled when task completes.
- The "persistent variables across calls" feature becomes per-task, not global. This is correct — tasks shouldn't share kernel state.

**Fix B: Remove `__rlmTaskContextSnapshot` global** (`packages/rlm-sdk/src/index.ts:332`)
- Current: `(globalThis as any).__rlmTaskContextSnapshot = snapshot` — concurrent tasks overwrite each other
- Fix: Pass snapshot as parameter to `createAgentSessionFn`. Only 1 occurrence in entire codebase.
- Search confirmed: `grep -c __rlmTaskContextSnapshot` = 1 occurrence, only in `rlm-sdk/src/index.ts`

**Fix C: In-process pool worker** (`packages/rlm-delegate/src/pool.ts`)
- Current: `spawn(bin, args, ...)` at line 518 — creates child process per worker
- Fix: Add `InProcessWorker` class that runs `runPoolWorker` as async task within host process
- `AgentPool` uses in-process by default, child process as fallback
- Escalation policy: configurable (e.g. `escalateAfterMs`, `escalateOnErrorCount`)

#### 2. Shared pixel index
- One pixel process serves all workers via IPC, not one per worker
- `packages/rlm-pixel/src/index.ts`: add IPC server mode
- `packages/rlm-delegate/src/pool.ts`: spawn shared pixel process, pass handle to workers
- 335MB once, not per worker

#### 3. Lazy load coding-agent (50MB saving)
- Load coding-agent framework (~50MB, 92K lines) only when first task arrives, not at boot
- Host idle: ~55MB (runtime + loader + boot + headless + essentials)
- Host active: 122MB (coding-agent loaded)
- Requires: deferred import of `agent-session.ts` and `session-manager.ts` in `rlm-agent/src/index.ts`
- Verify: does Cordis support deferred plugin initialization?

### Files
| File | Change |
|---|---|
| `packages/rlm-code/src/index.ts` | Per-task VM context pool (Fix A) |
| `packages/rlm-sdk/src/index.ts` | Remove globalThis, pass as param (Fix B) |
| `packages/rlm-delegate/src/pool.ts` | Add InProcessWorker, child process fallback (Fix C) |
| `packages/rlm-pixel/src/index.ts` | IPC server mode for shared indexing |
| `packages/rlm-agent/src/index.ts` | Lazy import coding-agent (defer until first task) |

### Test
```bash
# In-process: delegate 10 concurrent tasks — verify 10 sessions in 1 process, ~127MB total
# Fallback: delegate crash-prone task — verify escalates to child process
# Shared pixel: delegate 5 code tasks — verify 1 pixel process, not 5
# Per-task VM: delegate 2 tasks that set kernel variables — verify no cross-contamination
# Multiplexing: delegate 50 sequential tasks to 1 in-process worker — verify no restart
# Lazy load: verify host is ~55MB before first task, ~122MB after
```

### Depends on: Scope 5 (pool worker must work first)

### Implementation status (reconciled)

| Item | Status | Notes |
|---|---|---|
| Fix A: Per-task VM context | done | `packages/rlm-code/src/index.ts` — `Map<taskId, vm.Context>`, bounded to 64, `disposeTaskContext(taskId)`. Tests: 7 pass. |
| Fix B: Remove globalThis snapshot | done | `__rlmTaskContextSnapshot` removed; snapshot passed as explicit `rlmTaskContextSnapshot` parameter. |
| Fix C: In-process worker | done | `packages/rlm-delegate/src/in-process-worker.ts` — `InProcessWorker` + `InProcessChild`. Pool hires in-process by default when `ctx`+`agent` supplied; child-process fallback preserved. Tests: 9 pass. |
| Lazy load coding-agent | done | `packages/rlm-agent/src/index.ts` — type-only top-level imports, cached dynamic loaders (`loadCodingAgent`, `loadAgentRuntime`, `loadAgentConfig`). Tests: 2 pass. |
| Shared pixel IPC | superseded | The original plan was a custom IPC server in `rlm-pixel`. Pixel v0.1.0 ships its own per-repo daemon (`pixel daemon`) that provides shared indexing. The `rlm-pixel` plugin warms the index via `pixel ready .` instead of spawning a custom IPC process. The daemon is the shared-pixel mechanism now. |

### FD limits — already handled by Bun
Bun auto-raises FD limits at startup (measured):
- macOS: 256 → 61,435 FDs (measured via openSync until EMFILE)
- Linux (a2): 1,024 → 524,275 FDs (measured same way)
- GitHub Actions: UNVERIFIED — Bun should auto-raise, but not tested on runner

No manual `ulimit` or `setrlimit` needed in RLM boot. Bun handles it.
At ~3 FDs per in-process session: ~20K sessions (macOS), ~174K sessions (Linux).
Still catch EMFILE at runtime as safety valve — but it should never fire in practice.

---

## Scope 11 (rlm side): session-management API

### Files
| File | Change |
|---|---|
| `packages/rlm-integration/src/index.ts` | Full session CRUD endpoints |

### Endpoints
```
POST /v1/sessions       — { cwd?: string } → { id }
GET /v1/sessions        — → { sessions: [{ id, status, tasks }] }
POST /v1/sessions/:id/spawn — { prompt, timeout? } → { ok, output, ms }
POST /v1/sessions/:id/cancel — → { ok }
DELETE /v1/sessions/:id — → { ok }
```

### Cross-project dependency
Needs rlm/Scope 5 (delegate API must work first).

# Cordis: A Primer for Agents

## Cordis in five ideas

1. **You are a plugin tree.** Every capability is a row in a configuration file. Rows can be reconfigured, switched off, or added while you run — no restart needed.

2. **`self` is your wiring.** From a code cell, `self` is your handle on the plugin tree. Use it to inspect rows (`self.rows()`), call services (`self.call(svc, method, ...args)`), change config (`self.config.set(id, key, value)`), and manage plugins (`self.plugin.*`).

3. **Config changes are hot.** Every `self.config.*` call takes effect immediately. Changes are written to an overlay, never to the shipped config — deleting the overlay returns you to stock.

4. **Plugins are Services.** A plugin is a `Service` subclass with a `static provide` method imported from `@deepseek-ai/cordis`. Mount returns only when the row is ACTIVE; if it fails to start it switches back off rather than staying broken.

5. **Context is the memory.** Use `context.set/get/update/mutate/clone/delete` to store facts, findings, and decisions. Scope determines lifetime: `project` (survives sessions), `session` (this session), `task` (passed to subagents). Everything you create, you name.

---

## The self API surface

```ts
await self.rows()                  // every row and running state
await self.describe(id)            // one row's parameters
await self.services()              // every live service
await self.call(svc, m, ...args)   // call a method
await self.config.set(id, k, v)    // hot change a row
await self.config.disable(id)      // stop without removing
await self.config.enable(id)       // restart
await self.config.reset(id)        // back to shipped defaults
await self.plugin.list()           // all plugins
await self.plugin.check(id)        // validate it loads
await self.plugin.mount(id)        // switch on (blocks until ACTIVE)
await self.plugin.unmount(id)     // switch off
await self.plugin.adopt(id, why)  // acknowledge a broken state
await self.plugin.remove(id)       // delete a mistaken plugin
await self.plugin.doctor()         // diagnose all plugin issues
await self.plugin.new(id, desc)   // scaffold a new plugin
```

---

## Growing a plugin while running

```ts
// 1. Scaffold
await self.plugin.new("rlm-weather", "Report the weather")

// 2. Edit the scaffold in packages/rlm-weather/src/index.ts.
//    Keep the Service subclass shape and static provide.

// 3. Validate
await self.plugin.check("rlm-weather")

// 4. Mount (blocks until ACTIVE or refused)
await self.plugin.mount("rlm-weather")

// 5. Use
await self.call("rlmWeather", "hello", "you")
```

---

## Context API

```ts
context.set(name, value, { type, mutable, description, scope })
context.get(name)
context.update(name, value)        // mutable vars only
context.mutate(name, fn)           // fn(old) => new
context.mutateMany(pattern, fn)    // glob-matched mutation
context.clone(name, newName)        // deep copy
context.cloneMany(patterns, prefix)
context.delete(name)
context.list("auth.*")              // glob filter
context.copy(["auth.*"])            // snapshot for subagents
context.move(["auth.*"])            // transfer to subagent
context.summarize()
context.meta(name)
```

Scopes: `project` persists to `.rlm/context.json`, `session` is this session, `task` is in-memory passed from parent.

---

## Delegating to subagents

```ts
// Spawn async, keep handle
handle = rlm.run("task prompt", { name: "my-worker" })

// Spawn and wait
result = await rlm.spawn("task prompt", opts)

// List / delete active children
rlm.listSubagents()
rlm.deleteSubagent(name)

// Transfer context to child
rlm.run("task", { context: ["auth.*", "db.*"] })
```

Transfer is atomic: the harness snapshots matching vars and rehydrates them in the child's `task` scope. Parent keeps vars on copy; uses `contextMove` for destructive transfer.

---

## Refining yourself

```ts
await refine.run()                                  // schedule refinement
await refine.run("create a memory about X")         // focus the request
await refine.run("persist this as a global skill", { global_: true })
await refine.status()                               // pending / in_flight
```

Refinement runs at turn end, not mid-cell. Keep edits small and evidence-backed. Local by default; global only for durable cross-session lessons.

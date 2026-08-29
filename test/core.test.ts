import { test, expect } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import MemoryService from "../src/plugins/memory/index.js";
import RefineService from "../src/plugins/refine/index.js";
import SubagentService from "../src/plugins/subagent/index.js";
import WoundService from "../src/plugins/wound/index.js";
import ReflectService from "../src/plugins/reflect/index.js";

const TMP = "/tmp/rlm-test";

async function createCtx() {
  const ctx = new Context();
  ctx.plugin(MemoryService, { dataDir: `${TMP}/data` });
  ctx.plugin(RefineService);
  ctx.plugin(SubagentService, { maxDepth: 3 });
  ctx.plugin(WoundService, { maxRefinePerPlugin: 3, cooldownTurns: 2 });
  ctx.plugin(ReflectService, { intervalTurns: 5 });
  // Wait for services to start
  await new Promise((r) => setTimeout(r, 500));
  return ctx;
}

test("memory: store and recall", async () => {
  const ctx = await createCtx();
  const mem = ctx.memory;
  mem.store({
    kind: "memory",
    title: "test-memory",
    content: "this is a test",
    scope: "global",
    version: 1,
  });
  const results = mem.recall("test");
  expect(results.length).toBe(1);
  expect(results[0].title).toBe("test-memory");
  await ctx.fiber.dispose();
});

test("refine: plan produces proposal", async () => {
  const ctx = await createCtx();
  const refine = ctx.refine;
  const proposal = await refine.plan([], "manual");
  expect(proposal).not.toBe(null);
  expect(proposal!.trigger).toBe("manual");
  await ctx.fiber.dispose();
});

test("refine: rate limiting prevents infinite loops", async () => {
  const ctx = await createCtx();
  const refine = ctx.refine;
  // Make 6 attempts on the same plugin (max is 5)
  for (let i = 0; i < 5; i++) {
    await refine.plan([], "wound", "test-plugin");
  }
  const blocked = await refine.plan([], "wound", "test-plugin");
  expect(blocked).toBe(null); // rate limited
  await ctx.fiber.dispose();
});

test("subagent: depth limit enforced", async () => {
  const ctx = await createCtx();
  const sub = ctx.subagents;
  const result = await sub.start({ prompt: "test", depth: 3 });
  expect(result.status).toBe("error");
  expect(result.error!).toContain("max depth");
  await ctx.fiber.dispose();
});

test("subagent: valid depth succeeds", async () => {
  const ctx = await createCtx();
  const sub = ctx.subagents;
  const result = await sub.start({ prompt: "test", depth: 0 });
  expect(result.status).toBe("done");
  await ctx.fiber.dispose();
});

test("wound: detects repeated failures", async () => {
  const ctx = await createCtx();
  // Emit two tool errors to trigger wound detection
  ctx.emit("tool/result", { data: { error: "test error", tool: "test-tool" } });
  ctx.emit("tool/result", { data: { error: "test error", tool: "test-tool" } });
  // Wait for async processing
  await new Promise((r) => setTimeout(r, 100));
  const wounds = ctx.wound.getDiagnoses();
  expect(wounds.length > 0).toBe(true);
  await ctx.fiber.dispose();
});

test("reflection: produces journal entry", async () => {
  const ctx = await createCtx();
  const reflection = ctx.reflection;
  const result = await reflection.reflect();
  expect(result.journal).not.toBe("");
  await ctx.fiber.dispose();
});

test("self-evolving loop: wound → refine → reflect", async () => {
  const ctx = await createCtx();
  // Simulate the self-evolving loop
  // 1. Emit wound-triggering failures
  ctx.emit("tool/result", { data: { error: "loop test error", tool: "loop-tool" } });
  ctx.emit("tool/result", { data: { error: "loop test error", tool: "loop-tool" } });
  // 2. Wait for wound detection + refine trigger
  await new Promise((r) => setTimeout(r, 200));
  // 3. Check wound was detected
  const wounds = ctx.wound.getDiagnoses();
  expect(wounds.length > 0).toBe(true);
  // 4. Manually trigger reflection
  const reflection = await ctx.reflection.reflect();
  expect(reflection.journal).not.toBe("");
  await ctx.fiber.dispose();
});

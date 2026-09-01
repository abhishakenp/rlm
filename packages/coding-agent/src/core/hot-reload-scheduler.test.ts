/**
 * The scheduler's whole job is timing, so these tests drive a fake clock and a
 * fake "is a turn running" flag rather than a real session.
 */
import { HotReloadScheduler } from "./hot-reload-scheduler.js";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void | Promise<void>) => {
  const done = (ok: boolean, msg = "") => ok ? (pass++, console.log("  ok  " + name)) : (fail++, console.log("  FAIL " + name + (msg ? "\n       " + msg : "")));
  try { const r = fn(); if (r instanceof Promise) return r.then(() => done(true), (e) => done(false, e.message)); done(true); }
  catch (e: any) { done(false, e.message); }
};
const eq = (a: any, b: any, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

/** A clock we control: timers fire only when we say so. */
function makeClock() {
  let handle = 0;
  const timers = new Map<number, () => void>();
  return {
    setTimeoutFn: (fn: () => void) => { const h = ++handle; timers.set(h, fn); return h; },
    clearTimeoutFn: (h: number) => { timers.delete(h); },
    tick: () => { const fns = [...timers.values()]; timers.clear(); for (const f of fns) f(); },
    pending: () => timers.size,
  };
}

function harness(opts: { busy?: boolean } = {}) {
  const clock = makeClock();
  let busy = opts.busy ?? false;
  const reloads: string[] = [];
  const errors: unknown[] = [];
  let resolveReload: (() => void) | null = null;
  let blockReload = false;
  const s = new HotReloadScheduler({
    debounceMs: 10,
    isBusy: () => busy,
    reload: async () => {
      if (blockReload) await new Promise<void>((r) => { resolveReload = r; });
      reloads.push("reload");
    },
    onReload: (reason) => reloads.push("done:" + reason),
    onError: (e) => errors.push(e),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return {
    s, clock, reloads, errors,
    setBusy: (v: boolean) => { busy = v; },
    block: (v: boolean) => { blockReload = v; },
    finishReload: () => { resolveReload?.(); resolveReload = null; },
  };
}

const run = async () => {
console.log("\ndebounce");
await t("a burst of changes costs one reload", async () => {
  const h = harness();
  h.s.schedule("a"); h.s.schedule("b"); h.s.schedule("c");
  eq(h.clock.pending(), 1, "only one timer armed;");
  h.clock.tick();
  await new Promise((r) => setImmediate(r));
  eq(h.reloads.filter((r) => r === "reload").length, 1);
});
await t("every reason is reported once", async () => {
  const h = harness();
  h.s.schedule("skill added"); h.s.schedule("plugin reloaded");
  h.clock.tick();
  await new Promise((r) => setImmediate(r));
  const done = h.reloads.find((r) => r.startsWith("done:"))!;
  eq(done.includes("skill added") && done.includes("plugin reloaded"), true, done);
});

console.log("\na running turn is never interrupted");
await t("a change mid-turn does not reload", async () => {
  const h = harness({ busy: true });
  h.s.schedule();
  h.clock.tick();
  await new Promise((r) => setImmediate(r));
  eq(h.reloads.length, 0, "reloaded during a turn;");
  eq(h.s.isPending, true, "should be pending;");
});
await t("and lands the moment the turn ends", async () => {
  const h = harness({ busy: true });
  h.s.schedule();
  h.clock.tick();
  await new Promise((r) => setImmediate(r));
  h.setBusy(false);
  await h.s.onIdle();
  eq(h.reloads.filter((r) => r === "reload").length, 1);
  eq(h.s.isPending, false);
});
await t("onIdle with nothing pending does nothing", async () => {
  const h = harness();
  await h.s.onIdle();
  eq(h.reloads.length, 0);
});

console.log("\noverlap");
await t("a change during a reload triggers a second pass", async () => {
  const h = harness();
  h.block(true);
  h.s.schedule("first");
  h.clock.tick();
  await new Promise((r) => setImmediate(r));
  h.s.schedule("second");
  h.clock.tick();                       // fires while the first reload is still running
  await new Promise((r) => setImmediate(r));
  h.block(false);
  h.finishReload();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  eq(h.reloads.filter((r) => r === "reload").length >= 2, true, JSON.stringify(h.reloads));
});

console.log("\nfailure");
await t("a failing reload is reported, never thrown", async () => {
  const clock = makeClock();
  const errors: unknown[] = [];
  const s = new HotReloadScheduler({
    debounceMs: 1, isBusy: () => false,
    reload: async () => { throw new Error("bad skill file"); },
    onError: (e) => errors.push(e),
    setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
  });
  s.schedule();
  clock.tick();
  await new Promise((r) => setImmediate(r));
  eq(errors.length, 1);
  eq((errors[0] as Error).message, "bad skill file");
});
await t("and the scheduler still works afterwards", async () => {
  const h = harness();
  h.s.schedule(); h.clock.tick();
  await new Promise((r) => setImmediate(r));
  h.s.schedule(); h.clock.tick();
  await new Promise((r) => setImmediate(r));
  eq(h.reloads.filter((r) => r === "reload").length, 2);
});

console.log("\ndispose");
await t("dispose cancels a scheduled reload", async () => {
  const h = harness();
  h.s.schedule();
  h.s.dispose();
  h.clock.tick();
  await new Promise((r) => setImmediate(r));
  eq(h.reloads.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
};
await run();

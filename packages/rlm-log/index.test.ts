/**
 * A logger earns trust by being boring: every line valid, ordered, bounded,
 * free of secrets, and present even when the process is on fire.
 */
import { Context } from "@deepseek-ai/cordis";
import RlmLogService, { rlmLog, isFailure } from "/Users/abhi/proj/rlm/packages/rlm-log/src/index.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-log-"));
const FILE = path.join(DIR, "rlm.jsonl");
const read = () =>
  fs.existsSync(FILE)
    ? fs.readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

const root: any = new Context();
const fork = root.plugin(RlmLogService, { file: FILE, level: "debug", installAgentSink: false });
await settle(400);
const svc = root.rlmLog;

console.log("\nthe file");
t("the service is up", () => eq(typeof svc?.write, "function"));
t("it says where it writes", () => eq(svc.stats().file, FILE));
t("it announced its own start", () => eq(read()[0].event, "logging.started"));
t("the first line records how the process was launched", () => {
  const first = read()[0];
  if (!first.pid || !first.node || !Array.isArray(first.argv)) throw new Error(JSON.stringify(first));
});

console.log("\nevery line is usable");
svc.write("info", "probe", "plain", { n: 1 });
svc.write("error", "probe", "boom", { error: new Error("kaboom") });
svc.write("warn", "probe", "secrets", { token: "abc", nested: { Authorization: "Bearer x", ok: 1 } });
svc.write("info", "probe", "huge", { blob: "x".repeat(5000) });
t("all lines parse as JSON", () => { read(); });
t("seq is monotonic", () => {
  const seqs = read().map((l) => l.seq);
  eq(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), true, JSON.stringify(seqs));
});
t("an error keeps its message and a bounded stack", () => {
  const l = read().find((x) => x.event === "boom")!;
  eq(l.error.message, "kaboom");
  eq(l.error.stack.length <= 6, true);
});
t("secrets are redacted at any depth", () => {
  const l = read().find((x) => x.event === "secrets")!;
  eq(l.token, "[redacted]");
  eq(l.nested.Authorization, "[redacted]");
  eq(l.nested.ok, 1);
});
t("a huge value is truncated, not dropped", () => {
  const l = read().find((x) => x.event === "huge")!;
  eq(l.blob.length < 2100, true, String(l.blob.length));
  eq(l.blob.includes("(5000)"), true);
});

console.log("\nthe events that matter when something breaks");
root.emit("rlm/hmr-reload", { reloaded: ["file:///x.ts"] });
root.emit("rlm/resources-changed", { reason: "skills changed", paths: ["/a/b.md"] });
await settle(100);
t("a plugin reload is recorded", () => {
  const l = read().find((x) => x.event === "plugin.reloaded");
  if (!l) throw new Error(read().map((x) => x.event).join(","));
});
t("a resource change is recorded with its reason", () => {
  const l = read().find((x) => x.event === "changed")!;
  eq(l.reason, "skills changed");
});

const reg = () => ((globalThis as any).__rlmExtensionFactories ?? []) as any[];
t("it contributes a session observer", () => eq(reg().filter((e) => e.id === "rlm-log").length, 1));
{
  const handlers: Record<string, Function[]> = {};
  reg().find((e) => e.id === "rlm-log").factory({ on: (ev: string, h: Function) => { (handlers[ev] ??= []).push(h); } });
  handlers["tool_call"][0]({ toolName: "code", toolCallId: "t1", input: { code: "1+1" } });
  handlers["tool_result"][0]({ toolName: "code", toolCallId: "t1", isError: true, content: [{ type: "text", text: "it blew up" }] });
  t("a tool call is recorded with its code", () => {
    const l = read().find((x) => x.event === "call")!;
    eq(l.code, "1+1");
  });
  t("a tool failure is recorded at error level", () => {
    const l = read().find((x) => x.event === "failed")!;
    eq(l.level, "error");
    eq(String(l.content).includes("it blew up"), true);
  });
  // The code tool reports a thrown cell as a normal result whose details say
  // status: "error". Reading isError alone misses most real failures.
  handlers["tool_result"][0]({
    toolName: "code", toolCallId: "t2", isError: false,
    details: { status: "error", error: { ename: "Error", evalue: "probe failure XYZ" } },
  });
  t("a thrown code cell counts as a failure", () => {
    const l = read().filter((x) => x.event === "failed").pop()!;
    eq(l.level, "error");
    eq(l.status, "error");
    eq(String(l.content).includes("probe failure XYZ"), true);
  });
  t("isFailure reads both shapes", () => {
    eq(isFailure({ isError: true }), true);
    eq(isFailure({ details: { status: "error" } }), true);
    eq(isFailure({ details: { status: "aborted" } }), true);
    eq(isFailure({ details: { status: "ok" } }), false);
    eq(isFailure({}), false);
  });
  handlers["tool_call"][0]({
    toolName: "code", toolCallId: "t3",
    input: { code: "globalThis.gp = (() => { /* long */ })();\n" + "x".repeat(3000) },
  });
  t("a seeded cell does not flood the log", () => {
    const l = read().filter((x) => x.event === "call").pop()!;
    eq(l.code.length < 460, true, String(l.code.length));
  });
}

console.log("\nlogging from anywhere");
rlmLog("info", "elsewhere", "no-injection-needed", { via: "global" });
t("the global reaches the file", () => eq(read().some((l) => l.event === "no-injection-needed"), true));

console.log("\nhot-swap");
fork.dispose();
await settle();
t("dispose withdraws the observer", () => eq(reg().filter((e) => e.id === "rlm-log").length, 0));
t("logging from anywhere is harmless afterwards", () => rlmLog("info", "elsewhere", "after-dispose"));

// The registry keys contributions by plugin id, so a second instance replaces
// the first — correct for a hot-swap, but it means these isolated instances
// have to run after the assertions about the main one.
console.log("\nlevels");
{
  const f2 = path.join(DIR, "info.jsonl");
  const c2: any = new Context();
  const fk = c2.plugin(RlmLogService, { file: f2, level: "info", installAgentSink: false });
  await settle();
  c2.rlmLog.write("debug", "probe", "should-not-appear");
  c2.rlmLog.write("warn", "probe", "should-appear");
  const lines = fs.readFileSync(f2, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  t("debug is dropped below its level", () => eq(lines.some((l) => l.event === "should-not-appear"), false));
  t("warn is kept", () => eq(lines.some((l) => l.event === "should-appear"), true));
  fk.dispose();
}

console.log("\nbounded");
{
  const f3 = path.join(DIR, "rot.jsonl");
  const c3: any = new Context();
  const fk = c3.plugin(RlmLogService, { file: f3, level: "debug", maxBytes: 512, installAgentSink: false });
  await settle();
  for (let i = 0; i < 60; i++) c3.rlmLog.write("info", "probe", "fill", { i, pad: "y".repeat(50) });
  t("it rotates instead of growing forever", () => eq(fs.existsSync(`${f3}.old`), true));
  t("and keeps writing after rotating", () => eq(fs.readFileSync(f3, "utf8").trim().length > 0, true));
  fk.dispose();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * The learning loop only closes if ordinary turns feed it. These tests drive
 * the session observer the way the extension runtime does and check that a
 * turn spent as a ladder of one-liners is noticed, recorded, and fed back into
 * the prompt — while a turn that did its work in one cell is left alone.
 */
import { Context } from "@deepseek-ai/cordis";
import RlmLearnService from "/Users/abhi/proj/rlm/packages/rlm-learn/src/index.ts";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-learn-"));
const settle = () => new Promise((r) => setTimeout(r, 250));
const reg = () => ((globalThis as any).__rlmExtensionFactories ?? []) as any[];
const mine = () => reg().filter((e: any) => e.id === "rlm-learn");

const root = new Context();
const fork = root.plugin(RlmLearnService, { learningsDir: DIR, reflectInterval: 3600000 });
await settle();

const svc: any = (root as any).rlmLearn;
const learnings = () =>
  fs.existsSync(path.join(DIR, "learnings.jsonl"))
    ? fs.readFileSync(path.join(DIR, "learnings.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

console.log("\nobserver registration");
t("contributes a session observer", () => eq(mine().length, 1));

const handlers: Record<string, Function[]> = {};
const pi = { on: (ev: string, h: Function) => { (handlers[ev] ??= []).push(h); } };
mine()[0].factory(pi);
const turn = (cells: string[], errors: string[] = []) => {
  handlers["turn_start"][0]({ type: "turn_start" });
  for (const code of cells) handlers["tool_call"][0]({ type: "tool_call", toolName: "code", input: { code } });
  for (const text of errors)
    handlers["tool_result"][0]({ type: "tool_result", toolName: "code", isError: true, content: [{ type: "text", text }] });
  handlers["turn_end"][0]({ type: "turn_end" });
};

console.log("\nthe one-liner ladder is noticed");
turn([
  "fs.readdirSync('.').slice(0, 20)",
  "fs.readdirSync('.').filter(f => !f.startsWith('.'))",
  "fs.existsSync('./src/always/translit.rs') && fs.readFileSync('./src/always/translit.rs','utf8').slice(0,100)",
]);
{
  const c = learnings().filter((l) => l.type === "cadence");
  t("a cadence learning is recorded", () => eq(c.length, 1));
  t("it counts the cells", () => eq(c[0].cells, 3));
  t("it keeps a sample of what was run", () => eq(c[0].sample.length, 3));
  t("the sample is the real code", () => { if (!c[0].sample[0].includes("readdirSync")) throw new Error(c[0].sample[0]); });
}

console.log("\nit reaches the prompt");
{
  const p = svc.buildLearningsPrompt() ?? "";
  t("prompt fragment mentions cadence", () => { if (!p.includes("[CADENCE]")) throw new Error(p); });
  t("and names the count", () => { if (!p.includes("3 separate code cells")) throw new Error(p); });
  t("and says what to do instead", () => { if (!p.includes("belongs in one cell")) throw new Error(p); });
}

console.log("\nwork done properly is left alone");
{
  const before = learnings().filter((l) => l.type === "cadence").length;
  turn(["const files = fs.readdirSync('.');\nconst rs = files.filter(f => f.endsWith('.rs'));\nconsole.log(rs);\nrs.map(f => fs.readFileSync(f,'utf8').length)"]);
  t("one substantial cell is not flagged", () => eq(learnings().filter((l) => l.type === "cadence").length, before));
  turn(["fs.readdirSync('.')", "fs.readdirSync('src')"]);
  t("two cells are not a ladder", () => eq(learnings().filter((l) => l.type === "cadence").length, before));
  turn([
    "fs.readdirSync('.')",
    "fs.readdirSync('src')",
    "const out = [];\nfor (const f of fs.readdirSync('src')) { out.push(f); }\nconsole.log(out);\nout.length",
  ]);
  t("a mixed turn with real work is not flagged", () => eq(learnings().filter((l) => l.type === "cadence").length, before));
}

console.log("\nthe same failure twice is the signal");
{
  const refusal = "Error: runtime.model is immutable and already set";
  const before = learnings().filter((l) => l.type === "repeat-error").length;
  turn(["context.set('runtime.model', 'x')", "context.set('runtime.model', 'y')"], [refusal, refusal]);
  const loops = learnings().filter((l) => l.type === "repeat-error");
  t("a repeated refusal is recorded", () => eq(loops.length, before + 1));
  t("it counts the repeats", () => eq(loops[loops.length - 1].count, 2));
  t("it keeps the error text", () => { if (!loops[loops.length - 1].error.includes("immutable")) throw new Error(loops[loops.length - 1].error); });
}
{
  const before = learnings().filter((l) => l.type === "repeat-error").length;
  turn(["a()", "b()"], ["Error: one thing broke", "Error: a different thing broke"]);
  t("two different failures are not a loop", () => eq(learnings().filter((l) => l.type === "repeat-error").length, before));
  turn(["a()"], ["Error: lonely failure"]);
  t("a single failure is not a loop", () => eq(learnings().filter((l) => l.type === "repeat-error").length, before));
}
{
  const p = svc.buildLearningsPrompt() ?? "";
  t("the loop reaches the prompt", () => { if (!p.includes("[LOOP]")) throw new Error(p); });
  t("with the error and the advice", () => {
    if (!p.includes("immutable") || !p.includes("fails the same way")) throw new Error(p);
  });
  t("and it is listed before the rest", () => {
    const iLoop = p.indexOf("[LOOP]"), iCad = p.indexOf("[CADENCE]");
    if (iLoop < 0 || (iCad >= 0 && iLoop > iCad)) throw new Error(p);
  });
}

console.log("\nhot-swap");
{
  fork.dispose();
  await settle();
  t("dispose withdraws the observer", () => eq(mine().length, 0));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

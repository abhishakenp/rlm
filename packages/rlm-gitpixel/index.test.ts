import { Context } from "@deepseek-ai/cordis";
import RlmGitpixelService from "/Users/abhi/proj/rlm/packages/rlm-gitpixel/src/index.ts";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any, m?: string) => { if (a !== b) throw new Error(`${m ?? ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-gp-"));
fs.mkdirSync(path.join(REPO, ".gitpixel"));
fs.writeFileSync(path.join(REPO, ".gitpixel/targets.json"), JSON.stringify({
  version: 1, task: "plugin fixture", files: [{ path: "src/a.rs", tier: "P0" }],
}));

const registry = () => ((globalThis as any).__rlmExtensionFactories ?? []) as any[];
const mine = () => registry().filter((e: any) => e.id === "rlm-gitpixel");
const settle = () => new Promise((r) => setTimeout(r, 250));

// Load the plugin the way the real host does: as a Cordis plugin on a Context.
// The plugin injects rlmConfig, so the fiber only starts once that service
// exists — the same gating the real profile relies on.
const root = new Context();
root.provide("rlmConfig");
(root as any).rlmConfig = { getSettingsManager: () => ({ getCwd: () => REPO }) };
const fork = root.plugin(RlmGitpixelService, { cwd: REPO, warmOnStart: false });
await settle();

console.log("\nregistration");
t("contributes exactly one factory", () => eq(mine().length, 1));
t("service is provided on the context", () => eq(typeof (root as any).rlmGitpixel?.stats, "function"));
t("it reports itself active", () => eq((root as any).rlmGitpixel.stats().active, true));

// Drive the factory the way the extension runtime does.
const handlers: Record<string, Function[]> = {};
const pi = { on: (ev: string, h: Function) => { (handlers[ev] ??= []).push(h); } };
mine()[0].factory(pi);
const toolCall = (code: string) => {
  const event: any = { type: "tool_call", toolCallId: "1", toolName: "code", input: { code } };
  const res = handlers["tool_call"][0](event);
  return { event, res };
};

console.log("\nsubstitution (mutates event.input in place)");
{
  const { event, res } = toolCall("%%bash\nrg handleClick src\n");
  t("no block", () => eq(res, undefined));
  t("rg became gitpixel search", () => { if (!event.input.code.includes("gitpixel search handleClick src")) throw new Error(event.input.code); });
  t("rg is gone", () => { if (/(^|\n)\s*rg /.test(event.input.code)) throw new Error(event.input.code); });
  t("a shell cell is never seeded into", () => { if (event.input.code.includes("globalThis.gp")) throw new Error("seeded a %%bash cell"); });
}
console.log("\ncell magic is never broken by seeding");
{
  const { event } = toolCall("%%bash\nrg first src\n");
  t("a %%bash first cell is not prepended to", () => { if (!event.input.code.startsWith("%%bash")) throw new Error(event.input.code); });
  t("and is still substituted", () => { if (!event.input.code.includes("gitpixel search first src")) throw new Error(event.input.code); });
  const js = toolCall("fs.readdirSync('.')");
  t("the next JS cell carries the seed", () => { if (!js.event.input.code.includes("globalThis.gp")) throw new Error(js.event.input.code); });
  t("seed sits before the agent's code", () => { if (!js.event.input.code.trimEnd().endsWith("fs.readdirSync('.')")) throw new Error(js.event.input.code); });
}

{
  const { event } = toolCall("%%bash\nrg other src\n");
  t("still not seeded", () => { if (event.input.code.includes("globalThis.gp")) throw new Error("re-seeded"); });
  t("later cells still substitute", () => { if (!event.input.code.includes("gitpixel search other src")) throw new Error(event.input.code); });
}
{
  const { event } = toolCall("%%bash\nrg foo src | head -5\n");
  t("a piped search is left alone", () => eq(event.input.code, "%%bash\nrg foo src | head -5\n"));
}
{
  const { event } = toolCall("const x = fs.readFileSync('a.rs');");
  t("plain JS is untouched", () => eq(event.input.code, "const x = fs.readFileSync('a.rs');"));
}
{
  const { event } = toolCall("!rg needle src");
  t("! line magic substitutes", () => { if (!event.input.code.includes("!gitpixel search needle src")) throw new Error(event.input.code); });
}

console.log("\ngate");
{
  const HARD = ["git", "reset", "--hard"].join(" ");
  const { res } = toolCall("%%bash\n" + HARD + " HEAD~1\n");
  t("destructive reset is blocked", () => eq((res as any)?.block, true));
  t("block names rescue", () => { if (!/gitpixel rescue/.test((res as any).reason)) throw new Error((res as any).reason); });
}
{
  const HARD = ["git", "reset", "--hard"].join(" ");
  const { res } = toolCall(`const msg = "do not ${HARD}";`);
  t("the phrase inside a JS string is not blocked", () => eq(res, undefined));
}

console.log("\nhot-swap");
const f2 = root.plugin(RlmGitpixelService, { cwd: REPO, warmOnStart: false });
await settle();
t("a second load replaces, never stacks", () => eq(mine().length, 1));
f2.dispose();
await settle();
console.log("    [after f2.dispose]  entries =", mine().length);
fork.dispose();
await settle();
console.log("    [after fork.dispose] entries =", mine().length);
await settle();
t("dispose withdraws the factory", () => eq(mine().length, 0));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

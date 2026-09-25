import { Context } from "@deepseek-ai/cordis";
import RlmPixelService from "/Users/abhi/proj/rlm/packages/rlm-pixel/src/index.ts";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any, m?: string) => { if (a !== b) throw new Error(`${m ?? ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-pixel-"));
fs.mkdirSync(path.join(REPO, ".pixel"));

const registry = () => ((globalThis as any).__rlmExtensionFactories ?? []) as any[];
const mine = () => registry().filter((e: any) => e.id === "rlm-pixel");
const settle = () => new Promise((r) => setTimeout(r, 250));

// Load the plugin the way the real host does: as a Cordis plugin on a Context.
const root = new Context();
root.provide("rlmConfig");
(root as any).rlmConfig = { getSettingsManager: () => ({ getCwd: () => REPO }) };
const fork = root.plugin(RlmPixelService, { cwd: REPO, warmOnStart: false, autoInstall: false });
await settle();

console.log("\nregistration");
t("contributes exactly one factory", () => eq(mine().length, 1));
t("service is provided on the context", () => eq(typeof (root as any).rlmPixel?.stats, "function"));

console.log("\nhot-swap");
const f2 = root.plugin(RlmPixelService, { cwd: REPO, warmOnStart: false, autoInstall: false });
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

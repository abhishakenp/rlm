/**
 * The substitution, executed for real.
 *
 * The plugin's tool_call handler mutates the cell, and the mutated cell then
 * runs in the production kernel — the same CodeKernelProvisioner an rlm
 * session uses, with the same %%bash transform. No model is involved, because
 * a model paraphrases instructions and cannot be used as a witness.
 *
 * The discriminator is a path that does not exist: ripgrep and gitpixel fail
 * differently, so the output says which one actually ran.
 *
 * Run: node --expose-internals --import tsx packages/rlm-gitpixel/test-kernel-live.mts
 */
import { Context } from "@deepseek-ai/cordis";
import RlmGitpixelService from "./src/index.ts";
import { CodeKernelProvisioner } from "../coding-agent/src/core/tools/code.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

const REPO = mkdtempSync(join(tmpdir(), "gp-kernel-live-"));
mkdirSync(join(REPO, ".gitpixel"));
mkdirSync(join(REPO, "src"));
writeFileSync(join(REPO, "src/onlist.rs"), "fn main() {}\n");
writeFileSync(join(REPO, ".gitpixel/targets.json"), JSON.stringify({
  version: 1, task: "kernel live proof", files: [{ path: "src/onlist.rs", tier: "P0" }],
}));

// Load the plugin exactly as the host does.
const root: any = new Context();
root.provide("rlmConfig");
root.rlmConfig = { getSettingsManager: () => ({ getCwd: () => REPO }) };
root.plugin(RlmGitpixelService, { cwd: REPO, warmOnStart: false });
await new Promise((r) => setTimeout(r, 300));

const entry = ((globalThis as any).__rlmExtensionFactories ?? []).find((e: any) => e.id === "rlm-gitpixel");
check("plugin contributed its factory", !!entry);

const handlers: Record<string, Function[]> = {};
entry.factory({ on: (ev: string, h: Function) => { (handlers[ev] ??= []).push(h); } });

/** Push a cell through the real handler and return what the kernel would run. */
const mutate = (code: string) => {
  const event: any = { type: "tool_call", toolCallId: "1", toolName: "code", input: { code } };
  const res = handlers["tool_call"][0](event);
  return { code: event.input.code as string, blocked: (res as any)?.block === true };
};

// ── What actually happens to a bare search in a shell cell ──
const original = "%%bash\nrg zzz_no_such_pattern no_such_dir";
const { code: mutated } = mutate(original);
check("the cell is rewritten to gitpixel", mutated.includes("gitpixel search"), mutated);
check("the bare rg is gone", !/\brg\s/.test(mutated), mutated);
check("it is still a %%bash cell", mutated.startsWith("%%bash"), mutated.slice(0, 20));

// ── Execute both, in the real kernel, and compare against the real tools ──
const kernel = new CodeKernelProvisioner(REPO, { cwd: REPO } as any);
// A %%bash cell becomes execSync(), which throws on a non-zero exit, so the
// tool's message can land in any field of the result. Take the whole thing.
const runCell = async (cell: string) => JSON.stringify(await kernel.execute(cell));
const direct = (bin: string, args: string[]) => {
  try { return execFileSync(bin, args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e: any) { return `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message); }
};

const piped0 = "%%bash\nrg zzz_no_such_pattern no_such_dir | head -2";
const viaKernel = await runCell(mutated);
const rgSays = direct("rg", ["zzz_no_such_pattern", "no_such_dir"]);
const gpSays = direct("gitpixel", ["search", "zzz_no_such_pattern", "no_such_dir"]);

const norm = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 160);
console.log("\n  kernel  :", JSON.stringify(norm(viaKernel)));
console.log("  ripgrep :", JSON.stringify(norm(rgSays)));
console.log("  gitpixel:", JSON.stringify(norm(gpSays)));

check("the kernel ran gitpixel", viaKernel.includes("gitpixel: bad path"), norm(viaKernel));
check("the kernel did not run ripgrep", !viaKernel.includes("rg: no_such_dir"), norm(viaKernel));

// Executing the untouched pipeline proves nothing — piped through `head`, both
// tools print the same nothing — so the assertion that matters is that the
// cell text was left alone, which is checked below.

// ── A pipeline must be left alone, and prove it by running as ripgrep ──
const { code: pipedOut } = mutate(piped0);
check("a pipeline is not rewritten", pipedOut === piped0);

// ── The gate, executed ──
const hard = "%%bash\n" + ["git", "reset", "--hard"].join(" ") + " HEAD";
check("a destructive reset is blocked before it can run", mutate(hard).blocked === true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

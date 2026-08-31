#!/usr/bin/env node
/**
 * Resources — skills, extensions, prompts — must be addable while the process
 * runs. Nothing here is a module, so nothing is re-imported: the plugin
 * announces the change and live sessions re-derive from it.
 *
 * Run: node --expose-internals --import tsx packages/rlm-hmr/test-resources.mjs
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cfg = join(repoRoot, "cordis.hmr-res-test.yml");
const agentDir = join(repoRoot, ".rlm-hmr-test-agent");

function cleanup() {
  try { rmSync(agentDir, { recursive: true }); } catch {}
  try { rmSync(cfg); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });
cleanup();

mkdirSync(join(agentDir, "skills"), { recursive: true });
mkdirSync(join(agentDir, "extensions"), { recursive: true });

writeFileSync(cfg, `- id: hmr
  name: './packages/rlm-hmr/src/index.ts'
  config:
    roots: ['packages']
    resourceRoots: ['${agentDir}']
    debounce: 50
    verbose: ${process.env.RLM_HMR_VERBOSE ? "true" : "false"}
`);

const { Context } = await import("@deepseek-ai/cordis");
const Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
const ctx = new Context();
ctx.baseUrl = pathToFileURL(repoRoot + "/").href;
await ctx.plugin(Loader);
await ctx.loader.create({
  name: "@deepseek-ai/cordis-plugin-include",
  config: { path: "./cordis.hmr-res-test.yml", enableLogs: false },
});
await new Promise((r) => setTimeout(r, 800));

const seen = { resources: [], prompt: [] };
ctx.on("rlm/resources-changed", (d) => seen.resources.push(d));
ctx.on("rlm/prompt-changed", (d) => seen.prompt.push(d));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};
const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

check("hmr service is up", !!ctx.get("rlmHmr"));
check("it is watching the agent directory",
  (ctx.get("rlmHmr")?.stats?.().resourceRoots ?? []).includes(agentDir),
  JSON.stringify(ctx.get("rlmHmr")?.stats?.().resourceRoots));

// ── A skill that did not exist when the process started ──
writeFileSync(join(agentDir, "skills", "late-skill.md"), "---\nname: late-skill\n---\nAdded at runtime.\n");
await settle();
check("adding a skill announces a resource change", seen.resources.length >= 1,
  JSON.stringify(seen.resources));
check("and invalidates the built system prompt", seen.prompt.length >= 1,
  JSON.stringify(seen.prompt));
check("the reason names the file",
  JSON.stringify(seen.resources).includes("late-skill.md"), JSON.stringify(seen.resources[0]?.reason));

// ── An extension dropped in at runtime ──
const before = seen.resources.length;
writeFileSync(join(agentDir, "extensions", "late-ext.ts"), "export default function (pi) {}\n");
await settle();
check("adding an extension announces a resource change", seen.resources.length > before);

// ── Editing an existing skill ──
const before2 = seen.resources.length;
writeFileSync(join(agentDir, "skills", "late-skill.md"), "---\nname: late-skill\n---\nEdited at runtime.\n");
await settle();
check("editing a skill announces again", seen.resources.length > before2);

// ── Noise must stay quiet ──
const before3 = seen.resources.length;
writeFileSync(join(agentDir, "skills", "notes.map"), "ignored\n");
await settle(700);
check("ignored file types stay silent", seen.resources.length === before3);

console.log("\nstats:", JSON.stringify(ctx.get("rlmHmr")?.stats?.()));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

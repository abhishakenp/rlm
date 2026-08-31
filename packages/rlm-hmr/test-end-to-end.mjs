#!/usr/bin/env node
/**
 * The whole chain, minus the agent itself:
 *
 *   a file changes → the hmr plugin sees it → it announces the change →
 *   the session's scheduler decides when → reload() runs
 *
 * Everything here is the real code: the real plugin, the real event names, the
 * real installResourceHotReload() that AgentSession calls. Only reload() is a
 * stand-in, because booting a whole agent to prove a wire is connected would
 * test the agent instead of the wire.
 *
 * Run: node --expose-internals --import tsx packages/rlm-hmr/test-end-to-end.mjs
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cfg = join(repoRoot, "cordis.hmr-e2e-test.yml");
const agentDir = join(repoRoot, ".rlm-hmr-e2e-agent");
const pkg = join(repoRoot, "packages", "rlm-hmr-e2e");

function cleanup() {
  for (const d of [agentDir, pkg]) { try { rmSync(d, { recursive: true }); } catch {} }
  try { rmSync(cfg); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });
cleanup();

mkdirSync(join(agentDir, "skills"), { recursive: true });
mkdirSync(join(pkg, "src"), { recursive: true });
writeFileSync(join(pkg, "src", "index.ts"), `import { Service } from "@deepseek-ai/cordis";
export class E2E extends Service {
  static inject = [] as const;
  static provide = "e2eProbe" as const;
  constructor(ctx: any, config: any = {}) { super(ctx, undefined as any); }
  async [Service.init]() { (globalThis as any).__e2e = "v1"; }
}
export default E2E;
export const name = "e2eProbe";
`);
writeFileSync(cfg, `- id: hmr
  name: './packages/rlm-hmr/src/index.ts'
  config:
    roots: ['packages']
    resourceRoots: ['${agentDir}']
    debounce: 50
- id: e2eProbe
  name: './packages/rlm-hmr-e2e/src/index.ts'
`);

const { Context } = await import("@deepseek-ai/cordis");
const Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
const { installResourceHotReload } = await import(
  join(repoRoot, "packages/coding-agent/src/core/hot-reload-scheduler.ts")
);

const ctx = new Context();
ctx.baseUrl = pathToFileURL(repoRoot + "/").href;
await ctx.plugin(Loader);
await ctx.loader.create({
  name: "@deepseek-ai/cordis-plugin-include",
  config: { path: "./cordis.hmr-e2e-test.yml", enableLogs: false },
});
await new Promise((r) => setTimeout(r, 800));

// Stand in for the live AgentSession.
let busy = false;
const reloads = [];
const scheduler = installResourceHotReload(ctx, {
  debounceMs: 50,
  isBusy: () => busy,
  reload: async () => { reloads.push(Date.now()); },
  onReload: (reason) => console.log(`    → session reloaded (${reason})`),
  onError: (e) => console.log("    → reload error", e?.message),
});

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

check("the wire is installed", !!scheduler);
check("probe plugin loaded", globalThis.__e2e === "v1", String(globalThis.__e2e));

console.log("\na skill added at runtime reaches the session");
writeFileSync(join(agentDir, "skills", "brand-new.md"), "---\nname: brand-new\n---\nhello\n");
await settle();
check("the session reloaded", reloads.length === 1, `reloads=${reloads.length}`);

console.log("\na plugin edited at runtime reaches the session");
const before = reloads.length;
writeFileSync(join(pkg, "src", "index.ts"),
  (await import("node:fs")).readFileSync(join(pkg, "src", "index.ts"), "utf8").replace('"v1"', '"v2"'));
await settle(2500);
check("the plugin itself hot-reloaded", globalThis.__e2e === "v2", String(globalThis.__e2e));
check("and the session was told", reloads.length > before, `reloads=${reloads.length}`);

console.log("\na turn in flight is never interrupted");
busy = true;
const during = reloads.length;
writeFileSync(join(agentDir, "skills", "mid-turn.md"), "---\nname: mid-turn\n---\nhello\n");
await settle();
check("no reload while the agent is running", reloads.length === during, `reloads=${reloads.length}`);
check("but one is queued", scheduler.isPending === true);
busy = false;
await scheduler.onIdle();
check("and it lands the moment the turn ends", reloads.length === during + 1, `reloads=${reloads.length}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * With @deepseek-ai/cordis-plugin-hmr present, module reload is its job and
 * this plugin's is translation: the official announcement must become the
 * event a live AgentSession listens for, and our own watcher must stand down
 * so one edit does not cause two reloads.
 *
 * Run: node --expose-internals --import tsx packages/rlm-hmr/test-bridge.mjs
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cfg = join(repoRoot, "cordis.hmr-bridge-test.yml");
const pkg = join(repoRoot, "packages", "rlm-hmr-bridge-probe");

function cleanup() {
  try { rmSync(pkg, { recursive: true }); } catch {}
  try { rmSync(cfg); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });
cleanup();

mkdirSync(join(pkg, "src"), { recursive: true });
const probe = (v) => `import { Service } from "@deepseek-ai/cordis";
export const V = "${v}";
export class P extends Service {
  static inject = [] as const;
  static provide = "bridgeProbe" as const;
  constructor(ctx: any, config: any = {}) { super(ctx, undefined as any); }
  async [Service.init]() { (globalThis as any).__bridge = V; }
}
export default P;
export const name = "bridgeProbe";
`;
writeFileSync(join(pkg, "src", "index.ts"), probe("v1"));

writeFileSync(cfg, `- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root: ['packages/rlm-hmr-bridge-probe']
    ignored: ['**/node_modules', '**/.*']
    debounce: 100
- id: rlm-hmr
  name: './packages/rlm-hmr/src/index.ts'
  config:
    roots: ['packages/rlm-hmr-bridge-probe']
    debounce: 50
- id: bridgeProbe
  name: './packages/rlm-hmr-bridge-probe/src/index.ts'
`);

const { Context } = await import("@deepseek-ai/cordis");
const Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
const ctx = new Context();
ctx.baseUrl = pathToFileURL(repoRoot + "/").href;
await ctx.plugin(Loader);
await ctx.loader.create({
  name: "@deepseek-ai/cordis-plugin-include",
  config: { path: "./cordis.hmr-bridge-test.yml", enableLogs: false },
});
await new Promise((r) => setTimeout(r, 4000));

const bridged = [];
ctx.on("rlm/hmr-reload", (d) => bridged.push(d));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

const rlmHmr = ctx.get("rlmHmr");
check("the official plugin is present", !!ctx.get("hmr"));
check("rlm-hmr is present", !!rlmHmr);
check("rlm-hmr defers module reload to it", rlmHmr?.isBridging === true,
  JSON.stringify(rlmHmr?.stats?.()));
check("probe loaded v1", globalThis.__bridge === "v1", String(globalThis.__bridge));

writeFileSync(join(pkg, "src", "index.ts"), probe("v2"));
await new Promise((r) => setTimeout(r, 6000));

check("the official plugin reloaded the module", globalThis.__bridge === "v2", String(globalThis.__bridge));
check("and it was translated into rlm/hmr-reload", bridged.length >= 1, JSON.stringify(bridged));
check("exactly one reload was announced, not two", bridged.length === 1, `announced ${bridged.length}`);

console.log("\nstats:", JSON.stringify(rlmHmr?.stats?.()));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

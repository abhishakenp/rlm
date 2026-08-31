#!/usr/bin/env node
/**
 * The regression the shell's boot-frozen watch list could not catch:
 * a package that did not exist when the process started.
 *
 * Boot with @rlm/hmr and one plugin. Then create a SECOND package on disk,
 * add it to the config, refresh, edit it — and require that the edit reloads.
 * Under the old shell-owned watcher this second package was never watched,
 * because its watch list was derived from readdirSync(packages) at boot.
 *
 * Run: node --expose-internals --import tsx packages/rlm-hmr/test-late-package.mjs
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cfg = join(repoRoot, "cordis.hmr-late-test.yml");
const early = join(repoRoot, "packages", "rlm-hmr-early");
const late = join(repoRoot, "packages", "rlm-hmr-late");

const plugin = (id, version) => `import { Service } from "@deepseek-ai/cordis";
export class S_${id} extends Service {
  static inject = [] as const;
  static provide = "${id}" as const;
  constructor(ctx: any, config: any = {}) { super(ctx, undefined as any); }
  async [Service.init]() { (globalThis as any).__${id} = "${version}"; }
}
export default S_${id};
export const name = "${id}";
`;

function write(dir, id, version) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), plugin(id, version));
}

function cleanup() {
  for (const d of [early, late]) { try { rmSync(d, { recursive: true }); } catch {} }
  try { rmSync(cfg); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });
cleanup();

write(early, "hmrEarly", "v1");
writeFileSync(cfg, `- id: hmr
  name: './packages/rlm-hmr/src/index.ts'
  config:
    roots: ['packages']
    debounce: 50
    verbose: ${process.env.RLM_HMR_VERBOSE ? "true" : "false"}
- id: hmrEarly
  name: './packages/rlm-hmr-early/src/index.ts'
`);

const { Context } = await import("@deepseek-ai/cordis");
const Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
const ctx = new Context();
ctx.baseUrl = pathToFileURL(repoRoot + "/").href;
await ctx.plugin(Loader);
const entryId = await ctx.loader.create({
  name: "@deepseek-ai/cordis-plugin-include",
  config: { path: "./cordis.hmr-late-test.yml", enableLogs: false },
});
await new Promise((r) => setTimeout(r, 800));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

check("hmr service is up", !!ctx.get("rlmHmr"));
check("loader internals available", !!ctx.loader?.internal);
check("early plugin loaded v1", globalThis.__hmrEarly === "v1", String(globalThis.__hmrEarly));

// ── 1. Parity: a package present at boot still reloads ──
write(early, "hmrEarly", "v2");
await new Promise((r) => setTimeout(r, 2500));
check("a package present at boot reloads", globalThis.__hmrEarly === "v2", String(globalThis.__hmrEarly));

// ── 2. The regression: a package created AFTER boot ──
write(late, "hmrLate", "v1");
writeFileSync(cfg, `- id: hmr
  name: './packages/rlm-hmr/src/index.ts'
  config:
    roots: ['packages']
    debounce: 50
    verbose: ${process.env.RLM_HMR_VERBOSE ? "true" : "false"}
- id: hmrEarly
  name: './packages/rlm-hmr-early/src/index.ts'
- id: hmrLate
  name: './packages/rlm-hmr-late/src/index.ts'
`);
const entry = ctx.loader.entries?.().find?.((e) => e.options?.id === entryId) ?? null;
const tree = entry?.subtree ?? entry;
if (tree?.refresh) await tree.refresh();
else await ctx.loader.restart?.();
await new Promise((r) => setTimeout(r, 1200));
check("late package loaded v1 after config refresh", globalThis.__hmrLate === "v1", String(globalThis.__hmrLate));

write(late, "hmrLate", "v2");
await new Promise((r) => setTimeout(r, 2500));
check("a package created AFTER boot reloads", globalThis.__hmrLate === "v2", String(globalThis.__hmrLate));

const stats = ctx.get("rlmHmr")?.stats?.();
console.log("\nhmr stats:", JSON.stringify(stats));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

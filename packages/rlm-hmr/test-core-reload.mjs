#!/usr/bin/env node
/**
 * "Even the core hot-reloads" — tested against a real core file.
 *
 * A probe plugin imports packages/coding-agent/src/core/tools/truncate.ts.
 * That file is then edited on disk, for real, and restored afterwards. If the
 * module graph is traced correctly, the probe reloads because something it
 * imports changed — which is exactly what happens when core changes and
 * rlm-agent or rlm-tools depend on it.
 *
 * Run: node --expose-internals --import tsx packages/rlm-hmr/test-core-reload.mjs
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cfg = join(repoRoot, "cordis.hmr-core-test.yml");
const pkg = join(repoRoot, "packages", "rlm-hmr-core-probe");
const CORE = join(repoRoot, "packages", "coding-agent", "src", "core", "tools", "truncate.ts");
const backup = readFileSync(CORE, "utf8");

function cleanup() {
  try { writeFileSync(CORE, backup); } catch {}   // the core file is always restored
  try { rmSync(pkg, { recursive: true }); } catch {}
  try { rmSync(cfg); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });
process.on("uncaughtException", (e) => { cleanup(); console.error(e); process.exit(1); });
cleanup();

mkdirSync(join(pkg, "src"), { recursive: true });
writeFileSync(join(pkg, "src", "index.ts"), `import { Service } from "@deepseek-ai/cordis";
import { formatSize } from "../../coding-agent/src/core/tools/truncate.ts";
export class CoreProbe extends Service {
  static inject = [] as const;
  static provide = "coreProbe" as const;
  constructor(ctx: any, config: any = {}) { super(ctx, undefined as any); }
  async [Service.init]() {
    (globalThis as any).__coreLoads = ((globalThis as any).__coreLoads ?? 0) + 1;
    (globalThis as any).__coreSample = formatSize(1024);
  }
}
export default CoreProbe;
export const name = "coreProbe";
`);
writeFileSync(cfg, `- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root: ['packages']
    ignored: ['**/node_modules', '**/dist', '**/.*']
    debounce: 100
- id: coreProbe
  name: './packages/rlm-hmr-core-probe/src/index.ts'
`);

const { Context } = await import("@deepseek-ai/cordis");
const Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
const ctx = new Context();
ctx.baseUrl = pathToFileURL(repoRoot + "/").href;
await ctx.plugin(Loader);
await ctx.loader.create({
  name: "@deepseek-ai/cordis-plugin-include",
  config: { path: "./cordis.hmr-core-test.yml", enableLogs: false },
});
await new Promise((r) => setTimeout(r, 6000));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

check("probe loaded once, importing core", globalThis.__coreLoads === 1, String(globalThis.__coreLoads));
check("it really used the core export", typeof globalThis.__coreSample === "string", String(globalThis.__coreSample));

// Edit the real core file.
writeFileSync(CORE, backup + `\n// hmr core-reload probe ${Date.now()}\n`);
console.log("  … edited packages/coding-agent/src/core/tools/truncate.ts");
await new Promise((r) => setTimeout(r, 8000));

check("editing a core module reloaded its dependent plugin",
  globalThis.__coreLoads === 2, `loads=${globalThis.__coreLoads}`);

writeFileSync(CORE, backup);
check("the core file is restored byte-for-byte", readFileSync(CORE, "utf8") === backup);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

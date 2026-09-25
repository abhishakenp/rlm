/**
 * One log, not a live one and a lying one.
 *
 * The agent's structured logging (pi-ai) has a single process-wide sink. What
 * this file pins down is where that sink now points: into the flight recorder
 * this plugin owns, and *not* into ~/.rlm/agent/logs/agent.jsonl, the second
 * file the plugin used to fork it into and which nothing reads.
 *
 * The two emitters matter as much as the assertion. `packages/ai` is loaded
 * both as `src/index.ts` (under tsx — how the Cordis host runs) and as
 * `dist/index.js` (through the `@earendil-works/pi-ai` specifier), and the two
 * carry separate module-level sinks. A sink installed on one of them is a log
 * that reports success and records nothing.
 */
import { Context } from "@deepseek-ai/cordis";
import RlmLogService from "/Users/abhi/proj/rlm/packages/rlm-log/src/index.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-log-agent-sink-"));
const FILE = path.join(DIR, "rlm.jsonl");
// Where the abandoned second log would land if anything still wrote it.
const AGENT_DIR = path.join(DIR, "agent");
process.env.RLM_CODING_AGENT_DIR = AGENT_DIR;
const LEGACY = path.join(AGENT_DIR, "logs", "agent.jsonl");

const read = () =>
  fs.existsSync(FILE)
    ? fs.readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

const root: any = new Context();
const fork = root.plugin(RlmLogService, { file: FILE, level: "debug" });
await settle(500);

const src: any = await import("/Users/abhi/proj/rlm/packages/ai/src/index.ts");
const dist: any = await import("/Users/abhi/proj/rlm/packages/ai/dist/index.js");

console.log("\nthe agent's own logging lands in the one log");
t("the two pi-ai instances really are separate sinks", () => eq(src.setLogSink === dist.setLogSink, false));

src.getLogger("probe.src").warn("emitted through the tsx instance", { detail: "src" });
dist.getLogger("probe.dist").error("emitted through the dist instance", { detail: "dist" });

const lines = read();
t("an entry from the tsx instance is recorded", () => {
  const hit = lines.find((l) => l.scope === "probe.src");
  if (!hit) throw new Error(`no probe.src line in ${JSON.stringify(lines.map((l) => l.scope))}`);
  eq(hit.level, "warn", "level");
  eq(hit.event, "emitted through the tsx instance", "event");
  eq(hit.detail, "src", "field");
});
t("an entry from the dist instance is recorded", () => {
  const hit = lines.find((l) => l.scope === "probe.dist");
  if (!hit) throw new Error(`no probe.dist line in ${JSON.stringify(lines.map((l) => l.scope))}`);
  eq(hit.level, "error", "level");
  eq(hit.detail, "dist", "field");
});

console.log("\nand nowhere else");
t("the abandoned agent.jsonl is never created", () => eq(fs.existsSync(LEGACY), false));

console.log("\nit does not re-announce an unchanged verdict");
{
  const before = read().filter((l) => l.event === "agent.sink.installed").length;
  const second: any = new Context();
  const fk2 = second.plugin(RlmLogService, { file: FILE, level: "debug" });
  await settle(500);
  const after = read().filter((l) => l.event === "agent.sink.installed").length;
  t("a second install of the same targets says so once", () => eq(after, before));
  t("and records the reuse instead", () => eq(read().some((l) => l.event === "agent.sink.reused"), true));
  fk2.dispose();
}

fork.dispose();
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

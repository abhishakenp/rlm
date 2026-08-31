/**
 * A missing gitpixel must not mean a worse agent for the rest of the session.
 *
 * With no usable binary the plugin still registers, stays inert, builds
 * gitpixel from source in the background, and activates itself when the build
 * lands — no restart, nothing for the user to run.
 *
 * The install path is exercised against a local checkout stand-in rather than
 * a real clone: the clone is one `git clone` line, while everything after it —
 * cargo build, binary discovery, engine resolution, activation — is what can
 * actually be wrong, and all of it runs here for real.
 *
 * Run: node --expose-internals --import tsx packages/rlm-gitpixel/test-autoinstall.mts
 */
import { Context } from "@deepseek-ai/cordis";
import RlmGitpixelService from "./src/index.ts";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stand-in checkout: a real cargo crate that builds a real binary named
// gitpixel, plus the real substitution engine where the plugin expects it.
const DIR = mkdtempSync(join(tmpdir(), "gp-install-"));
mkdirSync(join(DIR, "src"), { recursive: true });
mkdirSync(join(DIR, "js", "substitute"), { recursive: true });
copyFileSync(
  "/Users/abhi/proj/tools/gitpixel/js/substitute/index.cjs",
  join(DIR, "js", "substitute", "index.cjs"),
);
writeFileSync(join(DIR, "Cargo.toml"), `[package]
name = "gitpixel"
version = "0.0.0"
edition = "2021"

[[bin]]
name = "gitpixel"
path = "src/main.rs"
`);
writeFileSync(join(DIR, "src", "main.rs"), `fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") { println!("gitpixel 0.0.0-test"); return; }
    println!("stand-in gitpixel");
}
`);

const REPO = mkdtempSync(join(tmpdir(), "gp-install-repo-"));
mkdirSync(join(REPO, "src"), { recursive: true });
writeFileSync(join(REPO, "src", "a.rs"), "fn main() {}\n");

// No usable binary: point the resolver at nothing that exists.
process.env.GITPIXEL_BIN = join(DIR, "definitely-not-here");
process.env.GITPIXEL_SUBSTITUTE = join(DIR, "definitely-not-here.cjs");

const root: any = new Context();
root.provide("rlmConfig");
root.rlmConfig = { getSettingsManager: () => ({ getCwd: () => REPO }) };
root.plugin(RlmGitpixelService, {
  cwd: REPO,
  warmOnStart: false,
  autoInstall: true,
  installDir: DIR,
});
await settle(400);

const svc = root.rlmGitpixel;
const registry = () => ((globalThis as any).__rlmExtensionFactories ?? []) as any[];

check("the plugin registered despite having no binary", !!svc);
check("it contributed its factory anyway", registry().some((e: any) => e.id === "rlm-gitpixel"));
check("and reports itself inert for now", svc.stats().active === false, JSON.stringify(svc.stats()));

// Handlers must be harmless while inert.
const handlers: Record<string, Function[]> = {};
registry().find((e: any) => e.id === "rlm-gitpixel").factory({
  on: (ev: string, h: Function) => { (handlers[ev] ??= []).push(h); },
});
const inertEvent: any = { type: "tool_call", toolName: "code", input: { code: "%%bash\nrg foo src" } };
handlers["tool_call"][0](inertEvent);
check("an inert plugin changes nothing", inertEvent.input.code === "%%bash\nrg foo src", inertEvent.input.code);

// Wait for the background build.
console.log("  … waiting for the background build");
for (let i = 0; i < 120 && !svc.stats().active; i++) await settle(1000);

check("it built gitpixel and activated itself", svc.stats().active === true, JSON.stringify(svc.stats()));
check("the binary exists where it said", existsSync(join(DIR, "target", "release", "gitpixel")));
check("GITPIXEL_BIN now points at it", process.env.GITPIXEL_BIN === join(DIR, "target", "release", "gitpixel"),
  String(process.env.GITPIXEL_BIN));

// And now the same handler does substitute.
const liveEvent: any = { type: "tool_call", toolName: "code", input: { code: "%%bash\nrg foo src" } };
handlers["tool_call"][0](liveEvent);
check("the same handler now substitutes", liveEvent.input.code.includes("search foo src"), liveEvent.input.code);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

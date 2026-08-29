#!/usr/bin/env bun
import { Context } from "@deepseek-ai/cordis";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import Include from "@deepseek-ai/cordis-plugin-include";

import MemoryService from "../plugins/memory/index.js";
import RefineService from "../plugins/refine/index.js";
import SubagentService from "../plugins/subagent/index.js";
import KernelService from "../plugins/kernel/index.js";
import WoundService from "../plugins/wound/index.js";
import ReflectService from "../plugins/reflect/index.js";
import PeersService from "../plugins/peers/index.js";
import ExtensionsService from "../plugins/extensions/index.js";
import TuiService from "../plugins/tui/index.js";

import { version } from "../version.js";

const HOME = process.env.HOME ?? "~";
const DATA_DIR = `${HOME}/.rlm/data`;

async function main() {
  const ctx = new Context();

  console.log(`\x1b[1mrlm ${version}\x1b[0m — self-evolving terminal agent`);
  console.log(`\x1b[90mCordis kernel + prime-agent brain\x1b[0m\n`);

  // Bedrock: loader + timer + include (HMR depends on these)
  ctx.plugin(Loader, { root: process.cwd() });
  ctx.plugin(Timer);
  ctx.plugin(Include);

  // Bedrock: HMR — the hot-swap primitive
  ctx.plugin(Hmr, {
    base: process.cwd(),
    root: ["src/plugins"],
    ignored: ["**/node_modules", "**/.*", "cache", "data"],
    debounce: 100,
  });

  // Core plugins (dependency order matters)
  ctx.plugin(MemoryService, { dataDir: DATA_DIR });
  ctx.plugin(RefineService);
  ctx.plugin(SubagentService, { maxDepth: 10 });
  ctx.plugin(KernelService, {
    pythonPath: "python3",
    kernelDir: `${HOME}/.rlm/kernel`,
  });

  // Self-evolving plugins
  ctx.plugin(WoundService, { maxRefinePerPlugin: 3, cooldownTurns: 5 });
  ctx.plugin(ReflectService, { intervalTurns: 10 });

  // Connectivity
  ctx.plugin(PeersService, { discovery: "tailscale" });

  // Compatibility
  ctx.plugin(ExtensionsService, { extensionsDir: `${HOME}/.rlm/extensions` });

  // TUI — terminal surface (mounted last so it can observe all plugins)
  ctx.plugin(TuiService);

  // Shutdown handlers
  process.on("SIGINT", async () => {
    console.log("\n\x1b[90mshutting down...\x1b[0m");
    await ctx.fiber.dispose();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await ctx.fiber.dispose();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

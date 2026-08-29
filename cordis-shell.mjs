#!/usr/bin/env node
/**
 * rlm — Cordis lifecycle shell + prime-agent brain.
 *
 * Boots the Cordis plugin host from config/profile.yml, which composes
 * all rlm-* plugins (llm, session, kernel, agent, subagent, refinement,
 * wound, reflect, memory, extensions, skills, tui).
 *
 * Each plugin is a Cordis Service wrapping a prime-agent subsystem.
 * HMR can reload any plugin at runtime — that's the hot-swap primitive.
 *
 * After booting the plugin tree, hands control to the prime-agent CLI
 * (packages/coding-agent/dist/bundle/cli.js) which runs the TUI, kernel,
 * and agent loop using the services registered by the plugins.
 *
 * Foreground-only: the Cordis host + child process die when this process
 * exits. Session/memory/harness data persists on disk.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "packages", "coding-agent", "dist", "bundle", "cli.js");
const profilePath = join(here, "config", "profile.yml");

// HMR requires --expose-internals. Re-spawn if not present.
if (!process.execArgv.includes("--expose-internals")) {
	const args = ["--expose-internals", fileURLToPath(import.meta.url), ...process.argv.slice(2)];
	const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
} else {
	// Already running with --expose-internals — boot for real.
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

async function bootCordis() {
	let Context, Loader, Timer, Include, Hmr, Group, EntryTree;
	try {
		({ Context } = await import("@deepseek-ai/cordis"));
		Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
		Timer = (await import("@deepseek-ai/cordis-plugin-timer")).default;
		Include = (await import("@deepseek-ai/cordis-plugin-include")).default;
		Hmr = (await import("@deepseek-ai/cordis-plugin-hmr")).default;
		({ Group, EntryTree } = await import("@deepseek-ai/cordis-plugin-loader"));
	} catch (error) {
		console.error("[rlm] Cordis unavailable, running agent brain directly:", error?.message ?? error);
		return null;
	}

	try {
		const ctx = new Context();
		ctx.baseUrl = pathToFileURL(here + "/").href;

		// Bedrock: loader + timer + include (HMR depends on these)
		await ctx.plugin(Loader, { root: process.cwd() });
		ctx.plugin(Timer);

		// Register builtins for the loader
		const loader = ctx.get("loader");
		if (loader) {
			loader.builtins.include = Include;
			loader.builtins.group = Group;
		}

		// Mount the profile YAML through the loader (enables HMR)
		if (existsSync(profilePath)) {
			const rootInclude = {
				id: "include",
				name: "cordis:include",
				config: { path: pathToFileURL(profilePath).href },
			};
			try {
				const includeId = await loader.create(rootInclude);
				if (loader) await loader.await();
				console.error("[rlm] profile mounted, plugins loaded via loader");
			} catch (error) {
				console.error("[rlm] profile mount failed, falling back to direct import:", error?.message ?? error);
				// Fallback: load plugins directly (no HMR)
				await loadPluginsDirect(ctx);
			}
		}

		// HMR — the hot-swap primitive. Watches rlm plugin source dirs.
		try {
			ctx.plugin(Hmr, {
				base: process.cwd(),
				root: ["packages/rlm-*/src"],
				ignored: ["**/node_modules", "**/.*", "**/dist", "cache", "data"],
				debounce: 100,
			});
			console.error("[rlm] HMR active");
		} catch (error) {
			console.error("[rlm] HMR failed:", error?.message ?? error);
		}

		return ctx;
	} catch (error) {
		console.error("[rlm] Cordis boot failed, running agent brain directly:", error?.message ?? error);
		return null;
	}
}

/** Fallback: load plugins from profile YAML via direct import (no HMR). */
async function loadPluginsDirect(ctx) {
	const yaml = await import("yaml");
	const content = readFileSync(profilePath, "utf-8");
	const profile = yaml.parse(content);
	const entries = Array.isArray(profile) ? profile : (profile?.plugins ?? []);

	for (const entry of entries) {
		const pkgName = entry.name ?? entry;
		if (pkgName === "cordis:include" || pkgName?.startsWith("cordis:")) continue;
		const config = expandPaths(entry.config ?? {});
		try {
			const mod = await import(pkgName);
			const Plugin = mod.default ?? mod;
			ctx.plugin(Plugin, config);
			console.error(`[rlm] loaded plugin: ${pkgName}`);
		} catch (error) {
			console.error(`[rlm] failed to load plugin ${pkgName}:`, error?.message ?? error);
		}
	}
}

/** Expand ~ in path values. */
function expandPaths(config) {
	const home = process.env.HOME ?? "~";
	const result = {};
	for (const [key, value] of Object.entries(config)) {
		if (typeof value === "string" && value.startsWith("~")) {
			result[key] = join(home, value.slice(1));
		} else {
			result[key] = value;
		}
	}
	return result;
}

async function main() {
	const ctx = await bootCordis();
	const args = process.argv.slice(2);
	const child = spawn(process.execPath, [cliPath, ...args], { stdio: "inherit" });
	child.on("exit", (code, signal) => {
		if (ctx?.fiber?.dispose) void ctx.fiber.dispose();
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}

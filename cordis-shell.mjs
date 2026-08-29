#!/usr/bin/env node
/**
 * rlm — modified Cordis host + prime-agent brain, DSH philosophy.
 *
 * Everything is a plugin. The Cordis host owns process lifecycle + HMR.
 * The agent brain runs IN-PROCESS via runCli(), not as a spawned child.
 * Each rlm-* plugin owns its prime-agent subsystem as a Cordis Service.
 * HMR can dispose + reload any plugin at runtime — true hot-swap.
 *
 * Foreground-only: the process dies when the terminal exits.
 * Session/memory/harness data persists on disk.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const cliMainPath = join(here, "packages", "coding-agent", "dist", "bundle", "cli-main-SUK4CFDY.js");
const profilePath = join(here, "config", "profile.yml");

// HMR requires --expose-internals. Re-spawn if not present.
if (!process.execArgv.includes("--expose-internals")) {
	const { spawn } = await import("node:child_process");
	const args = ["--expose-internals", fileURLToPath(import.meta.url), ...process.argv.slice(2)];
	const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
} else {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

async function bootCordis() {
	let Context, Loader, Timer, Include, Hmr, Group;
	try {
		({ Context } = await import("@deepseek-ai/cordis"));
		Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
		Timer = (await import("@deepseek-ai/cordis-plugin-timer")).default;
		Include = (await import("@deepseek-ai/cordis-plugin-include")).default;
		Hmr = (await import("@deepseek-ai/cordis-plugin-hmr")).default;
		({ Group } = await import("@deepseek-ai/cordis-plugin-loader"));
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

		// HMR — the hot-swap primitive. Watches rlm plugin source dirs.
		// With --expose-internals + in-process runCli, HMR can dispose +
		// reload any plugin Service at runtime.
		try {
			ctx.plugin(Hmr, {
				base: process.cwd(),
				root: ["packages/rlm-*/src"],
				ignored: ["**/node_modules", "**/.*", "**/dist", "cache", "data"],
				debounce: 100,
			});
			console.error("[rlm] HMR active — hot-swap enabled");
		} catch (error) {
			console.error("[rlm] HMR failed:", error?.message ?? error);
		}

		// Load plugins from profile YAML
		if (existsSync(profilePath)) {
			await loadPlugins(ctx, loader);
		}

		return ctx;
	} catch (error) {
		console.error("[rlm] Cordis boot failed, running agent brain directly:", error?.message ?? error);
		return null;
	}
}

/** Load plugins from profile YAML. Tries loader mount first, falls back to direct import. */
async function loadPlugins(ctx, loader) {
	// Try loader-based mount (enables full HMR hot-reload)
	if (loader) {
		try {
			const rootInclude = {
				id: "include",
				name: "cordis:include",
				config: { path: pathToFileURL(profilePath).href },
			};
			await loader.create(rootInclude);
			await loader.await();
			console.error("[rlm] profile mounted via loader — full HMR hot-reload");
			return;
		} catch (error) {
			console.error("[rlm] loader mount failed, falling back to direct import:", error?.message ?? error);
		}
	}

	// Fallback: load plugins directly via import()
	const yaml = await import("yaml");
	const content = readFileSync(profilePath, "utf-8");
	const profile = yaml.parse(content);
	const entries = Array.isArray(profile) ? profile : (profile?.plugins ?? []);

	for (const entry of entries) {
		const pkgName = entry.name ?? entry;
		if (pkgName?.startsWith("cordis:")) continue;
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

	// Run the agent brain IN-PROCESS (not spawned).
	// This is critical for HMR: the Cordis host and the agent brain
	// share the same process, so HMR can hot-swap plugins that the
	// agent brain uses.
	try {
		const { runCli } = await import(pathToFileURL(cliMainPath).href);
		await runCli();
	} catch (error) {
		console.error("[rlm] agent brain failed:", error?.message ?? error);
		process.exit(1);
	} finally {
		if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
	}
}

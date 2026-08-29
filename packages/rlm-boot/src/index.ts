/**
 * @rlm/boot — rlm boot glue.
 *
 * Creates the Cordis Context, installs Loader + Timer + Include + HMR,
 * and mounts the profile YAML that composes all rlm plugins.
 *
 * This is the integration seam: the Cordis host owns process lifecycle
 * (foreground-only) and HMR; the profile YAML lists every plugin to load.
 * Each plugin wraps a prime-agent subsystem as a Cordis Service.
 */
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import Include from "@deepseek-ai/cordis-plugin-include";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BootOptions {
	/** Profile YAML path (absolute or relative to cwd). */
	profile?: string;
	/** Extra patch overlays applied after the profile layer. */
	patches?: string[];
	/** HMR root directories to watch. */
	hmrRoots?: string[];
}

export async function bootRlm(options: BootOptions = {}): Promise<Context> {
	const ctx = new Context();

	// Bedrock: loader + timer + include (HMR depends on these)
	ctx.plugin(Loader, { root: process.cwd() });
	ctx.plugin(Timer);
	ctx.plugin(Include);

	// HMR — the hot-swap primitive. Watches plugin source dirs.
	ctx.plugin(Hmr, {
		base: process.cwd(),
		root: options.hmrRoots ?? ["packages/rlm-*"],
		ignored: ["**/node_modules", "**/.*", "**/dist", "cache", "data"],
		debounce: 100,
	});

	// Mount the profile YAML — this is the include tree that loads all plugins.
	const profilePath = options.profile ?? join(process.cwd(), "config", "profile.yml");
	const patches = options.patches ?? [];

	try {
		const IncludeService = ctx.get("include");
		if (IncludeService) {
			await IncludeService.mount(profilePath, patches);
		}
	} catch (error) {
		ctx.logger?.warn(`profile mount failed: ${error}`);
	}

	return ctx;
}

/**
 * Fallback: directly load plugins from the profile YAML when the include
 * plugin is not available. This reads the YAML and loads each listed plugin
 * package via dynamic import.
 */
export async function bootRlmDirect(options: BootOptions = {}): Promise<Context> {
	const ctx = new Context();

	ctx.plugin(Loader, { root: process.cwd() });
	ctx.plugin(Timer);
	ctx.plugin(Include);

	ctx.plugin(Hmr, {
		base: process.cwd(),
		root: options.hmrRoots ?? ["packages"],
		ignored: ["**/node_modules", "**/.*", "**/dist", "cache", "data"],
		debounce: 100,
	});

	// Load the profile YAML and mount plugins directly
	const profilePath = options.profile ?? join(process.cwd(), "config", "profile.yml");
	try {
		const yaml = await import("yaml");
		const content = readFileSync(profilePath, "utf-8");
		const profile = yaml.parse(content);
		const plugins = profile?.plugins ?? [];
		for (const entry of plugins) {
			const pkgName = typeof entry === "string" ? entry : entry.name;
			const config = typeof entry === "string" ? {} : (entry.config ?? {});
			try {
				const mod = await import(pkgName);
				const Plugin = mod.default ?? mod;
				ctx.plugin(Plugin, config);
			} catch (error) {
				ctx.logger?.warn(`failed to load plugin ${pkgName}: ${error}`);
			}
		}
	} catch (error) {
		ctx.logger?.warn(`profile load failed: ${error}`);
	}

	return ctx;
}

export { Context, Loader, Timer, Include, Hmr };

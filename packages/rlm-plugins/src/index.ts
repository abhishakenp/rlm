/**
 * @rlm/plugins — how rlm grows a capability it did not have.
 *
 * Writing something rlm could not do at all, switching it on, and using it,
 * without stopping. Mounting writes a row to the overlay rather than to the
 * shipped composition, so everything rlm adds to itself is in one file,
 * reviewable, and revertible by deleting it.
 *
 * ## The part that is not copied from Iris
 *
 * Iris can do all of the above and it cost her two half-built, unmounted,
 * failing plugins sitting in her tree from mis-transcribed speech — silent
 * litter, invisible until somebody went looking. Two things here exist because
 * of that:
 *
 * 1. **`mount` verifies.** It writes the row, waits for the fiber, and reports
 *    the state it actually reached. A plugin that mounts into PENDING (waiting
 *    on a service that will never arrive — by far the most common way a
 *    generated plugin fails) or FAILED is rolled straight back out again, with
 *    the reason. "Mounted" means running, not "a row was written".
 * 2. **Every scaffold is tracked, and unfinished ones are loud.** `create`
 *    leaves a marker recording when and why. A package that has never mounted
 *    goes `draft` -> `stale` on a clock, and `doctor()` reports every stale one
 *    — into the system prompt, every turn, so rlm trips over its own
 *    abandoned work instead of needing to be asked about it. `adopt` says "this
 *    one is deliberate" and stops the nagging; `sweep` clears the rest.
 *
 * An abandoned scaffold should be visible and reclaimable, never silent.
 */
import { Service } from "@deepseek-ai/cordis";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { packageJson, source, test as testTemplate } from "./template.ts";

export const name = "rlm-plugins";

export interface RlmPluginsConfig {
	/** Directory holding plugin packages. Empty means the repo's own `packages/`. */
	dir?: string;
	/** Refuse to delete a package that is currently mounted. */
	protectMounted?: boolean;
	/** How long an unmounted scaffold may sit before it counts as abandoned, in minutes. */
	staleAfterMinutes?: number;
	/** Unmount again when a freshly mounted row does not reach ACTIVE. */
	rollbackOnFailure?: boolean;
	/** How long to wait for a newly mounted row to settle, in milliseconds. */
	mountTimeout?: number;
	/** Tell rlm, in its own prompt, that it can write and switch on new capabilities. */
	promptSection?: boolean;
	/** Where that section sorts among the others. */
	promptPriority?: number;
}

export const configFields = [
	{ key: "dir", type: "string", description: "Folder the plugin packages live in. Empty means the one that ships with rlm." },
	{ key: "protectMounted", type: "boolean", default: true, description: "Refuse to delete a plugin while it is still switched on." },
	{ key: "staleAfterMinutes", type: "number", default: 30, description: "How long a written-but-never-switched-on plugin may sit before rlm is told it is abandoned." },
	{ key: "rollbackOnFailure", type: "boolean", default: true, description: "If a plugin fails to start when switched on, switch it back off instead of leaving it broken." },
	{ key: "mountTimeout", type: "number", default: 4000, description: "How long to wait for a newly switched-on plugin to start, in milliseconds." },
	{ key: "promptSection", type: "boolean", default: true, description: "Tell rlm in its own prompt that it can write new capabilities. Off, it still can - it just will not think of it." },
	{ key: "promptPriority", type: "number", default: 330, description: "Where that sits in the assembled system prompt." },
];

/** A directory-safe, import-safe package name. */
const SAFE_NAME = /^rlm-[a-z0-9][a-z0-9-]*$/;

/**
 * `FiberState` is a `const enum` in cordis — type-only, erased at runtime, and
 * importing it throws at load. The numbers are the contract.
 */
const FIBER_STATE = ["PENDING", "LOADING", "ACTIVE", "FAILED", "DISPOSED", "UNLOADING"];
const ACTIVE = 2;

/** The marker file a scaffold carries, so its history outlives the process. */
export interface ScaffoldMarker {
	name: string;
	description: string;
	/** ISO timestamp of `create`. */
	createdAt: string;
	/** ISO timestamp of the first mount that reached ACTIVE, if there was one. */
	firstLiveAt?: string;
	/** Set by `adopt` — a reason this one is deliberately unmounted. */
	adopted?: { at: string; why: string };
}

export type PluginState =
	/** Mounted, and the fiber reached ACTIVE. The only state that means "working". */
	| "live"
	/** Mounted, but the fiber is not ACTIVE. Usually PENDING on a service that will never arrive. */
	| "broken"
	/** Written, never mounted, still young. */
	| "draft"
	/** Written, never mounted, and old enough to be litter. */
	| "stale"
	/** Written, never mounted, and declared deliberate by `adopt`. */
	| "parked"
	/** Has been live before and is switched off now. Deliberate, not litter. */
	| "off"
	/** On disk with no marker — shipped with rlm, or written by hand. */
	| "shipped";

export interface PluginPackage {
	name: string;
	description: string;
	path: string;
	/** The row id mounting it, when one is mounted. */
	mountedAs: string | null;
	/** Live fiber state, when mounted. */
	fiber?: string;
	state: PluginState;
	/** Minutes since the scaffold was written, for anything that has never been live. */
	ageMinutes?: number;
	/** Why this one needs attention, when it does. */
	note?: string;
}

export class RlmPluginsService extends Service {
	static inject = [] as const;
	static provide = "rlmPlugins" as const;

	declare config: RlmPluginsConfig;

	private detachPrompt: (() => void) | undefined;

	constructor(ctx: any, config: RlmPluginsConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		this.followPrompt();
		this.ctx.logger?.info?.("rlm-plugins: ready");
	}

	// ── the prompt ───────────────────────────────────────────────────────────

	/**
	 * Tell rlm it can grow, and show it its own unfinished work.
	 *
	 * `rlmPrompt` is probed, not injected: there is no optional form of inject,
	 * and a missing prompt registry must not take self-extension down with it.
	 * Re-attached whenever the service reappears and compared against the
	 * *current* one, because a fragment registered once at init is silently gone
	 * for the rest of the process the first time the prompt row reloads.
	 */
	private followPrompt() {
		this.ctx.effect(() => {
			this.contributePrompt();
			const off = this.ctx.on?.("internal/service", (service: string) => {
				if (service === "rlmPrompt") this.contributePrompt();
			});
			return () => {
				off?.();
				this.detachPrompt?.();
				this.detachPrompt = undefined;
			};
		}, "rlm-plugins prompt section");
	}

	private contributePrompt() {
		if (this.config.promptSection === false) return;
		const prompt = this.ctx.get?.("rlmPrompt");
		if (!prompt?.registerFragment) return;
		this.detachPrompt?.();
		const handle = prompt.registerFragment("rlm-plugins", {
			id: "self-extension",
			priority: this.config.promptPriority ?? 330,
			content: () => this.promptText(),
		});
		this.detachPrompt = () => handle.dispose();
	}

	private promptText(): string {
		const lines = [
			"## Growing a new capability",
			"",
			"You can write yourself a new capability and switch it on while running.",
			"No restart, ever. From a code cell:",
			"",
			'  self.plugin.new("rlm-weather", "Report the weather")   // writes the package',
			'  // edit packages/rlm-weather/src/index.ts with fs                          ',
			'  await self.plugin.mount("rlm-weather")                 // switches it on',
			'  await self.call("rlmWeather", "hello", "you")          // uses it',
			"",
			"Do this only when the work needs real code that outlives one cell: a",
			"service other rows consume, a socket, a watcher, a child process. A",
			"sequence of things you can already do is a code cell, not a plugin.",
			"",
			"`self.plugin.mount` verifies. It returns only once the row is ACTIVE, and",
			"switches a row that fails to start back off rather than leaving it broken.",
		];
		try {
			const packages = this.list();
			const live = packages.filter((p) => p.state === "live").length;
			lines.push("", `On disk now: ${packages.length} packages, ${live} switched on.`);
			const needy = packages.filter((p) => p.state === "stale" || p.state === "broken");
			if (needy.length) {
				lines.push("", "Unfinished work of yours, still here:");
				for (const p of needy) lines.push(`  - ${p.name}: ${p.note}`);
				lines.push(
					"Finish one, `self.plugin.adopt(name, why)` if it is deliberate, or",
					"`self.plugin.remove(name)` if it was a mistake. Do not just leave them.",
				);
			}
		} catch {
			// Nothing to say about the shelf is better than nothing at all.
		}
		return lines.join("\n");
	}

	// ── where things live ────────────────────────────────────────────────────

	/** Where packages live. The host knows the repo root; it is not guessable. */
	get dir(): string {
		if (this.config.dir) return this.config.dir;
		const host = this.ctx.get?.("rlmHost") as { root?: string } | undefined;
		if (!host?.root) throw new Error("cannot locate the packages directory — set plugins.dir");
		return join(host.root, "packages");
	}

	/** The module specifier a row uses to mount a package from this directory. */
	private specifier(name: string): string {
		return `./packages/${name}/src/index.ts`;
	}

	private markerPath(name: string): string {
		return join(this.dir, name, ".rlm-plugin.json");
	}

	private readMarker(name: string): ScaffoldMarker | undefined {
		try {
			return JSON.parse(readFileSync(this.markerPath(name), "utf8"));
		} catch {
			return undefined;
		}
	}

	private writeMarker(marker: ScaffoldMarker) {
		writeFileSync(this.markerPath(marker.name), JSON.stringify(marker, null, 2) + "\n");
	}

	private compose() {
		const compose = this.ctx.get?.("rlmCompose");
		if (!compose) throw new Error("the rlmCompose service is not mounted, so nothing can be added");
		return compose;
	}

	// ── reading ──────────────────────────────────────────────────────────────

	list(): PluginPackage[] {
		const dir = this.dir;
		if (!existsSync(dir)) return [];
		const compose = this.ctx.get?.("rlmCompose");
		const rows: any[] = compose?.rows?.() ?? [];
		const staleAfter = (this.config.staleAfterMinutes ?? 30) * 60_000;
		const now = Date.now();

		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => {
				const manifest = join(dir, entry.name, "package.json");
				let description = "";
				try {
					description = JSON.parse(readFileSync(manifest, "utf8")).description ?? "";
				} catch {
					// A directory without a readable manifest is still a package on
					// disk, and hiding it would make a broken one impossible to find.
				}
				const specifier = this.specifier(entry.name);
				const row = rows.find((r: any) => r.plugin === specifier);
				const marker = this.readMarker(entry.name);
				const pkg: PluginPackage = {
					name: entry.name,
					description: description || marker?.description || "",
					path: join(dir, entry.name),
					mountedAs: row && !row.disabled ? row.id : null,
					fiber: row?.state,
					state: "shipped",
				};

				if (row && !row.disabled) {
					pkg.state = row.state === "ACTIVE" ? "live" : "broken";
					if (pkg.state === "broken") {
						pkg.note = `mounted as "${row.id}" but its fiber is ${row.state ?? "unknown"} — ${
							row.state === "PENDING"
								? "it is waiting on a service that has not arrived; check its `inject`"
								: "it failed to start"
						}`;
					}
					return pkg;
				}

				if (!marker) {
					pkg.state = row ? "off" : "shipped";
					return pkg;
				}

				const age = now - Date.parse(marker.createdAt);
				pkg.ageMinutes = Math.round(age / 60_000);
				if (marker.firstLiveAt) {
					pkg.state = "off";
				} else if (marker.adopted) {
					pkg.state = "parked";
					pkg.note = `deliberately unmounted: ${marker.adopted.why}`;
				} else if (age > staleAfter) {
					pkg.state = "stale";
					pkg.note = `written ${pkg.ageMinutes} minutes ago for "${marker.description}" and never switched on`;
				} else {
					pkg.state = "draft";
				}
				return pkg;
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Everything that needs a decision: written and abandoned, or mounted and broken. */
	doctor(): PluginPackage[] {
		return this.list().filter((p) => p.state === "stale" || p.state === "broken");
	}

	// ── writing ──────────────────────────────────────────────────────────────

	/**
	 * Write a new plugin package. It is not mounted — scaffolding and switching
	 * on are separate on purpose, so a half-written plugin cannot take the
	 * running system down with it.
	 */
	create(name: string, description: string): PluginPackage {
		if (!SAFE_NAME.test(name)) {
			throw new Error(`"${name}" is not a usable plugin name — use rlm-something-lowercase`);
		}
		const path = join(this.dir, name);
		if (existsSync(path)) throw new Error(`${name} already exists`);

		const scaffold = { name, description };
		mkdirSync(join(path, "src"), { recursive: true });
		mkdirSync(join(path, "test"), { recursive: true });
		writeFileSync(join(path, "package.json"), packageJson(scaffold));
		writeFileSync(join(path, "src", "index.ts"), source(scaffold));
		writeFileSync(join(path, "test", `${name}.test.ts`), testTemplate(scaffold));
		this.writeMarker({ name, description, createdAt: new Date().toISOString() });

		this.ctx.emit?.("rlm/plugins-changed", name, "created");
		this.ctx.logger?.info?.(`plugins: created ${name}`);
		return { name, description, path, mountedAs: null, state: "draft", ageMinutes: 0 };
	}

	/**
	 * Switch a package on, and confirm it actually started.
	 *
	 * Writing the overlay row is the easy half. The half that matters is the
	 * wait: a generated plugin's most common failure is to `inject` a service
	 * that will never exist, which produces no error at all — the fiber sits in
	 * PENDING and the capability silently is not there. Reporting "mounted" for
	 * that is how a tree fills up with plugins nobody knows are dead.
	 */
	async mount(name: string, id?: string, config?: Record<string, unknown>) {
		const pkg = this.list().find((p) => p.name === name);
		if (!pkg) throw new Error(`no plugin package "${name}"`);
		if (pkg.mountedAs) throw new Error(`${name} is already mounted as "${pkg.mountedAs}"`);
		const compose = this.compose();

		const rowId = id ?? name.replace(/^rlm-/, "");
		compose.add({ id: rowId, plugin: this.specifier(name), config });

		const state = await this.settle(rowId);
		if (state === "ACTIVE") {
			const marker = this.readMarker(name);
			if (marker && !marker.firstLiveAt) {
				marker.firstLiveAt = new Date().toISOString();
				delete marker.adopted;
				this.writeMarker(marker);
			}
			this.ctx.emit?.("rlm/plugins-changed", name, `mounted as ${rowId}`);
			return { name, id: rowId, state, ok: true as const };
		}

		const why =
			state === "PENDING"
				? "it is waiting on a service that has not arrived — check its `inject` list, and remember there is no optional inject"
				: state === "FAILED"
					? "it threw while starting — check the log"
					: `it settled in ${state}`;

		if (this.config.rollbackOnFailure !== false) {
			compose.reset(rowId);
			this.ctx.emit?.("rlm/plugins-changed", name, `mount failed (${state}), rolled back`);
			throw new Error(`${name} did not start: ${why}. Switched back off; the package is still on disk.`);
		}
		this.ctx.emit?.("rlm/plugins-changed", name, `mounted as ${rowId} but ${state}`);
		return { name, id: rowId, state, ok: false as const, why };
	}

	/**
	 * Wait for a row to stop moving.
	 *
	 * The overlay goes to disk, `@rlm/boot`'s watch sees it, Include re-composes
	 * and the fiber starts — several hops, none of them synchronous with this
	 * call. Polling is right here rather than an event: there is no single
	 * cordis event that means "this specific row has settled", and a row that
	 * never appears at all (a specifier that does not resolve) has to time out
	 * rather than wait forever.
	 */
	private async settle(rowId: string): Promise<string> {
		const deadline = Date.now() + (this.config.mountTimeout ?? 4000);
		let last = "absent";
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 60));
			const row = this.ctx.get?.("rlmCompose")?.row?.(rowId);
			if (!row) continue;
			last = row.state ?? "absent";
			if (last === "ACTIVE" || last === "FAILED") return last;
		}
		return last;
	}

	/** Switch it off again by removing the row. It stays on disk. */
	unmount(name: string) {
		const pkg = this.list().find((p) => p.name === name);
		if (!pkg?.mountedAs) throw new Error(`${name} is not mounted`);
		this.compose().reset(pkg.mountedAs);
		this.ctx.emit?.("rlm/plugins-changed", name, "unmounted");
		return pkg.mountedAs;
	}

	/**
	 * Declare an unmounted scaffold deliberate, so it stops being reported as
	 * abandoned. The reason is required — "why is this still here" is the whole
	 * question, and an adopt with no answer to it is just a snooze button.
	 */
	adopt(name: string, why: string) {
		if (!why?.trim()) throw new Error("adopt needs a reason — that is the point of it");
		const marker = this.readMarker(name);
		if (!marker) throw new Error(`${name} has no scaffold marker — nothing is nagging you about it`);
		marker.adopted = { at: new Date().toISOString(), why };
		this.writeMarker(marker);
		this.ctx.emit?.("rlm/plugins-changed", name, "adopted");
		return { name, state: "parked" as const, why };
	}

	/** Delete the package from disk. Switch it off first. */
	remove(name: string) {
		const pkg = this.list().find((p) => p.name === name);
		if (!pkg) throw new Error(`no plugin package "${name}"`);
		if (pkg.mountedAs && this.config.protectMounted !== false) {
			throw new Error(`${name} is mounted as "${pkg.mountedAs}" — unmount it first`);
		}
		rmSync(pkg.path, { recursive: true, force: true });
		this.ctx.emit?.("rlm/plugins-changed", name, "removed");
		return `${name} deleted`;
	}

	/**
	 * Clear out abandoned scaffolds.
	 *
	 * Reports by default and only deletes when told to, because the whole
	 * failure this exists to fix is work disappearing quietly. Only ever touches
	 * packages that carry a marker and have never once been live — a shipped row
	 * and a plugin that used to work are both out of reach of this.
	 */
	sweep({ apply = false }: { apply?: boolean } = {}) {
		const stale = this.list().filter((p) => p.state === "stale");
		if (!apply) return { would: stale.map((p) => p.name), removed: [] as string[] };
		const removed: string[] = [];
		for (const p of stale) {
			rmSync(p.path, { recursive: true, force: true });
			removed.push(p.name);
			this.ctx.emit?.("rlm/plugins-changed", p.name, "swept");
		}
		return { would: [], removed };
	}
}

export default RlmPluginsService;

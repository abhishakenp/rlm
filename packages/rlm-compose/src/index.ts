/**
 * @rlm/compose — rlm's knowledge of its own wiring, and its hands on it.
 *
 * `cordis.yml` is the application. This row is what makes that fact useful to
 * rlm itself rather than only to whoever is holding the editor: it enumerates
 * every row, reports what each one accepts, and changes them.
 *
 * **Every write goes to the overlay, never to `cordis.yml`.** The repository
 * file is the shipped default and should stay diffable; the overlay is where a
 * running system's decisions accumulate. That split is also the undo — delete
 * the overlay and rlm is back to stock, whatever it did to itself in between.
 *
 * Nothing here reloads anything. It writes a file `@rlm/boot` is already
 * watching, and the existing config path does the rest. A change made by rlm
 * and a change made by hand are therefore the same event, with one code path
 * to be correct.
 */
import { Service } from "@deepseek-ai/cordis";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";

export const name = "rlm-compose";

export interface RlmComposeConfig {
	/** Where overrides are written. Defaults to `cordis.patch.yml` in rlm's home. */
	overlay?: string;
}

export const configFields = [
	{
		key: "overlay",
		type: "string",
		description:
			"The file rlm writes its own changes into. The shipped setup is never edited; this sits on top of it, so deleting this one file puts everything back. Defaults to a cordis.patch.yml inside rlm's home — set it only to keep a second rlm from sharing it, and set the boot row to match, or rlm will write somewhere nothing reads.",
	},
];

/**
 * Rows that exist because of how the composition is loaded, not because of
 * anything rlm can do about them.
 *
 * The host mounts `cordis-plugin-include` itself in order to read `cordis.yml`
 * at all, so it turns up in `loader.entries()` beside the real capabilities,
 * with a generated hex id because nobody wrote it down in a file. Enabling,
 * disabling or reconfiguring it would take every other row down with it, so it
 * is not a capability and is not offered as one.
 */
const LOADER_MACHINERY = new Set(["@deepseek-ai/cordis-plugin-include"]);

/** One row of the composition, as rlm sees it. */
export interface Row {
	id: string;
	/** Module specifier — the plugin this row mounts. */
	plugin: string;
	/** Effective config after the overlay. */
	config: Record<string, unknown>;
	disabled: boolean;
	/** Live fiber state, when the row is running. */
	state?: string;
	/** Fields this plugin documents, when it exports any. */
	accepts?: Field[];
}

export interface Field {
	key: string;
	type: string;
	description?: string;
	default?: unknown;
}

/**
 * `FiberState` is a `const enum` in cordis — type-only, erased at runtime, and
 * importing it throws at load. The numbers are the contract.
 */
const FIBER_STATE = ["PENDING", "LOADING", "ACTIVE", "FAILED", "DISPOSED", "UNLOADING"];

export class RlmComposeService extends Service {
	static inject = [] as const;
	static provide = "rlmCompose" as const;

	declare config: RlmComposeConfig;

	/** Field descriptors imported for rows that are not running, keyed by specifier. */
	private readonly dormant = new Map<string, Field[] | undefined>();

	constructor(ctx: any, config: RlmComposeConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		this.ctx.logger?.info?.("rlm-compose: ready");
	}

	/**
	 * The one overlay path, and it has to be the *same* one `@rlm/boot` reads.
	 *
	 * Hardcoding `~/.rlm` here works right up until a second rlm runs with
	 * `RLM_HOME` set, at which point this service writes `~/.rlm/…` while boot
	 * reads `$RLM_HOME/…` — rlm edits its own configuration and nothing happens.
	 * No error, no warning, the change on disk in the wrong file. Probed rather
	 * than injected (there is no optional `inject`) and read on every call
	 * rather than captured at init, because the boot row can be replaced under a
	 * running service.
	 */
	get overlayPath(): string {
		if (this.config.overlay) return this.config.overlay;
		const host = this.ctx.get?.("rlmHost") as { overlay?: string; home?: string } | undefined;
		if (host?.overlay) return host.overlay;
		const home = host?.home ?? process.env.RLM_HOME ?? join(homedir(), ".rlm");
		return join(home, "cordis.patch.yml");
	}

	// ── reading ──────────────────────────────────────────────────────────────

	/** Every loader entry standing for a capability, in composition order. */
	private entries(): any[] {
		const entries: any[] = [];
		const loader = this.ctx.loader;
		if (!loader?.entries) return entries;
		for (const entry of loader.entries()) {
			const options = (entry as any).options ?? {};
			if (!options.name) continue; // a group, not a plugin
			if (LOADER_MACHINERY.has(options.name)) continue;
			entries.push(entry);
		}
		return entries;
	}

	private toRow(entry: any): Row {
		const options = entry.options ?? {};
		const raw = entry.fiber?.state;
		return {
			id: options.id ?? "(unnamed)",
			plugin: options.name,
			config: options.config ?? {},
			disabled: Boolean(options.disabled),
			state: typeof raw === "number" ? FIBER_STATE[raw] : undefined,
			accepts: this.fieldsOf(entry),
		};
	}

	/** Every row currently composed, in composition order. */
	rows(): Row[] {
		return this.entries().map((entry) => this.toRow(entry));
	}

	row(id: string): Row | undefined {
		const entry = this.entries().find((e) => e.options?.id === id);
		return entry && this.toRow(entry);
	}

	/**
	 * One row, with its parameters filled in even when it is switched off.
	 *
	 * Asynchronous because a row that is off has no fiber, and the descriptor
	 * lives on the module — so for anything not running there is nothing loaded
	 * to ask. That is exactly the case that matters: "what could I change about
	 * X" is a question asked *before* turning X on. Importing runs the module's
	 * top level, which for a plugin is only its declarations; starting it is a
	 * separate act this method deliberately does not perform.
	 */
	async describe(id: string): Promise<Row> {
		const entry = this.entries().find((e) => e.options?.id === id);
		if (!entry) throw new Error(`no row "${id}". Try rows().`);
		if (!this.fieldsOf(entry)) await this.learn(entry);
		return this.toRow(entry);
	}

	/**
	 * Import a dormant row's module once and remember what it documents.
	 *
	 * Failure is recorded as "nothing", not retried: a specifier that does not
	 * resolve will not resolve on the next question either, and re-importing a
	 * broken module every time turns one bad row into a slow list.
	 */
	private async learn(entry: any): Promise<void> {
		const specifier = entry?.options?.name;
		if (!specifier || this.dormant.has(specifier)) return;
		try {
			const exports = await entry.parent.tree.import(specifier);
			const plugin = this.ctx.loader.unwrapExports(exports);
			this.dormant.set(specifier, exports?.configFields ?? plugin?.configFields);
		} catch (error: any) {
			this.dormant.set(specifier, undefined);
			this.ctx.logger?.debug?.(`compose: cannot read ${specifier} (${error?.message ?? error})`);
		}
	}

	/**
	 * What a row documents about its own parameters.
	 *
	 * Best effort by design. A plugin that documents nothing is still a legal
	 * plugin, and an unfamiliar shape should degrade to "I cannot describe this"
	 * rather than take the whole listing down — this is the method answering
	 * "what can I change?", so it is the last place that should throw.
	 */
	private fieldsOf(entry: any): Field[] | undefined {
		try {
			const plugin = entry?.fiber?.runtime?.callback ?? entry?.plugin;
			return (
				plugin?.configFields ??
				plugin?.default?.configFields ??
				this.dormant.get(entry?.options?.name) ??
				undefined
			);
		} catch {
			return undefined;
		}
	}

	// ── writing ──────────────────────────────────────────────────────────────

	/** The overlay as it is on disk. Absent is an empty list, not an error. */
	private readOverlay(): any[] {
		const path = this.overlayPath;
		if (!existsSync(path)) return [];
		try {
			const parsed = parse(readFileSync(path, "utf8"));
			return Array.isArray(parsed) ? parsed : [];
		} catch (error: any) {
			throw new Error(`overlay is not readable (${error?.message ?? error})`);
		}
	}

	/**
	 * Write the overlay atomically.
	 *
	 * The boot row is watching this file, so a partially written one would be
	 * parsed. Writing beside it and renaming over the top means a reader sees
	 * either the old file or the new one — the rename is what makes the change a
	 * single event rather than a window in which rlm has no config.
	 */
	private writeOverlay(rows: any[], rowId: string, change: string) {
		const path = this.overlayPath;
		mkdirSync(dirname(path), { recursive: true });
		const body =
			"# Written by rlm. Hand edits are fine - it reads this back before\n" +
			"# every change. Delete it to return to the shipped composition.\n" +
			stringify(rows);
		const temporary = `${path}.tmp`;
		writeFileSync(temporary, body);
		renameSync(temporary, path);
		this.ctx.emit?.("rlm/config-written", rowId, change);
		this.ctx.logger?.info?.(`compose: ${rowId} ${change}`);
	}

	/** Find or create this row's patch entry in the overlay. */
	private patchFor(rows: any[], id: string): Record<string, any> {
		const existing = rows.find((r) => r && r.id === id && !r.insert);
		if (existing) return existing;
		const created: Record<string, any> = { id };
		rows.push(created);
		return created;
	}

	/**
	 * Change one row's config.
	 *
	 * Merged over what the row has now, not over what the overlay happens to
	 * hold: a patch replaces a row's whole config when applied, so writing only
	 * the changed key would silently drop everything set in `cordis.yml`.
	 */
	set(id: string, changes: Record<string, unknown>) {
		const row = this.row(id);
		if (!row) throw new Error(`no row "${id}". Try rows().`);
		const rows = this.readOverlay();
		const patch = this.patchFor(rows, id);
		patch.config = { ...row.config, ...patch.config, ...changes };
		this.writeOverlay(rows, id, `config ${Object.keys(changes).join(", ")}`);
		return patch.config;
	}

	/** Turn a row on or off without deleting it. */
	setEnabled(id: string, enabled: boolean) {
		if (!this.row(id)) throw new Error(`no row "${id}". Try rows().`);
		const rows = this.readOverlay();
		this.patchFor(rows, id).disabled = !enabled;
		this.writeOverlay(rows, id, enabled ? "enabled" : "disabled");
	}

	/** Mount a plugin that is not in the shipped composition. */
	add(row: { id: string; plugin: string; config?: Record<string, unknown> }) {
		if (this.row(row.id)) throw new Error(`row "${row.id}" already exists`);
		const rows = this.readOverlay();
		const insert = rows.find((r) => r && Array.isArray(r.insert));
		const entry: Record<string, unknown> = { id: row.id, name: row.plugin };
		if (row.config) entry.config = row.config;
		if (insert) insert.insert.push(entry);
		else rows.push({ insert: [entry] });
		this.writeOverlay(rows, row.id, `added (${row.plugin})`);
	}

	/** Drop everything the overlay says about a row, back to shipped defaults. */
	reset(id: string) {
		const rows = this.readOverlay().filter((r) => {
			if (r?.id === id) return false;
			if (Array.isArray(r?.insert)) {
				r.insert = r.insert.filter((e: any) => e?.id !== id);
				return r.insert.length > 0;
			}
			return true;
		});
		this.writeOverlay(rows, id, "reset to shipped default");
	}
}

export default RlmComposeService;

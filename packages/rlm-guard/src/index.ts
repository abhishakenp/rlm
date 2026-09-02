/**
 * @rlm/guard — the row that keeps the fleet from editing the thing that bounds
 * the fleet.
 *
 * ## Why this exists
 *
 * `capacity()` in `packages/rlm-delegate/src/capacity.ts` decides how many
 * delegated children may run at once. It is not a setting: it reads open file
 * descriptors, available memory and busy cores off the machine, and under a 30%
 * floor on any of them it returns zero and the queue waits. That number is the
 * only thing standing between a delegation and a laptop that has to be held
 * down to power off.
 *
 * Every one of those children is an rlm with a `code` tool. An agent that is
 * told "nothing new starts, the machine is full" and can edit the file that
 * said so will edit the file that said so — not maliciously, but because from
 * inside the task it looks like a bug in the limiter rather than a fact about
 * the machine. A self-modifying resource limiter is not a limiter.
 *
 * So the fleet may read it, reason about it, and argue with it. It may not
 * write it.
 *
 * ## Two layers
 *
 * **The door** (`detect.ts`). The delegated agent has exactly one tool: `code`.
 * Every read, search and edit it performs goes through it, and a `tool_call`
 * handler contributed into every AgentSession refuses a cell that would write a
 * protected path — `{ block: true, reason }`, refusal rather than rewriting,
 * with a reason written for the model that has to read it. Heuristic, and
 * honest about it: see that file's header for exactly what it does not catch.
 *
 * **The backstop** (`restore.ts`). The blob hash and bytes of every protected
 * file are recorded at boot, the files are watched, and an unauthorised change
 * is put back. It does not care how the change got there, which is the point of
 * having it: layer 1 can be wrong and this cannot be bypassed by finding a
 * spelling layer 1 does not know.
 *
 * ## Why the guard protects itself
 *
 * `packages/rlm-guard/src/**` is on the list whatever the config says, and so
 * is `cordis.yml`. Without the first, the shortest path through the door is to
 * edit the door: delete a line from the protected list, or make `inspectCell`
 * return null, and then edit capacity.ts freely. Without the second, delete the
 * `guard` row from the composition and the door is not there at all. Neither is
 * a hypothetical — they are the first two things anything competent would try,
 * and they are cheaper than the thing they bypass.
 *
 * `cordis.yml` being protected costs nothing rlm needs. rlm changes itself
 * through `~/.rlm/cordis.patch.yml`, the overlay, which `rlm-compose` writes and
 * `rlm-boot` layers on top — so self-extension is untouched. **And that overlay
 * is the honest remaining hole**: a row that can write it can set
 * `disabled: true` on `guard`, and the guard cannot protect the overlay without
 * taking self-extension with it. Layer 1 refuses an overlay write that also
 * names this row, which is a heuristic and is named as one here so nobody reads
 * this comment and believes the hole is closed.
 *
 * ## Authorisation
 *
 * A sentinel file with a TTL, ignored outright in a delegated child. The
 * reasoning — including why an environment variable is the wrong instrument
 * here, given that `agent.ts` hands every child the whole parent environment
 * and a code cell can assign to `process.env` — is in `unlock.ts`.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { inspectCell, type Refusal } from "./detect.ts";
import {
	pathDirFileIn,
	pathDirsFromEnv,
	readDirBaseline,
	resolvePathDirs,
	underPathDir,
	watchPathDirs,
	type PathDirBaseline,
	type PathIncident,
	type ProtectedPathDir,
} from "./pathdir.ts";
import { namedIn, resolveProtected, type ProtectedFile, type ProtectSpec } from "./protect.ts";
import { readBaseline, watchProtected, type Baseline, type Incident } from "./restore.ts";
import { clearUnlock, defaultUnlockFile, isDelegateChild, unlockState, writeUnlock, type UnlockState } from "./unlock.ts";

export const name = "rlm-guard";
export const inject = ["rlmConfig"] as const;

const PLUGIN_ID = "rlm-guard";

export interface RlmGuardConfig {
	/** Repo root. Defaults to rlmConfig's cwd. */
	cwd?: string;
	/**
	 * Extra paths or globs to protect, on top of the ones that are not optional.
	 *
	 * Configurable so the overlay can extend the list without a code edit. It
	 * cannot *shrink* it: the guard's own source and `cordis.yml` are added
	 * regardless — see the header.
	 */
	protect?: string[];
	/** One sentence explaining the configured entries, used in refusals. */
	why?: string;
	/** Run the backstop watcher. Default true, and never in a delegated child. */
	restore?: boolean;
	/** How long to wait after a change before acting, so an editor's save is not fought. */
	debounceMs?: number;
	/** Where the unlock sentinel lives. Default `~/.rlm/guard-unlock.json`. */
	unlockFile?: string;
	/** The longest an unlock may claim, in minutes. */
	unlockMaxMinutes?: number;
	/**
	 * Extra directories to protect by prefix, on top of PATH.
	 *
	 * Additive only, like `protect`. The two named in `INHERENT_PATH_DIRS` and
	 * everything on PATH outside the repo are protected whatever is written here
	 * — a list a delegated child could shorten is not a list.
	 */
	protectPathDirs?: string[];
	/** Derive the protected directories from `PATH`. Default true. */
	protectPath?: boolean;
	/** Snapshot regular files up to this size for the backstop. Default 256 KiB. */
	pathSnapshotMaxBytes?: number;
	/** Run the PATH-directory backstop. Default follows `restore`. */
	restorePathDirs?: boolean;
}

/** The reason attached to the entry this row exists for. */
const CAPACITY_WHY =
	"capacity() is the resource limiter for delegation: it decides how many children may run at once, and it " +
	"reads that off the machine — descriptors, available memory, busy cores — rather than from a setting. The " +
	"fleet is not allowed to edit the thing that bounds the fleet. An agent that raises its own ceiling because " +
	"a task will not start is how the laptop it is running on dies.";

const GUARD_WHY =
	"This is rlm-guard's own source. If the fleet could edit the guard, the guard would be one edit away from " +
	"not existing, and every other protected file would follow.";

const PATH_WHY =
	"This is a directory on Abhi's PATH. What lives here decides what the word `iris` — or `node`, or `rg` — means " +
	"for every process on this machine, including the monitors that are supposed to notice when something is wrong. " +
	"On 2026-09-03 two delegated children wrote shims here to satisfy criteria of the form `iris X | grep -q Y`; the " +
	"hot-reload gate and the deadman then alarmed for six hours about a fault that did not exist, because the client " +
	"they call was no longer the client. The fleet does not install commands.";

/**
 * Protected whether or not PATH mentions them.
 *
 * `~/.local/bin` is Abhi's own shim directory and the one the monitors call.
 * `/opt/homebrew/bin` is where the second hijack landed. Both are named here so
 * that a truncated or unusual PATH in some child cannot quietly drop them.
 */
const INHERENT_PATH_DIRS = ["~/.local/bin", "/opt/homebrew/bin"];

const COMPOSITION_WHY =
	"cordis.yml is the composition — the list of rows rlm boots, including this one. Deleting a row from it " +
	"removes the code that would have refused the next edit. rlm changes itself through the overlay at " +
	"~/.rlm/cordis.patch.yml, which is not protected, so nothing rlm legitimately does needs this file.";

/** The list nothing in config can shorten. */
const inherentSpecs = (unlockFile: string): ProtectSpec[] => [
	{ pattern: "packages/rlm-guard/src/**", why: GUARD_WHY, inherent: true },
	{ pattern: "packages/rlm-guard/package.json", why: GUARD_WHY, inherent: true },
	{ pattern: "cordis.yml", why: COMPOSITION_WHY, inherent: true },
	{
		pattern: unlockFile,
		why:
			"This is the guard's unlock sentinel. Writing it is how a protected file becomes writable, so writing it " +
			"is itself protected. Only Abhi unlocks the guard.",
		inherent: true,
		// The door refuses it; the backstop leaves it alone. Restoring a file
		// whose purpose is to appear and disappear means fighting every honest
		// unlock, and — observed on the live drive — writing a stale sentinel
		// back for ever once one is in the boot snapshot.
		watch: false,
	},
];

/** Extension factories contributed by rows, drained by @rlm/agent for every session. */
type FactoryEntry = { id: string; factory: (pi: unknown) => void };
const factoryRegistry = (): FactoryEntry[] => {
	const g = globalThis as unknown as { __rlmExtensionFactories?: FactoryEntry[] };
	if (!Array.isArray(g.__rlmExtensionFactories)) g.__rlmExtensionFactories = [];
	return g.__rlmExtensionFactories as FactoryEntry[];
};

export interface GuardReport {
	protecting: string[];
	/** Directories protected by prefix — every path under them, existing or not. */
	protectingDirs: string[];
	unlock: UnlockState;
	child: boolean;
	watching: boolean;
	refusals: number;
	incidents: Incident[];
}

export class RlmGuardService extends Service {
	static inject = ["rlmConfig"] as const;
	static provide = "rlmGuard" as const;

	declare config: RlmGuardConfig;

	private root = process.cwd();
	private files: ProtectedFile[] = [];
	private pathDirs: ProtectedPathDir[] = [];
	private pathBaselines: PathDirBaseline[] = [];
	private stopWatchingPath: (() => void) | null = null;
	private baselines: Baseline[] = [];
	private stopWatching: (() => void) | null = null;
	private refusals = 0;
	private incidents: Incident[] = [];

	constructor(ctx: unknown, config: RlmGuardConfig = {}) {
		super(ctx as never, undefined as never);
		this.config = config;
	}

	private get unlockFile(): string {
		return this.config.unlockFile ?? defaultUnlockFile();
	}

	private get maxMinutes(): number {
		return this.config.unlockMaxMinutes ?? 60;
	}

	private get snapshotMaxBytes(): number {
		return this.config.pathSnapshotMaxBytes ?? 256 * 1024;
	}

	private say(level: "info" | "warn", message: string) {
		try {
			(globalThis as { __rlmLog?: (l: string, tag: string, m: string) => void }).__rlmLog?.(level, "guard", message);
		} catch {
			/* the log row may not be up; the logger below is the other half */
		}
		const logger = (this.ctx as { logger?: { info?: (m: string) => void; warn?: (m: string) => void } }).logger;
		if (level === "warn") logger?.warn?.(message);
		else logger?.info?.(message);
	}

	async [Service.init]() {
		const rlmConfig = this.ctx.get("rlmConfig") as
			| { getSettingsManager?: () => { getCwd?: () => string } | undefined }
			| undefined;
		// `cordis.yml` carries `cwd: .` for its neighbours, so resolve: a literal
		// "." compared against absolute paths fails every comparison silently.
		this.root = resolve(this.config.cwd ?? rlmConfig?.getSettingsManager?.()?.getCwd?.() ?? process.cwd());

		const configured: ProtectSpec[] = (
			this.config.protect ?? ["packages/rlm-delegate/src/capacity.ts"]
		).map((pattern) => ({
			pattern,
			why: pattern.includes("capacity.ts") ? CAPACITY_WHY : (this.config.why ?? "Abhi put this path on the protected list."),
		}));
		this.files = resolveProtected(this.root, [...configured, ...inherentSpecs(this.unlockFile)]);

		// Directories, by prefix. Derived from PATH rather than written down: the
		// property that matters is "a name the shell will find", and that is what
		// PATH means. See pathdir.ts for why this cannot reuse the file matcher.
		this.pathDirs = resolvePathDirs([
			...INHERENT_PATH_DIRS.map((dir) => ({ dir, why: PATH_WHY })),
			...(this.config.protectPath === false ? [] : pathDirsFromEnv(process.env.PATH, this.root)).map((dir) => ({
				dir,
				why: PATH_WHY,
			})),
			...(this.config.protectPathDirs ?? []).map((dir) => ({ dir, why: PATH_WHY })),
		]);

		// The door, first and always — a delegated child gets this and nothing
		// else, and a child is exactly where it has to work.
		this.contributeFactory();

		const wantWatch = this.config.restore !== false && !isDelegateChild();
		if (wantWatch) this.startWatching();
		const wantPathWatch = (this.config.restorePathDirs ?? this.config.restore !== false) && !isDelegateChild();
		if (wantPathWatch) this.startWatchingPathDirs();

		this.say(
			"info",
			`rlm-guard: ${this.files.length} path(s) and ${this.pathDirs.length} PATH director${
				this.pathDirs.length === 1 ? "y" : "ies"
			} protected, door on, backstop ${
				wantWatch ? "on" : isDelegateChild() ? "off (delegated child)" : "off (disabled in config)"
			} — ${this.unlockState().why}`,
		);
	}

	/* ───────────────────────────── layer 1 ───────────────────────────── */

	private contributeFactory() {
		(this.ctx as { effect: (fn: () => () => void) => void }).effect(() => {
			const registry = factoryRegistry();
			const stale = registry.findIndex((e) => e.id === PLUGIN_ID);
			if (stale >= 0) registry.splice(stale, 1);
			const entry: FactoryEntry = { id: PLUGIN_ID, factory: (pi) => this.register(pi) };
			registry.push(entry);
			return () => {
				const i = registry.indexOf(entry);
				if (i >= 0) registry.splice(i, 1);
			};
		});
	}

	/**
	 * Wire the refusal onto one AgentSession.
	 *
	 * `emitToolCall` does **not** wrap `tool_call` handlers in a try/catch the
	 * way it does the other events, so a throw here would surface as a broken
	 * tool call. Hence the catch, and hence its bias: an internal failure blocks
	 * only when the cell names a protected file at all, so a bug in the guard
	 * cannot brick every unrelated cell in the session and cannot silently open
	 * the one door it exists to hold.
	 */
	register(pi: unknown) {
		const on = (pi as { on: (event: string, handler: (e: unknown) => unknown) => void }).on;
		on.call(pi, "tool_call", (event: unknown) => {
			const e = event as { toolName?: string; input?: Record<string, unknown> };
			if (!this.files.length) return undefined;
			let text: string | null = null;
			if (e.toolName === "code") text = typeof e.input?.code === "string" ? (e.input.code as string) : null;
			else if (e.input) {
				// Defensive: rlm's agent has one tool, but a composition that adds an
				// `edit`/`write` tool should not silently lose the door.
				const path = e.input.file_path ?? e.input.path ?? e.input.filePath;
				text = typeof path === "string" ? path : null;
			}
			if (text === null) return undefined;

			try {
				const refusal =
					e.toolName === "code"
						? inspectCell(text, this.root, this.overlayIfAboutThisRow(text), this.pathDirs)
						: this.refuseWholePath(text);
				if (!refusal) return undefined;
				this.refusals++;
				this.say("warn", `rlm-guard: refused a write to ${refusal.file.rel} (${refusal.how}) — ${refusal.evidence}`);
				return { block: true, reason: refusal.reason };
			} catch (error: unknown) {
				const named = namedIn(text, this.files);
				this.say("warn", `rlm-guard: the door failed on a cell (${(error as Error)?.message ?? String(error)})`);
				if (!named) return undefined;
				return {
					block: true,
					reason:
						`Refused by rlm-guard: this cell names ${named.rel}, which is protected, and the guard could not ` +
						`finish inspecting it. It is refused rather than allowed. ${named.why}`,
				};
			}
		});
	}

	/**
	 * The overlay, but only when the cell is talking about this row.
	 *
	 * `~/.rlm/cordis.patch.yml` cannot go on the protected list — it is how rlm
	 * legitimately changes itself, and protecting it would end self-extension.
	 * But `disabled: true` on the `guard` entry, written there, removes this row
	 * and everything it holds. So the overlay is treated as protected *for the
	 * duration of one cell* when that cell also names this row. A cell adding an
	 * unrelated row to the overlay is untouched.
	 *
	 * A heuristic sitting on top of a heuristic, and it is worth exactly what
	 * that sounds like: it stops the obvious move and nothing cleverer. The
	 * backstop cannot help here, because an overlay edit is not a change to a
	 * file the backstop knows.
	 */
	private overlayIfAboutThisRow(code: string): ProtectedFile[] {
		if (!/rlm-guard|\bguard\b/i.test(code)) return this.files;
		const overlay = join(process.env.RLM_HOME ?? join(homedir(), ".rlm"), "cordis.patch.yml");
		return [
			...this.files,
			{
				abs: overlay,
				rel: overlay,
				spellings: ["cordis.patch.yml"],
				dirSpellings: [],
				inherent: true,
				watched: false,
				why:
					"This cell writes rlm's composition overlay and names the guard row. Disabling or removing rlm-guard " +
					"is not something the fleet does to itself — it is the row that keeps the delegation limiter from " +
					"being edited by the agents it limits. Editing the overlay for anything else is fine; do that in a " +
					"cell that does not mention this row.",
			},
		];
	}

	/** For a tool whose input is a path outright: no parsing to do. */
	private refuseWholePath(path: string): Refusal | null {
		const dir = underPathDir(path, this.pathDirs) ? pathDirFileIn(path, this.pathDirs) : null;
		const file =
			namedIn(path, this.files) ??
			(dir
				? {
						abs: dir.evidence,
						rel: dir.evidence,
						spellings: [dir.evidence],
						dirSpellings: [dir.dir.abs],
						why: dir.dir.why,
						inherent: true as const,
						watched: false,
						pathDir: true as const,
					}
				: null);
		if (!file) return null;
		return {
			block: true,
			how: "direct",
			file,
			evidence: path,
			reason:
				`Refused by rlm-guard: ${file.rel} is protected and this tool would write it.\n\n${file.why}\n\n` +
				`Read it freely. Changing it is Abhi's call — raise it with him, or open a task saying what it should ` +
				`be and what you measured.`,
		};
	}

	/* ───────────────────────────── layer 2 ───────────────────────────── */

	private startWatching() {
		(this.ctx as { effect: (fn: () => () => void) => void }).effect(() => {
			this.baselines = this.files.filter((f) => f.watched).map((file) => readBaseline(this.root, file));
			this.stopWatching = watchProtected({
				root: this.root,
				baselines: this.baselines,
				debounceMs: this.config.debounceMs ?? 400,
				authorised: () => this.unlockState().open,
				onIncident: (incident) => {
					this.incidents.push(incident);
					if (this.incidents.length > 200) this.incidents.shift();
					const loud = incident.action !== "accepted-under-unlock";
					this.say(
						loud ? "warn" : "info",
						loud
							? `rlm-guard: ${incident.rel} was changed without an unlock and has been put back — ${incident.detail}`
							: `rlm-guard: ${incident.rel} — ${incident.detail}`,
					);
				},
			});
			return () => {
				this.stopWatching?.();
				this.stopWatching = null;
			};
		});
	}

	/**
	 * The PATH-directory backstop.
	 *
	 * Separate from `startWatching` because it snapshots directories rather than
	 * files, and because it is honest about a case the file backstop never has:
	 * an entry that did not exist at boot. See `pathdir.ts` — a new arrival is
	 * reported loudly and left alone, because `brew install` creates files in
	 * exactly these directories and a guard that deletes new arrivals eventually
	 * deletes somebody's real software.
	 */
	private startWatchingPathDirs() {
		(this.ctx as { effect: (fn: () => () => void) => void }).effect(() => {
			const started = Date.now();
			this.pathBaselines = this.pathDirs
				.filter((dir) => dir.watched)
				.map((dir) => readDirBaseline(dir, this.snapshotMaxBytes));
			const entries = this.pathBaselines.reduce((n, b) => n + b.entries.size, 0);
			this.say("info", `rlm-guard: snapshotted ${entries} PATH entr(ies) in ${Date.now() - started}ms`);
			this.stopWatchingPath = watchPathDirs({
				baselines: this.pathBaselines,
				debounceMs: this.config.debounceMs ?? 400,
				maxBytes: this.snapshotMaxBytes,
				authorised: () => this.unlockState().open,
				onIncident: (incident) => this.notePathIncident(incident),
			});
			return () => {
				this.stopWatchingPath?.();
				this.stopWatchingPath = null;
			};
		});
	}

	private notePathIncident(incident: PathIncident) {
		this.incidents.push({ at: incident.at, rel: incident.rel, action: incident.action, detail: incident.detail });
		if (this.incidents.length > 200) this.incidents.shift();
		const quiet = incident.action === "path-entry-accepted-under-unlock";
		this.say(
			quiet ? "info" : "warn",
			quiet
				? `rlm-guard: ${incident.rel} — ${incident.detail}`
				: `rlm-guard: ${incident.rel} — ${incident.detail}`,
		);
	}

	/* ───────────────────────────── surface ───────────────────────────── */

	unlockState(): UnlockState {
		return unlockState(this.unlockFile, this.maxMinutes);
	}

	/** Open the protected files for a bounded window. Refuses in a delegated child. */
	unlock(minutes = 15): UnlockState {
		const state = writeUnlock(this.unlockFile, minutes, this.maxMinutes);
		this.say("warn", `rlm-guard: unlocked — ${state.why}`);
		return state;
	}

	/** Close it again. */
	lock(): UnlockState {
		clearUnlock(this.unlockFile);
		this.say("info", "rlm-guard: locked");
		return this.unlockState();
	}

	report(): GuardReport {
		return {
			protecting: this.files.map((f) => f.rel),
			protectingDirs: this.pathDirs.map((d) => d.abs),
			unlock: this.unlockState(),
			child: isDelegateChild(),
			watching: this.stopWatching !== null,
			refusals: this.refusals,
			incidents: [...this.incidents],
		};
	}

	/** The state of the guard in the words a person would use. */
	explain(): string {
		const report = this.report();
		return [
			`rlm-guard: ${report.protecting.length} path(s) and ${report.protectingDirs.length} PATH director(ies) ` +
				`protected, ${report.refusals} refusal(s) this session`,
			`  ${report.unlock.open ? "UNLOCKED" : "locked"} — ${report.unlock.why}`,
			`  backstop ${report.watching ? "watching" : "not watching"}${report.child ? " (delegated child: door only)" : ""}`,
			...report.protecting.map((p) => `  · ${p}`),
			...report.protectingDirs.map((p) => `  · ${p}/** (prefix)`),
			...report.incidents.slice(-5).map((i) => `  ! ${i.rel}: ${i.action} — ${i.detail}`),
		].join("\n");
	}

	async [Symbol.dispose]() {
		const registry = factoryRegistry();
		const i = registry.findIndex((e) => e.id === PLUGIN_ID);
		if (i >= 0) registry.splice(i, 1);
		this.stopWatching?.();
		this.stopWatching = null;
		this.stopWatchingPath?.();
		this.stopWatchingPath = null;
	}
}

export default RlmGuardService;
export { RlmGuardService as RlmGuard };

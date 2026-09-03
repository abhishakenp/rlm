/**
 * @rlm/headless — the row that says nobody is watching.
 *
 * A `--print` child lives about fifteen seconds, answers one question, and
 * dies. It still boots the whole composition, and a good part of that
 * composition exists for a person sitting at a terminal: a module watcher so a
 * source edit lands without a restart, a renderer so there is something to look
 * at. Neither is worth anything to a process that will be gone before the first
 * edit could be typed, and both are paid for on the way up, by every child, in
 * the resources that decide how many children may run at once.
 *
 * Measured on this machine, one live process, `packages/` as the watch root:
 *
 *   - `hmr` holds **1,207 open file descriptors** — one read handle per file
 *     under `packages/`, including every `README.md`, `CHANGELOG.md`, `.png`
 *     and `.pyc`. Chokidar reaches for `fsevents` on macOS and falls back to a
 *     per-file `fs.watch` when it cannot resolve it, which is the case in this
 *     repo. All 1,207 are stat'd and opened before the first token is asked
 *     for.
 *   - The reload rows and the renderer together cost about **11 MB** resident
 *     that nothing in a one-shot run ever reads.
 *
 * ## What this row actually is
 *
 * Not a switch that turns things off. A **fact**, published as a service, plus
 * one token other rows depend on:
 *
 *   - **`rlmHeadless`** is always provided, and answers `on`. A row that would
 *     rather do less than disappear asks it — `rlm-gitpixel` does exactly that,
 *     and skips the repository re-index it otherwise runs at every
 *     `session_start`.
 *   - **`rlmLive`** is provided **only when a person is there**. It carries
 *     nothing. It is the live half of the same fact, in the form a fiber can
 *     depend on, and it is what makes the verdict *movable* — provide it and
 *     the expensive rows come up, take it away and they go down.
 *
 * ## How rows are actually left out, and why `inject` is no longer it
 *
 * The first version of this row parked the expensive rows by naming `rlmLive`
 * in each of their `inject` lists. That mechanism was race-free and it was
 * wrong, for a reason nothing about the race touches: **it made the
 * composition unreducible.** Delete this row from `cordis.yml` and nothing
 * provides `rlmLive` at all, so every row that named it waits for ever. The
 * observed result, booting a composition with the `headless` entry removed:
 * `hmr`, `rlm-hmr`, `tui` and `renderer` all PENDING, 26 open descriptors, no
 * watcher and no renderer — an rlm with hot reload silently off, in a
 * composition that never mentions headlessness. Removing the policy row turned
 * the policy all the way up instead of off. Absence of this row has to mean
 * absence of an opinion.
 *
 * So the rows ask, rather than being told:
 *
 *   - `rlm-hmr` and the `hmr` wrapper call `whenWatched()` from
 *     `packages/rlm-hmr/src/live.ts`, which reads `ctx.get("rlmHeadless")`.
 *     No row → `undefined` → no opinion → watch, the way rlm always did.
 *   - `tui` and `renderer` need no gate at all. Measured: `tui`'s whole mount
 *     is one `globalThis` assignment, and `renderer`'s `[Service.init]` only
 *     subscribes to events — everything expensive is behind `start()`, which
 *     only the `interactive` mode calls, and `--headless` implies `--print`.
 *     They carried `inject: ['rlmLive']` for tidiness, and it bought nothing.
 *
 * **The race, answered rather than avoided.** The paragraph this replaces was
 * right that a naive `ctx.get` in `apply` cannot be trusted: rows mount
 * concurrently in one `Promise.allSettled`, and cordis will not hand out a
 * service whose fiber is still LOADING, so a row can be told "no opinion"
 * merely because this row has not finished starting — and for `hmr` that
 * answer costs ~1,283 file watches that then have to be closed again. The
 * answer is not to ask sooner but to ask *later, before committing anything*:
 * `whenWatched` does its probe inside `ctx.inject({ loader: { await: true } },
 * …)`, a child fiber that cannot run until the loader tree has settled, while
 * the row it belongs to stays ACTIVE. By then every row has reached ACTIVE or
 * failed. Nothing is opened and then closed; it is still not opened.
 *
 * `hmr` is a package, not a file in this repo, so it cannot be taught to ask.
 * It is wrapped by `./packages/rlm-hmr/src/official.ts`, a row that always
 * mounts, costs nothing, and mounts the real plugin as a child fiber only once
 * the verdict is known. That is strictly cheaper than the `inject` it
 * replaces, which still had to import the module to discover the plugin object
 * for a fiber that then parked for ever.
 *
 * ## Turning it off again
 *
 * The verdict is still live, and that property survived the change of
 * mechanism. `whenWatched` re-reads it on every `internal/service` for
 * `rlmHeadless` or `rlmLive`, so `set(false)` at any moment still brings hot
 * reload up inside a running rlm — the property this project exists to have,
 * and a poor thing to have spent on a startup flag. Removing this row from a
 * *running* composition moves the same way: `rlmHeadless` goes, the rows hear
 * it, and they come up, which is the one behaviour `inject` got backwards.
 */
import { Service } from "@deepseek-ai/cordis";

export const name = "rlm-headless";

/**
 * The decision, and what it cost.
 *
 * A parked row reports `PENDING` for ever, and a fiber stuck at PENDING is
 * exactly the shape of a boot that went wrong. The difference between "waiting
 * for a service that is coming" and "waiting for a service that was
 * deliberately withheld" is invisible in the fiber, so it is said out loud
 * here instead, and `explain()` is what says it.
 */
export interface HeadlessVerdict {
	on: boolean;
	/** Where the decision came from, in a sentence. */
	why: string;
	/** Rows that named the token and are therefore not running. */
	parked: string[];
	/**
	 * The one session being watched, if any.
	 *
	 * Not the same question as `on`. `on` is about the invocation — was
	 * `--headless` passed — and this is about attention, which moves at runtime
	 * and is what actually decides whether the live rows are mounted right now.
	 */
	watching: string | null;
}

export interface RlmHeadlessConfig {
	/**
	 * `auto` reads the command line and the environment; `on` and `off` decide
	 * regardless of either.
	 */
	force?: "auto" | "on" | "off";
	/** The flag that turns this on when `force` is `auto`. */
	flag?: string;
	/** The environment variable that turns this on when `force` is `auto`. */
	env?: string;
	/** The service parked rows inject. Withheld when headless. */
	token?: string;
	/**
	 * Node flags a one-shot child should be started with, space separated.
	 *
	 * Empty string means none.
	 */
	childFlags?: string;
	/**
	 * Tasks one pooled worker may hold at once. `0` or `1` means no pool.
	 *
	 * The delegate asks this row whether to pool its children, for the same
	 * reason it asks about their Node flags: what an unwatched child costs is a
	 * fact about unwatched children, and this is the row whose whole subject is
	 * that. Removing this row from the composition therefore removes the pool
	 * too, and rlm spawns one process per task exactly as it always did.
	 */
	childPoolSlots?: number;
}

/**
 * What this row accepts, as data.
 *
 * The same shape every other row in this repo exports, and for the same
 * reason: `rlm-compose` reads it to answer "what can I change about this?",
 * including for a row that is not currently running — which is exactly when
 * that question gets asked about this one.
 */
/**
 * What an unwatched one-shot child should be started with.
 *
 * Not a micro-optimisation, and not guesswork: measured on this machine by
 * spawning real children with the real argv and sampling the whole process
 * tree.
 *
 *   - **`--optimize-for-size`** tells V8 to prefer memory over speed — smaller
 *     inline caches, less code aging, GC that gives pages back instead of
 *     keeping them warm. Worth about **30 MB** on a child that boots ~1,500
 *     modules, for about 27 ms of extra boot.
 *   - **`--max-semi-space-size=2`** caps the young generation at 2 MB a
 *     semi-space. V8 sizes it from the machine, and on this one it reserved
 *     **32 MB** of new space to hold about 7 MB of live young objects. A child
 *     that allocates in short bursts between network waits scavenges a little
 *     more often and keeps the rest.
 *
 * Both are the same trade in different places: a `--print` child spends nearly
 * all of its wall clock blocked on a model, so CPU is the thing it has spare
 * and resident memory is the thing that decides how many of it may run at
 * once. Neither flag changes behaviour — they change how V8 spends, not what
 * it computes.
 *
 * They live here, in the row whose whole subject is "nobody is watching this
 * run", rather than in the spawner: what an unwatched child costs is a fact
 * about unwatched children, and the overlay can change it without an edit to
 * whichever row happens to be doing the spawning today.
 */
const DEFAULT_CHILD_FLAGS = "--max-semi-space-size=2 --optimize-for-size";

/**
 * How many tasks one pooled worker holds at once.
 *
 * The whole argument for a pool is in one measurement: a real delegated child
 * sampled every 700 ms reaches 143 MB at 1.4 s and is flat from there through
 * the model call. The boot is the cost and the task is not, so eight tasks in
 * one process cost about what one task in one process costs, and eight
 * processes cost eight times that for no reason.
 *
 * Eight rather than "all of them" because a worker is also the unit of blast
 * radius: the `code` tool is a vm with `require` in scope, so a task can take
 * its worker down, and everything sharing that worker is re-queued when it
 * does. Eight is the number where the fixed cost is amortised and a bad task
 * costs one boot, not the fleet.
 */
const DEFAULT_POOL_SLOTS = 8;

export const configFields = [
	{
		key: "force",
		type: "string",
		default: "auto",
		description:
			"Whether to decide per invocation or always the same way. 'auto' looks at the command line and the environment, which is normally what you want; 'on' keeps the watcher and the renderer out of every run; 'off' keeps them in even for a one-shot answer.",
	},
	{
		key: "flag",
		type: "string",
		default: "--headless",
		description: "The word on the command line that means nobody is watching this run.",
	},
	{
		key: "env",
		type: "string",
		default: "RLM_HEADLESS",
		description:
			"An environment variable meaning the same thing, for callers that cannot add a word to the command line. Any value other than empty, '0', 'false', 'no' or 'off' counts as yes.",
	},
	{
		key: "childFlags",
		type: "string",
		default: DEFAULT_CHILD_FLAGS,
		description:
			"Node flags to start an unwatched one-shot child with, space separated. These are the ones that trade a little speed for a lot of resident memory, which is the right trade for a process that spends almost all of its life waiting on a model. Empty to pass none.",
	},
	{
		key: "childPoolSlots",
		type: "number",
		default: DEFAULT_POOL_SLOTS,
		description:
			"How many delegated tasks one long-lived worker process holds at once. A delegated child used to be one process per task, ~110-125 MB each, and the memory went almost entirely on booting the composition so the process was ready to do a task — measured flat from 1.4 s onward, right through the model call. Pooling pays that boot once for the fleet instead of once per task. 0 or 1 turns the pool off and every task gets its own process again.",
	},
	{
		key: "token",
		type: "string",
		default: "rlmLive",
		description:
			"The name a row asks for when it only makes sense with a person watching. It is handed out when somebody is and withheld when nobody is, and that is the whole of how a row gets left out of a one-shot run. Change it only alongside every row in the setup that names it, or those rows will sit waiting for something nobody provides.",
	},
];

/** Values of the environment variable that mean "no". */
const DENIALS = new Set(["", "0", "false", "no", "off"]);

/** The token's default name, in one place because three methods need it. */
const DEFAULT_TOKEN = "rlmLive";


/**
 * `FiberState.ACTIVE`, as a number.
 *
 * `FiberState` is a `const enum` in cordis — type-only, erased at runtime, and
 * importing it throws at load — so the number is the contract. `rlm-compose`
 * carries the same list for the same reason.
 *
 * It has to be the state and not the existence of the fiber. A parked row
 * *has* a fiber: `registry.plugin()` creates one, gives it a `uid`, and leaves
 * it at PENDING until its injected services turn up. Testing `fiber?.uid` —
 * which is the obvious thing to write, and was written here first — reports
 * every parked row as running, so the summary line said "nothing was left out"
 * while four rows sat waiting.
 */
const ACTIVE = 2;

/**
 * Is this invocation unwatched?
 *
 * A free function rather than a method so it can be tested without a kernel,
 * and so anything that has to answer the question before the composition
 * exists reads it from one place rather than re-spelling it.
 */
export const detect = (
	argv: string[],
	env: Record<string, string | undefined>,
	config: RlmHeadlessConfig = {},
): HeadlessVerdict => {
	const flag = config.flag ?? "--headless";
	const variable = config.env ?? "RLM_HEADLESS";
	if (config.force === "on") return { on: true, why: "the headless row is configured on", parked: [], watching: null };
	if (config.force === "off") return { on: false, why: "the headless row is configured off", parked: [], watching: null };
	// `--headless=1` as well as a bare `--headless`. Half the callers that pass
	// flags programmatically spell it with the equals sign, and a flag that is
	// silently ignored is worse than one that does not exist — which is the
	// state `--headless` was already in when this row was written.
	if (argv.some((a) => a === flag || a.startsWith(`${flag}=`))) {
		return { on: true, why: `${flag} was passed`, parked: [], watching: null };
	}
	const value = env[variable];
	if (value !== undefined && !DENIALS.has(value.trim().toLowerCase())) {
		return { on: true, why: `${variable}=${value}`, parked: [], watching: null };
	}
	return { on: false, why: "no flag and no environment variable — somebody is watching", parked: [], watching: null };
};

/**
 * Does this entry's `inject` name the token?
 *
 * Cordis accepts three spellings — an array, `{ required, optional }`, and a
 * bare string — and a row parked through any of them is parked, so all three
 * are read rather than only the one this repo happens to write.
 */
export const injectsToken = (inject: unknown, token: string): boolean => {
	if (!inject) return false;
	if (typeof inject === "string") return inject === token;
	if (Array.isArray(inject)) return inject.includes(token);
	if (typeof inject === "object") {
		const shape = inject as { required?: unknown; optional?: unknown };
		return injectsToken(shape.required, token) || injectsToken(shape.optional, token);
	}
	return false;
};

export class RlmHeadlessService extends Service {
	static inject = [] as const;
	static provide = "rlmHeadless" as const;

	declare config: RlmHeadlessConfig;

	private verdict: HeadlessVerdict = { on: false, why: "not decided yet", parked: [], watching: null };

	/** Releases the token, when it is currently handed out. */
	private release?: () => void;

	/**
	 * The one session being watched right now, or nothing.
	 *
	 * His question, and it is the whole reason this is not a boolean any more:
	 * *"when i open 1 delegator agent, the other 900 subagents are still
	 * headless, and when i open one of the subagents, all other 900-1 subagents
	 * and the main delegator agents are headless?"*
	 *
	 * So: a viewport, not a switch. One session at a time is watched — there is
	 * one of him — and opening a different one moves it. A process that holds
	 * the watched session hands out `rlmLive`; every other process in the fleet,
	 * and this one the moment attention moves away, does not.
	 */
	private attention: string | null = null;

	/**
	 * Rows that have told this one they left their expensive part out.
	 *
	 * The decision that mattered when this row was written: **a parked row
	 * reports PENDING for ever, and a fiber stuck at PENDING is exactly the
	 * shape of a boot that went wrong.** "Waiting for a service that is coming"
	 * and "waiting for a service that was deliberately withheld" are the same
	 * fiber, so the difference had to be said out loud, and `explain()` said it
	 * by reading `inject` off the loader.
	 *
	 * Under the current mechanism the rows are ACTIVE — it is a part of their
	 * work that is skipped, not the row — so reading the loader cannot see it at
	 * all. Losing the distinction would be the real regression, so the rows say
	 * so themselves: `whenWatched()` calls `deferred()` when it skips and
	 * `resumed()` when it takes the work up again. Better evidence than the old
	 * inference, in fact, because it is the row reporting what it actually did
	 * rather than this one guessing from a fiber state that has three other
	 * causes.
	 */
	private standDown = new Set<string>();

	constructor(ctx: any, config: RlmHeadlessConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		this.decide();
	}

	/** Whether this run is unwatched. */
	get on(): boolean {
		return this.verdict.on;
	}

	/**
	 * Whether the expensive rows should be up.
	 *
	 * **Read this, not `on`.** They are not each other's negation: a headless
	 * process that is attending one of its sessions is live, because somebody
	 * has opened that agent. `on` answers "was this invocation unwatched",
	 * which is only half the question once one process holds many agents.
	 * `apply()` decides the token from exactly this, and `whenWatched()` reads
	 * exactly this, so the token and the probe can never disagree.
	 */
	get live(): boolean {
		return !this.verdict.on || this.attention !== null;
	}

	/** The name rows inject to say they need a person. */
	get token(): string {
		return this.config.token ?? DEFAULT_TOKEN;
	}

	/**
	 * The Node flags a one-shot child should be started with.
	 *
	 * Deliberately **not** gated on `this.on`. Whether *this* process is watched
	 * says nothing about the children it spawns: an interactive rlm delegating a
	 * sweep spawns children that are every bit as unwatched as a headless one
	 * does, and they should cost the same. The caller decides it is starting an
	 * unwatched child; this answers what that costs.
	 *
	 * Read by `rlm-delegate` through `ctx.get("rlmHeadless")` rather than
	 * `inject`, so a composition without this row simply spawns children the way
	 * it always did instead of never spawning one again.
	 */
	childNodeFlags(): string[] {
		const raw = this.config.childFlags ?? DEFAULT_CHILD_FLAGS;
		return raw.split(/\s+/).filter(Boolean);
	}

	/** The decision, with its reasoning and its consequences attached. */
	report(): HeadlessVerdict {
		return { ...this.verdict, parked: this.parked(), watching: this.attention };
	}

	/**
	 * The Node worker pool's width, or 0 for "do not pool".
	 *
	 * Deliberately **not** gated on `this.on`, for the same reason
	 * `childNodeFlags()` is not: whether *this* process is watched says nothing
	 * about the children it spawns. The drive runs as `rlm drive` with no
	 * `--headless` on its command line — it is a mode, not a print — and every
	 * child it spawns is `--headless` regardless. Gating here would mean the one
	 * process in the fleet that actually spawns children never pools any of them.
	 */
	childPoolSlots(): number {
		const raw = this.config.childPoolSlots;
		const slots = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_POOL_SLOTS;
		return slots > 1 ? slots : 0;
	}

	/**
	 * Decide again, from the command line and the environment.
	 *
	 * Called at init, and available afterwards because the environment a row
	 * booted in is not necessarily the one it is still in — and because a row
	 * that can only be right once is a row that needs restarting to be right
	 * twice.
	 */
	decide(argv: string[] = process.argv.slice(2), env = process.env): HeadlessVerdict {
		this.verdict = detect(argv, env as Record<string, string | undefined>, this.config);
		this.apply();
		return this.report();
	}

	/** Decide by hand, without touching the command line. */
	set(on: boolean, why = on ? "switched on" : "switched off"): HeadlessVerdict {
		this.verdict = { on, why, parked: [], watching: null };
		this.apply();
		return this.report();
	}

	/**
	 * Watch one session in this process, or none.
	 *
	 * This is the per-agent half of headless, and it is a *fact about a
	 * session*, not about a process — which it had to become the moment one
	 * process started holding eight agents. The caller names the session it is
	 * opening; `null` closes the viewport.
	 *
	 * It is authoritative rather than advisory: `apply()` reads it, so attending
	 * a session in a headless process hands out `rlmLive` and the parked rows
	 * mount, and letting go takes them away again. No restart, no flag, no
	 * second mechanism — the same token, the same rows, decided by attention
	 * instead of by the command line.
	 *
	 * **What is single, honestly.** The rows that come up are the ones that
	 * exist for a person: `hmr`, `tui`, `renderer`. Each of those is singular by
	 * nature — one module watcher, one terminal, one keyboard, one stdout — so
	 * this can hand out the token for exactly one session at a time and no more.
	 * That is not a limitation being worked around; it is the shape of there
	 * being one of him. A second concurrent viewer would need those rows to
	 * become per-session first, and they are not.
	 */
	attend(sessionId: string | null): HeadlessVerdict {
		const previous = this.attention;
		this.attention = sessionId ?? null;
		if (previous !== this.attention) {
			this.apply();
			this.ctx.emit?.("rlm/attention", { watching: this.attention, previous });
		}
		return this.report();
	}

	/** The session being watched here, or nothing. */
	watching(): string | null {
		return this.attention;
	}

	/** Is this particular session the one being watched? */
	watches(sessionId: string): boolean {
		return this.attention !== null && this.attention === sessionId;
	}

	/**
	 * A row saying it has left its expensive part out because of this verdict.
	 *
	 * Called by `whenWatched()`, and by anything else that would rather do less
	 * than disappear. Idempotent, and safe to call on a row this one has never
	 * heard of — the report is a record of what happened, not a permission
	 * system.
	 */
	deferred(row: string): void {
		this.standDown.add(row);
	}

	/** …and the same row saying it has taken that work up again. */
	resumed(row: string): void {
		this.standDown.delete(row);
	}

	/**
	 * Hand out the token, or withhold it.
	 *
	 * **Two arguments, never three.** `ctx.provide(name, value, check)` takes an
	 * availability *predicate* as its third parameter, not a "make this global"
	 * flag, and `Fiber#_checkImpl` calls it as `impl.check.call(...)` for every
	 * dependent. Pass a non-function and that call throws, the throw is caught
	 * and logged rather than raised, and the dependent's store entry is deleted
	 * — so the service exists, `ctx.get()` returns it, and every row that
	 * injects it sits at PENDING for ever anyway.
	 *
	 * This cost an hour on the first build of this row, and it is worth naming
	 * because the mistake is already in the repository: `rlm-boot` provides
	 * `rlmHost` with a third argument of `true`, which is why nothing injects
	 * `rlmHost` and `rlm-compose` probes for it with `ctx.get` instead. That
	 * one is harmless only because no row depends on it. This one would have
	 * been hot reload silently dead in interactive mode — the exact failure
	 * this row exists to stop paying for, inverted.
	 *
	 * **Withholding means not calling it, not calling it with `undefined`.**
	 * Readiness in Cordis is "does an implementation exist", not "is its value
	 * truthy": `provide(token, undefined)` still registers an `Impl`, and
	 * `_checkImpl` finds it, so every parked row wakes up and mounts. Measured
	 * that way round first — `rlmLive: false` in the report and all four rows
	 * ACTIVE underneath it, which is the worst kind of wrong, because the
	 * summary line agreed with the intention. So the token is handed out by
	 * calling `provide` and taken back by calling the disposer it returned.
	 *
	 * `provide` registers through `ctx.fiber.effect`, so the token is released
	 * by this row's own disposal too. That is the correct lifetime: when the
	 * headless row goes away, nothing is asserting anything about who is
	 * watching, and the rows that were waiting on an assertion stop waiting.
	 */
	private apply() {
		// Two ways to be live, and the second is the one that moves. Either
		// nobody said this run was unwatched, or somebody has opened one of the
		// agents running in it. Attention wins over the flag, which is what makes
		// "open a subagent" mean something inside a headless worker.
		const live = this.live;
		if (live && !this.release) this.release = this.ctx.provide?.(this.token, { since: Date.now() });
		else if (!live && this.release) {
			this.release();
			this.release = undefined;
		}
		this.ctx.logger?.info?.(this.explain().split("\n").join(" — "));
	}

	/**
	 * What is not running because of this verdict, from both directions.
	 *
	 * **What the rows said.** `whenWatched()` reports itself through
	 * `deferred()`, which is the mechanism in force for `hmr` and `rlm-hmr`.
	 * These rows are ACTIVE; it is the watcher inside them that is not, and no
	 * amount of looking at fiber states would show it.
	 *
	 * **What the composition says.** The loader is still read for rows carrying
	 * `inject: [token]`, because nothing stops an overlay or a future row from
	 * using that spelling, and a row parked that way is genuinely not running.
	 * Stock `cordis.yml` no longer has any — this branch finds nothing here, and
	 * that is the point of the change rather than dead code: the report has to
	 * keep telling the truth for a composition that is not this one.
	 *
	 * A row counts as parked from the loader when it injects the token and is
	 * not ACTIVE, whether this row parked it or it was never going to load
	 * anyway. Both are rows the composition asked for and did not get.
	 */
	parked(): string[] {
		if (this.live) return [];
		const out = new Set<string>(this.standDown);
		try {
			for (const entry of (this.ctx as any).loader?.entries?.() ?? []) {
				const options = entry?.options ?? {};
				if (!options.name || options.disabled) continue;
				if (!injectsToken(options.inject, this.token)) continue;
				if (entry?.fiber?.state === ACTIVE) continue;
				out.add(options.id ?? options.name);
			}
		} catch {
			/* no loader, or a shape this does not know — an empty list is honest */
		}
		return [...out];
	}

	/** The decision and what it cost, in the words a person would use. */
	explain(): string {
		const report = this.report();
		const watched = report.watching ? ` — watching ${report.watching}` : "";
		if (!report.on) return `headless off — ${report.why}${watched}`;
		if (report.watching) {
			return `headless on — ${report.why} — but ${report.watching} is open, so the live rows are up for it`;
		}
		return [
			`headless on — ${report.why}`,
			report.parked.length
				? `  not started: ${report.parked.join(", ")}`
				: "  nothing was left out — no row in this composition asked to be",
		].join("\n");
	}
}

export default RlmHeadlessService;

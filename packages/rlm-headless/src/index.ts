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
 *     nothing. Its entire purpose is to be named in another row's `inject`, so
 *     that row cannot start while it is absent.
 *
 * `inject` is why this is a row and not a branch in an argument parser, and it
 * is the only mechanism available here that is race-free. The loader creates
 * every entry in one `Promise.allSettled`, so rows mount concurrently and
 * position in `cordis.yml` buys nothing: a row that reached in and disabled
 * `hmr` would always be reaching for a watcher that had already opened its
 * 1,207 handles. A row whose injected service never arrives never starts at
 * all. Nothing is opened and then closed; it is not opened.
 *
 * The consequence is that the park list lives in `cordis.yml`, as an `inject`
 * on each parked row, and not in this file's config. That is the right place
 * for it. "This row exists for a human" is a fact about the composition, it
 * shows up in `rlm rows` beside everything else, and the overlay can add a row
 * to the set or take one out of it without touching any code.
 *
 * ## Turning it off again
 *
 * `rlmLive` is a normal service on a normal fiber. Provide it and the parked
 * rows mount; take it away and they dispose. So headless is not a property of
 * the process that has to be settled before boot — `set(false)` at any moment
 * brings hot reload up inside a running rlm, which is the property this project
 * exists to have and would have been a poor thing to spend on a startup flag.
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
	if (config.force === "on") return { on: true, why: "the headless row is configured on", parked: [] };
	if (config.force === "off") return { on: false, why: "the headless row is configured off", parked: [] };
	// `--headless=1` as well as a bare `--headless`. Half the callers that pass
	// flags programmatically spell it with the equals sign, and a flag that is
	// silently ignored is worse than one that does not exist — which is the
	// state `--headless` was already in when this row was written.
	if (argv.some((a) => a === flag || a.startsWith(`${flag}=`))) {
		return { on: true, why: `${flag} was passed`, parked: [] };
	}
	const value = env[variable];
	if (value !== undefined && !DENIALS.has(value.trim().toLowerCase())) {
		return { on: true, why: `${variable}=${value}`, parked: [] };
	}
	return { on: false, why: "no flag and no environment variable — somebody is watching", parked: [] };
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

	private verdict: HeadlessVerdict = { on: false, why: "not decided yet", parked: [] };

	/** Releases the token, when it is currently handed out. */
	private release?: () => void;

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
		return { ...this.verdict, parked: this.parked() };
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
		this.verdict = { on, why, parked: [] };
		this.apply();
		return this.report();
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
		const live = !this.verdict.on;
		if (live && !this.release) this.release = this.ctx.provide?.(this.token, { since: Date.now() });
		else if (!live && this.release) {
			this.release();
			this.release = undefined;
		}
		this.ctx.logger?.info?.(this.explain().split("\n").join(" — "));
	}

	/**
	 * The rows that named the token and are therefore not running.
	 *
	 * Read off the loader rather than kept in a list here, so it cannot drift
	 * from what the composition actually says. A row counts as parked when it
	 * injects the token and is not ACTIVE — the same test whether this row
	 * parked it or it was never going to load anyway, which is honest: both are
	 * rows the composition asked for and did not get.
	 */
	parked(): string[] {
		if (!this.verdict.on) return [];
		const out: string[] = [];
		try {
			for (const entry of (this.ctx as any).loader?.entries?.() ?? []) {
				const options = entry?.options ?? {};
				if (!options.name || options.disabled) continue;
				if (!injectsToken(options.inject, this.token)) continue;
				if (entry?.fiber?.state === ACTIVE) continue;
				out.push(options.id ?? options.name);
			}
		} catch {
			/* no loader, or a shape this does not know — an empty list is honest */
		}
		return out;
	}

	/** The decision and what it cost, in the words a person would use. */
	explain(): string {
		const report = this.report();
		if (!report.on) return `headless off — ${report.why}`;
		return [
			`headless on — ${report.why}`,
			report.parked.length
				? `  not started: ${report.parked.join(", ")}`
				: `  nothing was left out — no row in this composition injects ${this.token}`,
		].join("\n");
	}
}

export default RlmHeadlessService;

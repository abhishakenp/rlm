/**
 * @rlm/self — the seam between rlm's own wiring and the model running inside it.
 *
 * `rlm-compose` and `rlm-plugins` are the capability: they can read the
 * composition, write the overlay, and scaffold a package. This row is what
 * makes them reachable from where the thinking happens — a code cell.
 *
 * It is a separate row on purpose. The capability and the surface it is
 * offered through are different concerns, and keeping them apart means the
 * surface can be replaced (a slash command, an MCP tool, a socket) without
 * touching the thing being surfaced, and the capability keeps working for
 * anything in-process even with no surface mounted at all.
 *
 * ## Why `globalThis`, of all things
 *
 * The code tool's sandbox is a `vm.createContext`, built by upstream code that
 * knows nothing about Cordis. It already reaches two rows this way —
 * `__rlmTui` and `__rlmPrompt` — and the sandbox's `self` binding is one line
 * beside them. Every other route would mean threading a service through the
 * 12,000-line agent session that constructs the sandbox. This is a wire, and
 * the narrow one is the right one.
 *
 * The binding is an effect, so unloading this row takes `self` away with it,
 * and a reload replaces it rather than stacking a second copy.
 *
 * ## Why `call` rather than handing over the service
 *
 * A cell could be given the live service object directly. `call(name, method)`
 * is used instead because it is the one place every self-directed invocation
 * passes through: it resolves the service *at call time* (so a row that hot
 * reloaded between two cells is not stale), it fails with a list of what does
 * exist rather than `undefined is not a function`, and it is where a log line
 * or a gate goes if one is ever wanted.
 */
import { Service } from "@deepseek-ai/cordis";

export const name = "rlm-self";

export interface RlmSelfConfig {
	/** The global the code sandbox reads. Changing it needs the sandbox changed to match. */
	globalKey?: string;
	/** Contribute the "you can reconfigure yourself" section to the system prompt. */
	promptSection?: boolean;
	/** Where that section sorts among the others. */
	promptPriority?: number;
}

export const configFields = [
	{ key: "globalKey", type: "string", default: "__rlmSelf", description: "The name the code sandbox looks this up under. Changing it needs the sandbox changed to match." },
	{ key: "promptSection", type: "boolean", default: true, description: "Tell rlm in its own prompt how it is built and that it can change it." },
	{ key: "promptPriority", type: "number", default: 320, description: "Where that sits in the assembled system prompt." },
];

export class RlmSelfService extends Service {
	static inject = [] as const;
	static provide = "rlmSelf" as const;

	declare config: RlmSelfConfig;

	private detachPrompt: (() => void) | undefined;

	constructor(ctx: any, config: RlmSelfConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		const key = this.config.globalKey ?? "__rlmSelf";
		this.ctx.effect(() => {
			const previous = (globalThis as any)[key];
			(globalThis as any)[key] = this.surface();
			return () => {
				// Only take it away if it is still ours. During a hot reload the
				// successor is constructed before this disposer runs, so blindly
				// deleting would remove the *new* binding and leave `self`
				// undefined for the rest of the process.
				if ((globalThis as any)[key] === this.current) (globalThis as any)[key] = previous;
			};
		}, "rlm-self global binding");
		this.followPrompt();
		this.ctx.logger?.info?.(`rlm-self: ready (globalThis.${key})`);
	}

	private current: any;

	// ── the surface ──────────────────────────────────────────────────────────

	private surface() {
		const ctx = this.ctx;
		const need = (service: string) => {
			const found = ctx.get?.(service);
			if (!found) throw new Error(`the ${service} row is not mounted`);
			return found;
		};

		const surface = {
			/** Every row rlm is composed of, and whether each one is running. */
			rows: () => need("rlmCompose").rows(),
			/** One row, with the parameters it documents — even when it is off. */
			describe: (id: string) => need("rlmCompose").describe(id),
			/** Every live service key on the context, which is what `call` can reach. */
			services: () => this.services(),
			/** Call a method on a live service by name. */
			call: (service: string, method: string, ...args: unknown[]) => this.call(service, method, ...args),
			/** Where this rlm keeps itself. */
			host: () => {
				const host = ctx.get?.("rlmHost");
				return host && { root: host.root, home: host.home, composition: host.composition, overlay: host.overlay };
			},

			config: {
				set: (id: string, key: string, value: unknown) => need("rlmCompose").set(id, { [key]: value }),
				enable: (id: string) => need("rlmCompose").setEnabled(id, true),
				disable: (id: string) => need("rlmCompose").setEnabled(id, false),
				reset: (id: string) => need("rlmCompose").reset(id),
			},

			plugin: {
				list: () => need("rlmPlugins").list(),
				doctor: () => need("rlmPlugins").doctor(),
				new: (name: string, description: string) => need("rlmPlugins").create(name, description),
				mount: (name: string, id?: string, config?: Record<string, unknown>) =>
					need("rlmPlugins").mount(name, id, config),
				unmount: (name: string) => need("rlmPlugins").unmount(name),
				adopt: (name: string, why: string) => need("rlmPlugins").adopt(name, why),
				remove: (name: string) => need("rlmPlugins").remove(name),
				sweep: (options?: { apply?: boolean }) => need("rlmPlugins").sweep(options),
			},
		};
		this.current = surface;
		return surface;
	}

	/**
	 * Every service name currently reachable.
	 *
	 * Read off `ctx.reflect.store` because cordis has no public enumeration, and
	 * the alternative — a hardcoded list — would be wrong the moment rlm mounts
	 * something new, which is the entire point of this row. The store is keyed by
	 * isolate symbol, so the readable name comes off each implementation record
	 * rather than the key. Best effort by design: a shape change here should cost
	 * the listing, not the calling.
	 */
	private services(): string[] {
		const found = new Set<string>();
		try {
			const store = (this.ctx as any).reflect?.store ?? {};
			for (const key of Reflect.ownKeys(store)) {
				const impl = (store as any)[key];
				if (typeof impl?.name === "string") found.add(impl.name);
			}
		} catch {
			/* an unreadable store costs the listing, not the calling */
		}
		return [...found].filter((key) => this.ctx.get?.(key)).sort();
	}

	async call(service: string, method: string, ...args: unknown[]) {
		const target = this.ctx.get?.(service);
		if (!target) {
			throw new Error(`no service "${service}". Live services: ${this.services().join(", ") || "(none)"}`);
		}
		const fn = (target as any)[method];
		if (typeof fn !== "function") {
			const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(target)).filter(
				(m) => m !== "constructor" && typeof (target as any)[m] === "function",
			);
			throw new Error(`"${service}" has no method "${method}". It has: ${methods.join(", ") || "(none)"}`);
		}
		return await fn.apply(target, args);
	}

	// ── the prompt ───────────────────────────────────────────────────────────

	/**
	 * Probed rather than injected — there is no optional form of inject — and
	 * re-attached when the prompt row reappears, because a fragment registered
	 * once at init is silently gone the first time that row reloads.
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
		}, "rlm-self prompt section");
	}

	private contributePrompt() {
		if (this.config.promptSection === false) return;
		const prompt = this.ctx.get?.("rlmPrompt");
		if (!prompt?.registerFragment) return;
		this.detachPrompt?.();
		const handle = prompt.registerFragment("rlm-self", {
			id: "composition",
			priority: this.config.promptPriority ?? 320,
			content: () => this.promptText(),
		});
		this.detachPrompt = () => handle.dispose();
	}

	private promptText(): string {
		const lines = [
			"## How you are built",
			"",
			"You are a Cordis plugin tree. Every capability you have is a row in a",
			"configuration file, and every row can be reconfigured, switched off, or",
			"added while you are running. You do not restart to change yourself.",
			"",
			"From inside a code cell, `self` is your hands on your own wiring:",
			"",
			"  self.rows()                      // every row, and whether it is running",
			"  self.describe(id)                // one row and the parameters it accepts",
			"  self.services()                  // every live service you can call",
			'  await self.call(svc, m, ...args) // call a method on one of them',
			'  self.config.set(id, key, value)  // change a row. Takes effect at once',
			"  self.config.disable(id) / .enable(id) / .reset(id)",
			"  self.plugin.list() / .doctor() / .new() / .mount() / .unmount() / .adopt() / .remove()",
			"",
			"Your changes are written to an overlay file, never to the shipped",
			"configuration, so deleting the overlay returns you to stock. Read a row",
			"with `self.describe` before changing it: it reports the real parameters",
			"rather than what you might assume they are.",
		];
		try {
			const rows = this.ctx.get?.("rlmCompose")?.rows?.() ?? [];
			const on = rows.filter((r: any) => !r.disabled).map((r: any) => r.id);
			const off = rows.filter((r: any) => r.disabled).map((r: any) => r.id);
			lines.push("", `Currently on: ${on.join(", ") || "(none)"}`);
			if (off.length) lines.push(`Currently off: ${off.join(", ")}`);
		} catch {
			/* a listing that cannot be built is worth less than the instructions above */
		}
		return lines.join("\n");
	}
}

export default RlmSelfService;

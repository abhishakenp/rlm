/**
 * @rlm/modes — which face rlm shows for this invocation.
 *
 * Choosing between the interactive TUI and a one-shot print was the last piece
 * of application logic left in `cordis-shell.mjs`, and it was the piece that
 * made the shell impossible to finish reducing: every new surface rlm might
 * grow — a daemon, a socket, a queue drain — would have had to be another
 * branch in a file that cannot be changed without a restart.
 *
 * As a row it is data. A new surface is a row that registers a mode; changing
 * which mode a given invocation picks is a config edit; and the shell is left
 * with "boot, then ask what to do", which is the most it should ever know.
 */
import { Service } from "@deepseek-ai/cordis";

export const name = "rlm-modes";

export interface Mode {
	/** How this mode is named in logs and in `--mode`. */
	id: string;
	/** Higher wins when more than one mode claims the same invocation. */
	priority: number;
	/** Does this invocation belong to this mode? */
	claims(argv: string[]): boolean;
	/** Run it. Resolves with the process exit code. */
	run(argv: string[]): Promise<number>;
}

export interface RlmModesConfig {
	/** Force a mode by id, whatever the arguments say. */
	force?: string;
	/** Working directory handed to the mode that wins. */
	cwd?: string;
}

export const configFields = [
	{ key: "force", type: "string", description: "Always use this mode, whatever the command line says. Leave empty to decide per invocation." },
	{ key: "cwd", type: "string", description: "Working directory handed to whichever mode runs. Defaults to where rlm was started." },
];

export class RlmModesService extends Service {
	static inject = [] as const;
	static provide = "rlmModes" as const;

	declare config: RlmModesConfig;

	private readonly modes = new Map<string, Mode>();

	constructor(ctx: any, config: RlmModesConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		this.registerBuiltins();
		this.ctx.logger?.info?.("rlm-modes: ready");
	}

	/**
	 * Add a mode. The disposer is the caller's, so a row that registers a mode
	 * takes it away again when it unloads — which is what stops a hot reload
	 * from leaving two copies of the same surface claiming one invocation.
	 */
	register(mode: Mode): { dispose: () => void } {
		this.modes.set(mode.id, mode);
		return {
			dispose: () => {
				if (this.modes.get(mode.id) === mode) this.modes.delete(mode.id);
			},
		};
	}

	list(): { id: string; priority: number }[] {
		return [...this.modes.values()]
			.map((m) => ({ id: m.id, priority: m.priority }))
			.sort((a, b) => b.priority - a.priority);
	}

	/** Which mode this invocation belongs to. */
	choose(argv: string[] = process.argv.slice(2)): Mode | undefined {
		if (this.config.force) return this.modes.get(this.config.force);
		const flagged = argv.indexOf("--mode");
		if (flagged !== -1 && argv[flagged + 1]) return this.modes.get(argv[flagged + 1]);
		return [...this.modes.values()]
			.filter((m) => {
				try {
					return m.claims(argv);
				} catch {
					return false;
				}
			})
			.sort((a, b) => b.priority - a.priority)[0];
	}

	/** Choose and run. Resolves with the exit code the host should use. */
	async dispatch(argv: string[] = process.argv.slice(2)): Promise<number> {
		const mode = this.choose(argv);
		if (!mode) {
			throw new Error(`no mode claims this invocation. Known modes: ${this.list().map((m) => m.id).join(", ") || "(none)"}`);
		}
		this.ctx.logger?.info?.(`modes: ${mode.id}`);
		return await mode.run(argv);
	}

	// ── the two rlm has always had ───────────────────────────────────────────

	/**
	 * Registered here rather than in the print and renderer rows because those
	 * are upstream wrappers, and the point of this exercise is to stop adding
	 * to what has to be edited upstream. A row that wants its own surface calls
	 * `register` from its own init and owns the disposer.
	 */
	private registerBuiltins() {
		this.ctx.effect(() => {
			const disposers = [
				this.register({
					id: "print",
					priority: 20,
					// A prompt on the command line, or anything piped in. The piped
					// case is why this is not just a flag test: `echo hi | rlm` has
					// always worked and has to keep working.
					claims: (argv) => this.printPrompt(argv) !== null || !process.stdin.isTTY,
					run: async (argv) => {
						const service = this.ctx.get("rlmPrint");
						if (!service) throw new Error("the print row is not mounted");
						const prompt = this.printPrompt(argv) ?? (await readStdin());
						if (!prompt) {
							this.ctx.logger?.warn?.('modes: nothing to do — pass --print "..." or pipe something in');
							return 1;
						}
						return (await service.run({ mode: "text", initialMessage: prompt })) ?? 0;
					},
				}),
				this.register({
					id: "interactive",
					priority: 10,
					claims: () => true,
					run: async () => {
						const service = this.ctx.get("rlmRenderer");
						if (!service) throw new Error("the renderer row is not mounted");
						await service.start({ cwd: this.config.cwd ?? process.cwd() });
						return 0;
					},
				}),
			];
			return () => disposers.forEach((d) => d.dispose());
		}, "rlm-modes builtins");
	}

	private printPrompt(argv: string[]): string | null {
		const index = argv.indexOf("--print");
		if (index === -1) return null;
		return argv[index + 1] ?? null;
	}
}

function readStdin(): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data.trim()));
		process.stdin.resume();
	});
}

export default RlmModesService;

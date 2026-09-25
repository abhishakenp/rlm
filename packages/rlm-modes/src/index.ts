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
import { surface } from "../../rlm-host/src/surface.ts";

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

	/**
	 * The verb first, wherever the flags happen to sit.
	 *
	 * Every mode claims on `argv[0] === "<verb>"`, which is a rule about
	 * position and not about the verb, and it fails the moment anything is put
	 * in front of it. `scripts/drive-supervisor.sh` started passing
	 * `cordis-shell.mjs --headless drive` — a correct thing to want, since the
	 * drive was never being told it is headless — and from that moment
	 * `argv[0]` was `--headless`, no verb mode claimed the invocation, and
	 * `print` took it instead: `print` claims whenever stdin is not a TTY,
	 * which under launchd it never is. Print then found no prompt and returned
	 * 1 through a logger nothing was reading.
	 *
	 * So every sweep exited 1 in under a second, saying nothing at all, and the
	 * backlog stopped moving while the log looked like a supervisor doing its
	 * job. Measured: three consecutive `sweep ended rc=1` one second after
	 * `sweep starting`, with an empty stdout and an empty stderr.
	 *
	 * The flags are moved after the verb rather than dropped, because they are
	 * still meant for whoever reads them — `detect()` in @rlm/headless scans
	 * the whole line and does not care where the flag sits.
	 *
	 * `--print` and `--mode` are left alone: both own the token that follows
	 * them, so `rlm --print "tasks"` must stay a print of the word "tasks" and
	 * not become the tasks mode.
	 */
	private hoist(argv: string[]): string[] {
		if (!argv.length || !argv[0].startsWith("-")) return argv;
		if (argv.includes("--print") || argv.includes("--mode")) return argv;
		for (let i = 1; i < argv.length; i++) {
			const arg = argv[i];
			// Not a bare token, or a bare token that names no mode — a flag's
			// value, most likely. Either way it is not the verb.
			if (arg.startsWith("-") || !this.modes.has(arg)) continue;
			// The flags go to the *end*, not straight after the verb: a verb with
			// a sub-verb reads it as `argv[1]`, and `drive --headless status` would
			// leave `--headless` sitting where `status` has to be — which silently
			// turns a status query into a live sweep.
			return [arg, ...argv.slice(i + 1), ...argv.slice(0, i)];
		}
		return argv;
	}

	/** Which mode this invocation belongs to. */
	choose(argv: string[] = process.argv.slice(2)): Mode | undefined {
		if (this.config.force) return this.modes.get(this.config.force);
		const flagged = argv.indexOf("--mode");
		if (flagged !== -1 && argv[flagged + 1]) return this.modes.get(argv[flagged + 1]);
		const line = this.hoist(argv);
		return [...this.modes.values()]
			.filter((m) => {
				try {
					return m.claims(line);
				} catch {
					return false;
				}
			})
			.sort((a, b) => b.priority - a.priority)[0];
	}

	/** Choose and run. Resolves with the exit code the host should use. */
	async dispatch(argv: string[] = process.argv.slice(2)): Promise<number> {
		// The mode runs on the same line `choose` judged it by, or a verb with
		// a sub-verb — `drive status` — would lose the sub-verb to the flags.
		const line = this.hoist(argv);
		const mode = this.choose(argv);
		if (!mode) {
			throw new Error(`no mode claims this invocation. Known modes: ${this.list().map((m) => m.id).join(", ") || "(none)"}`);
		}
		this.ctx.logger?.info?.(`modes: ${mode.id}`);
		return await mode.run(line);
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
							// stderr and not only the logger. A non-zero exit that
							// explains itself nowhere is what let the whole fleet
							// stop for an hour a sweep while the supervisor's log
							// read "sweep starting / sweep ended rc=1" and nothing
							// else. Anything that exits non-zero has to say why on a
							// stream somebody is actually capturing.
							const known = this.list().map((m) => m.id).join(", ");
							process.stderr.write(
								`[rlm] nothing to do: no mode claimed this invocation, so it fell through to print, ` +
									`and there was no prompt to print.\n` +
									`[rlm] the command line was: ${argv.join(" ") || "(empty)"}\n` +
									`[rlm] modes that could have claimed it: ${known || "(none)"}\n`,
							);
							this.ctx.logger?.warn?.('modes: nothing to do — pass --print "..." or pipe something in');
							return 1;
						}

						// Write the request down before running it.
						//
						// This is the only moment that is guaranteed to happen. Six
						// jobs once arrived here as one string, one was done, and the
						// other five ended when this process did — with nothing on
						// disk saying they had ever been asked for. Telling the model
						// to keep a list does not fix that, because a model that
						// ignores the instruction loses the work exactly as before.
						// So the recording is four lines of code at the door, needs
						// no plan and no decomposition, and still happens when the
						// model is unavailable, confused or lying. `refine()` turns
						// it into real tasks afterwards; that part is allowed to fail.
						const graphs = this.ctx.get("rlmDelegate") as any;
						// Bare `-r` picks a session from the agents view; with no terminal there is
						// no view to pick from. prime-agent refuses it the same way.
						const { sessionManager, openAgentsView, sessionConfig, printOutputMode } = await this.sessionFromLine(argv);
						if (openAgentsView) {
							process.stderr.write("[rlm] --resume without a session selector requires an interactive terminal\n");
							return 1;
						}
						const recorded = graphs?.intake?.(prompt, { source: "--print", headless: true }) ?? null;

						try {
							const code = (await service.run({ mode: printOutputMode, initialMessage: prompt, sessionManager, sessionConfig })) ?? 0;
							recorded?.graph &&
								graphs.close(recorded.graph.id, recorded.taskId, {
									ok: code === 0,
									detail: `the run exited ${code}`,
								});
							return code;
						} catch (error: any) {
							recorded?.graph &&
								graphs.close(recorded.graph.id, recorded.taskId, {
									ok: false,
									detail: String(error?.stack ?? error?.message ?? error),
								});
							throw error;
						}
					},
				}),
				this.register({
					id: "interactive",
					priority: 10,
					claims: () => true,
					run: async (argv) => {
						const service = this.ctx.get("rlmRenderer");
						if (!service) throw new Error("the renderer row is not mounted");
						const { sessionManager, openAgentsView, sessionConfig, verbose } = await this.sessionFromLine(argv);
						const chat = service.start({
							cwd: this.config.cwd ?? process.cwd(),
							sessionManager,
							openAgentsView,
							sessionConfig,
							verbose,
						});
						// The process lives as long as the chat, not as long as this row:
						// the shell awaits `surface.lifetime`, so a hot swap of `modes`,
						// `renderer` or anything else can never end the process.
						// Never rejects: a crash still throws through `dispatch` (awaited
						// below); an unawaited rejection here would be an unhandled one.
						surface().lifetime = chat.then(
							() => 0,
							() => 1,
						);
						await chat;
						return 0;
					},
				}),
			];
			return () => disposers.forEach((d) => d.dispose());
		}, "rlm-modes builtins");
	}

	/**
	 * The prompt, which is the first positional after `--print` — not the next
	 * token.
	 *
	 * "The next token" is what this used to say, and it cost a day. On
	 * 2026-09-02T06:48:45Z the delegate started spawning children as
	 * `--print --session-id <id> <prompt>` so a retry could resume; from that
	 * commit until this one every delegated child — and every planner call,
	 * which is the same runner asked a different question — was handed the
	 * literal string `--session-id` as its entire task. 870 of the 886 sessions
	 * in the eight hours that followed begin with that one word. The agents did
	 * exactly what they were told, which was nothing, and the drive recorded
	 * 478 `unproven` against 5 `done`.
	 *
	 * So: skip flags and the values they carry, and take the first thing that
	 * is not one. A flag consumes the token after it only when that token is
	 * not itself a flag — the same rule `parseArgs` uses for anything it does
	 * not recognise, so both parsers read one command line the same way. A lone
	 * `--` ends options, and whatever follows is the prompt however it is spelled.
	 *
	 * A single dash is left alone on purpose: `- fix the thing` is a Markdown
	 * bullet, not an option, and prompts arrive looking like that.
	 */
	private async sessionFromLine(argv: string[]) {
		// The session flags are read by the same parser and resolved by the same
		// code `main()` uses. Nothing on this path used to read them, so `rlm -r`
		// opened a fresh chat and `rlm --resume <id>` started a new session file.
		const [{ parseArgs }, startup] = await Promise.all([
			import("../../coding-agent/src/cli/args.js"),
			import("../../coding-agent/src/cli/session-startup.js"),
		]);
		const parsed = parseArgs(argv);
		const cwd = this.config.cwd ?? process.cwd();
		const sessionManager = await startup.sessionManagerFromArgs(parsed, cwd);
		// The rest of the command line — --model, --provider, --thinking,
		// --models, --tools, --system-prompt, --skill, --no-extensions … — as the
		// runtime config `main()` builds from it. Same gap as the session flags:
		// `--model cliproxy/gpt-5.5` answered on the default model.
		const { runtimeConfigFromLine } = await import("../../coding-agent/src/cli/runtime-args.js");
		const appMode = parsed.mode === "json" ? "json" : parsed.print || !process.stdin.isTTY ? "print" : "interactive";
		return {
			sessionManager,
			openAgentsView: startup.opensAgentsViewForResume(parsed),
			sessionConfig: await runtimeConfigFromLine(parsed, cwd, appMode, sessionManager),
			printOutputMode: (appMode === "json" ? "json" : "text") as "json" | "text",
			verbose: parsed.verbose,
		};
	}

	private printPrompt(argv: string[]): string | null {
		const index = argv.indexOf("--print");
		if (index === -1) return null;
		for (let i = index + 1; i < argv.length; i++) {
			const arg = argv[i];
			if (arg === "--") return argv[i + 1] ?? null;
			if (!arg.startsWith("--")) return arg;
			if (arg.includes("=")) continue;
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) i++;
		}
		return null;
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

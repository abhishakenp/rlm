import { Service } from "@deepseek-ai/cordis";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";

/**
 * rlm-iris — Iris's surface inside rlm.
 *
 * - `/rlm status` in the TUI, and `iris()` / `status()` for callers: every open
 *   delegation graph, all subagents, and the recently completed ones
 *   (`.changes/iris-rlm-recent-subagents.md`).
 * - `rlm iris …` runs Iris on its one fixed session, and `/iris …` does the
 *   same from the TUI.
 *
 * Services are read when they are used, not injected: an `inject` naming a
 * service that is not mounted parks the row as PENDING for ever, which is what
 * the Sep 6 rewrite did (`delegate`, `sdk`, `tui`, `modes` — none of which
 * exist; they are `rlmDelegate`, `rlmSdk`, `rlmTui`, `rlmModes`). Without
 * `rlmDelegate` the status parts say so and the rest still works.
 *
 * Registrations go through `ctx.effect`, so a hot reload or removal takes them
 * back (cordis 4 never calls `[Service.dispose]`).
 */

const IRIS_BIN = process.env.IRIS_BIN ?? "/opt/homebrew/bin/iris";

/** Iris always runs on one fixed session: add the flags unless the caller chose its own. */
export const irisLaunchArgs = (args: string[]): string[] => {
	const out = [...args];
	const hasResume = out.some((a) => a === "--resume" || a === "-r" || a.startsWith("--resume="));
	const hasSessionDir = out.some((a) => a === "--session-dir" || a.startsWith("--session-dir="));
	if (!hasResume) out.unshift("--resume=~/.iris/mind/sessions/iris.jsonl");
	if (!hasSessionDir) out.push("--session-dir=~/.iris/mind/sessions");
	return out;
};

/** `iris-converse` beside the `iris` binary wins when it exists. */
export const irisBinary = (bin = IRIS_BIN): string => {
	const alt = bin.replace(/iris$/, "iris-converse");
	try {
		if (alt !== bin && statSync(alt).isFile()) return alt;
	} catch {}
	return bin;
};

export class RlmIris extends Service {
	static provide = "iris" as const;

	constructor(ctx: any) {
		// cordis 4: the second argument is the service NAME, not config — the
		// rewrite passed its config there and the row never provided `iris`.
		super(ctx, undefined as any);
	}

	async [Service.init]() {
		// `ctx.inject` runs each callback in a child fiber for as long as the
		// service is there — registered when it mounts, again after it is swapped
		// by a hot reload, and taken back when either side goes.
		this.ctx.inject(["rlmModes"], (ctx: any) => {
			const handle = ctx.get("rlmModes").register({
				id: "iris",
				priority: 50,
				claims: (argv: string[]) => argv[0] === "iris",
				run: (argv: string[]) => this.launch(argv.slice(1)),
			});
			ctx.effect(() => () => handle?.dispose?.());
		});

		this.ctx.inject(["rlmTui"], (ctx: any) => {
			const tui = ctx.get("rlmTui");
			const handles = [
				tui.registerSlashCommand("rlm-iris", {
					name: "rlm",
					description: "rlm subagent and delegation status",
					takesArgument: true,
					argumentHint: "status",
					handler: async (args: string, ctx: any) => {
						const [sub = "", action = ""] = (args ?? "").trim().split(/\s+/);
						if (sub === "status" && action === "") {
							const result = await this.iris();
							ctx.showMessage?.("```json\n" + JSON.stringify(result, null, 2) + "\n```");
							return;
						}
						ctx.showMessage?.("usage: /rlm status");
					},
				}),
				tui.registerSlashCommand("rlm-iris", {
					name: "iris",
					description: "Run Iris on its session (iris-converse when installed)",
					takesArgument: true,
					argumentHint: "[--resume <file>] [--session-dir <dir>]",
					handler: async (args: string, ctx: any) => {
						const argv = (args ?? "").trim() ? args.trim().split(/\s+/) : [];
						const code = await this.launch(argv);
						ctx.showMessage?.(`iris exited with code ${code}`);
					},
				}),
			];
			ctx.effect(() => () => {
				for (const h of handles) h?.dispose?.();
			});
		});
	}

	/** Run Iris with the session flags added. Resolves with its exit code. */
	launch(args: string[]): Promise<number> {
		const proc = spawn(irisBinary(), irisLaunchArgs(args), { stdio: "inherit" });
		return new Promise<number>((resolve) => {
			proc.on("error", (err) => {
				this.ctx.logger?.warn?.(`rlm-iris: could not start ${irisBinary()}: ${err.message}`);
				resolve(127);
			});
			proc.on("close", (code) => resolve(code ?? 0));
		});
	}

	/**
	 * Every open delegation graph, all subagents, and the recently completed
	 * subagents — `recent` is non-empty when any finished recently.
	 */
	async iris(): Promise<{ graphs: any[]; subagents: any[]; recent: any[] }> {
		const delegate = this.ctx.get("rlmDelegate") as any;
		const sdk = this.ctx.get("rlmSdk") as any;
		if (!delegate?.open) throw new Error("rlm-delegate is not mounted");

		const graphs = delegate.open().map((g: any) => ({
			id: g.id,
			goal: g.goal,
			createdAt: g.createdAt,
			tasks: g.tasks.map((t: any) => ({
				id: t.id,
				title: t.title,
				state: t.state,
				needs: t.needs,
				priority: t.priority,
				proof: t.proof,
				attempts: t.attempts,
				result: t.result,
				reason: t.reason,
				blockedBy: t.blockedBy,
				createdAt: t.createdAt,
				updatedAt: t.updatedAt,
			})),
		}));

		const subagents = (sdk?.listSubagents?.() ?? []).map((s: any) => ({
			id: s.id,
			name: s.name,
			status: s.status,
			sessionName: s.sessionName,
			completedAt: s.completedAt,
		}));

		return { graphs, subagents, recent: sdk?.recentSubagents?.() ?? [] };
	}

	/** `iris rlm.status` — `recent` is non-empty when subagents completed recently. */
	async status(): Promise<{ recent: any[] }> {
		const sdk = this.ctx.get("rlmSdk") as any;
		return { recent: sdk?.recentSubagents?.() ?? [] };
	}
}

export default RlmIris;

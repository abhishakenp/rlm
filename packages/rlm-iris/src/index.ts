import { Service } from "@deepseek-ai/cordis";

export class RlmIris extends Service {
	static inject = ["rlmDelegate", "rlmSdk", "rlmTui"] as const;
	static provide = "iris" as const;

	constructor(ctx: any) {
		super(ctx);
	}

	async [Service.init]() {
		// Register /rlm as a slash command in the TUI, so "iris rlm.status"
		// is reachable by typing /rlm status in the input bar.
		const tui = this.ctx.get("rlmTui") as any;
		if (tui?.registerSlashCommand) {
			tui.registerSlashCommand("rlm-iris", {
				name: "rlm",
				description: "rlm subagent and delegation status",
				takesArgument: true,
				argumentHint: "status",
				handler: async (args: string, ctx: any) => {
					const parts = (args ?? "").trim().split(/\s+/);
					const sub = parts[0] ?? "";
					const action = parts[1] ?? "";

					if (sub === "status" && action === "") {
						const result = await this.status();
						const msg = "```json\n" + JSON.stringify(result, null, 2) + "\n```";
						ctx.showMessage?.(msg);
						return;
					}

					ctx.showMessage?.("usage: /rlm status");
				},
			});
		}
	}

	/**
	 * Return JSON describing every open delegation graph, all subagents,
	 * and the recently-completed subagents that `iris rlm.status` recent
	 * exposes as a non-empty array when any subagent has finished recently.
	 */
	async iris(): Promise<any> {
		const delegate = this.ctx.get("rlmDelegate") as any;
		const sdk = this.ctx.get("rlmSdk") as any;
		if (!delegate) throw new Error("rlm-delegate is not mounted");

		const open = delegate.open();

		const graphs = open.map((g: any) => ({
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

		const subagents = (sdk?.listSubagents() ?? []).map((s: any) => ({
			id: s.id,
			name: s.name,
			status: s.status,
			sessionName: s.sessionName,
			completedAt: s.completedAt,
		}));

		const recent = sdk?.recentSubagents() ?? [];

		return { graphs, subagents, recent };
	}

	/**
	 * `iris rlm.status` — returns an object with a `recent` field that is
	 * a non-empty array when subagents have completed recently.
	 */
	async status(): Promise<{ recent: any[] }> {
		const sdk = this.ctx.get("rlmSdk") as any;
		const recent = sdk?.recentSubagents?.() ?? [];
		return { recent };
	}
}

export default RlmIris;

/**
 * delegator.ts — the delegation loop.
 *
 * Hot-swappable: edit this file and it reloads immediately. It is also the file
 * `rlm-delegate` reads at prompt-build time and shows the agent as the shape of
 * the flow, so changing it here changes what the agent is taught. Never paste a
 * copy of it anywhere; a copy goes stale and then teaches a flow that no longer
 * exists.
 *
 * What changed, and why
 * ─────────────────────
 * The previous version asked a model to decompose the request into steps, then
 * walked the steps in a `for` loop, in order, in memory. Three consequences,
 * all of which happened:
 *
 *   - Six jobs arrived, one was done, and the other five ended when the process
 *     did. Nothing on disk had ever recorded that they were asked for.
 *   - Steps ran one at a time even when nothing connected them.
 *   - A step was finished when the subagent stopped talking. Nine turns in a
 *     row ended with "Done" and nothing had been built.
 *
 * So the loop no longer owns the list. It writes the list down first, in a
 * graph that outlives it, where each task carries a mechanical criterion and
 * its real dependencies, and then it works that graph. If this process dies
 * halfway the next one picks up what is left, because the list is a file.
 *
 * `api` is injected by the workflow plugin — no imports needed.
 */

const PLAN_INSTRUCTIONS = `
Break this request into tasks. Return ONLY a JSON array, nothing else.

Each task is an object:
  id      short kebab-case handle, unique
  title   one line in the ASKER'S words — what they wanted, not how you'll do it
  prompt  what an agent needs to be told to do it (optional; defaults to title)
  needs   array of ids that must be DONE first. Only real dependencies — two
          tasks with no edge between them will run at the same time, which is
          the point. Cycles are refused.
  proof   how anyone can tell it is finished, WITHOUT taking an agent's word.
          One of:
            {"kind":"shell","run":"<command that exits 0 only when it worked>"}
            {"kind":"file","path":"<path>","contains":"<optional substring>"}
            {"kind":"row","id":"<composition row>","state":"ACTIVE"}
            {"kind":"command","name":"<command that must exist afterwards>"}

The proof is mandatory and it is the important field. "The agent said it was
done" is not evidence — a scaffold that was mounted and announced as a working
capability passes every prose check ever written. Prefer a command that
exercises the actual behaviour ("iris dirsize.of path=. returns a size") over
one that merely observes the work happened ("the file exists").

If one task must not start until another finishes, say so in \`needs\`. Do not
express ordering in the prose; nobody reads prose to schedule.
`;

const parseTasks = (text: string): any[] => {
	const match = text.match(/\[[\s\S]*\]/);
	if (!match) throw new Error("the planner returned no JSON array");
	const parsed = JSON.parse(match[0]);
	if (!Array.isArray(parsed) || !parsed.length) throw new Error("the planner returned an empty plan");
	return parsed;
};

export default (api: any) => ({
	name: "delegator",

	async run(input: string): Promise<string> {
		const graphs = api.ctx.get("rlmDelegate");
		if (!graphs) {
			throw new Error(
				"rlm-delegate is not mounted, so anything this loop did not finish would be lost. " +
					"Mount it before delegating.",
			);
		}

		// 1. Finish what is already owed before taking on anything new. This is
		//    the whole reason the graph exists, and it is one line.
		const owed = graphs.open().filter((g: any) => g.goal !== input);
		for (const graph of owed) {
			api.emit("rlm/delegator-resuming", { graph: graph.id, goal: graph.goal });
			await graphs.run(graph.id, (task: any) => api.sdk.spawn(task.prompt, { name: task.id }));
		}

		// 2. Write down what has just been asked, before doing any of it.
		let plan: any[] = [];
		let refusal = "";
		for (let attempt = 0; attempt < 2; attempt++) {
			const answer = await api.sdk.spawn(
				`${PLAN_INSTRUCTIONS}\n\nRequest:\n${input}${refusal ? `\n\nYour last plan was refused: ${refusal}\nFix exactly that.` : ""}`,
				{ name: "planner" },
			);
			try {
				plan = parseTasks(answer);
				break;
			} catch (error: any) {
				refusal = String(error?.message ?? error);
				plan = [];
			}
		}
		if (!plan.length) {
			// Even a request nobody could decompose gets written down, with a
			// criterion, rather than being attempted from memory and lost.
			plan = [
				{
					id: "the-request",
					title: input.split("\n")[0].slice(0, 120),
					prompt: input,
					proof: { kind: "shell", run: "false" },
				},
			];
		}

		// If the boundary already wrote this request down — it does, in code,
		// before any of this ran — refine that record rather than opening a
		// second graph beside it. One request, one row.
		const recorded = graphs
			.open()
			.find((g: any) => g.goal === input && g.tasks.length === 1 && g.tasks[0].proof?.kind === "unstated");

		let graph: any;
		try {
			graph = recorded ? graphs.refine(recorded.id, recorded.tasks[0].id, plan) : graphs.declare(input, plan);
		} catch (error: any) {
			// A cycle or a missing criterion is refused here, at declaration, with
			// nothing written — so the planner is told precisely what to fix
			// instead of the loop discovering it halfway through.
			const answer = await api.sdk.spawn(
				`${PLAN_INSTRUCTIONS}\n\nRequest:\n${input}\n\nThe graph refused your plan: ${error?.message}\nReturn a corrected array.`,
				{ name: "planner-again" },
			);
			const corrected = parseTasks(answer);
			graph = recorded
				? graphs.refine(recorded.id, recorded.tasks[0].id, corrected)
				: graphs.declare(input, corrected);
		}
		api.emit("rlm/delegator-plan", { graph: graph.id, tasks: graph.tasks.length });

		// 3. Work it. Everything independent goes at once, up to what the machine
		//    will carry; anything over that waits in the journal rather than being
		//    turned away. Every criterion is run by the graph, not reported by the
		//    agent that did the work.
		const done = await graphs.run(graph.id, (task: any) => api.sdk.spawn(task.prompt, { name: task.id }));

		// 4. Say what happened to everything, including what did not happen.
		const account = graphs.status(graph.id);
		api.emit("rlm/delegator-complete", {
			graph: graph.id,
			done: done.tasks.filter((t: any) => t.state === "done").length,
			total: done.tasks.length,
		});
		return account;
	},
});

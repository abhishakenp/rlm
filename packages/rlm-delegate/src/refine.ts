/**
 * Turning a recorded request into work that can be proven.
 *
 * The floor writes down whatever arrives, verbatim, with the criterion it can
 * read out of it — and against real traffic it can almost never read one, for a
 * reason that is not a bug: what arrives is fifteen jobs in one paragraph.
 * There is no single command that exits zero when "the whole backlog" is done,
 * so `unstated` is the honest answer and the drive would correctly turn every
 * one of them into a question. Fifteen questions is not fifteen questions worth
 * asking; it is one loop that cannot start.
 *
 * So before the drive gives up on a request nobody could judge, it asks a model
 * to do the one thing a model is actually needed for here: read the paragraph
 * and say what the separate jobs are, what each depends on, and — the part that
 * matters — how anybody could tell each one is finished without being told.
 *
 * This is `refine()`, which already existed, driven by nobody until now.
 *
 * Two things keep it honest:
 *
 *   - **It only ever runs on `unstated`.** A task that already has a criterion
 *     is not improved by a model's opinion of it.
 *   - **A refusal is not a guess.** If the plan will not parse, or the graph
 *     refuses it, the task is left exactly as it was — still owed, still
 *     heading for a question. A bad decomposition that gets written down is
 *     worse than none, because it looks like progress.
 */
import { askIn } from "./derive.ts";
import type { Graph, Task, TaskInput } from "./graph.ts";
import type { Store } from "./store.ts";

export type Planner = (prompt: string, task: Task, graph: Graph) => Promise<string>;

export const PLAN_INSTRUCTIONS = `
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
            {"kind":"file","path":"<absolute path>","contains":"<optional substring>"}
            {"kind":"row","id":"<composition row>","state":"ACTIVE"}
            {"kind":"command","name":"<command that must exist afterwards>"}

The proof is mandatory and it is the important field. "The agent said it was
done" is not evidence — a scaffold that was mounted and announced as a working
capability passes every prose check ever written. Prefer a command that
exercises the actual behaviour ("iris dirsize.of path=. returns a size") over
one that merely observes the work happened ("the file exists").

Do not invent a criterion you cannot justify from the request. If one job in the
list genuinely has no mechanical check, give it
{"kind":"shell","run":"<the closest honest check you can name>"} rather than
something that passes trivially — a criterion written to be easy is worse than
no criterion, because it turns an open job into a false receipt.

If one task must not start until another finishes, say so in \`needs\`. Do not
express ordering in the prose; nobody reads prose to schedule.
`;

export const parsePlan = (text: string): TaskInput[] => {
	const match = String(text ?? "").match(/\[[\s\S]*\]/);
	if (!match) throw new Error("the planner returned no JSON array");
	const parsed = JSON.parse(match[0]);
	if (!Array.isArray(parsed) || !parsed.length) throw new Error("the planner returned an empty plan");
	return parsed;
};

/**
 * Every request that is recorded, owed, and impossible to judge as it stands.
 *
 * Never a task something has already been broken into (it is a `rollup` by
 * then), and never one already carrying a real criterion.
 */
export const needsRefining = (graph: Graph): Task[] =>
	graph.tasks.filter(
		(task) => task.proof.kind === "unstated" && task.state !== "done" && task.state !== "running",
	);

/**
 * Ask, and write the answer down only if the graph accepts it.
 *
 * Returns the number of tasks the request became, or 0 if it stays as it is.
 */
export const refineOne = async (
	store: Store,
	graph: Graph,
	task: Task,
	plan: Planner,
	say: (event: string, data: Record<string, unknown>) => void = () => {},
): Promise<number> => {
	// The ask, not the envelope. Handing a model eleven kilobytes of standing
	// instructions and asking what the jobs are gets it a plan for the
	// instructions.
	const ask = askIn(task.prompt) ?? askIn(graph.goal) ?? task.prompt;

	let refusal = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		let tasks: TaskInput[];
		try {
			const answer = await plan(
				`${PLAN_INSTRUCTIONS}\n\nRequest:\n${ask}${refusal ? `\n\nYour last plan was refused: ${refusal}\nFix exactly that and return the whole corrected array.` : ""}`,
				task,
				graph,
			);
			tasks = parsePlan(answer);
		} catch (error: any) {
			refusal = String(error?.message ?? error);
			say("rlm/delegate-refine-refused", { graph: graph.id, task: task.id, why: refusal });
			continue;
		}
		try {
			store.refine(graph.id, task.id, tasks);
			say("rlm/delegate-refined", { graph: graph.id, task: task.id, into: tasks.length });
			return tasks.length;
		} catch (error: any) {
			// A cycle, a duplicate id, a missing criterion. Nothing was written;
			// the planner is told precisely what to fix.
			refusal = String(error?.message ?? error);
			say("rlm/delegate-refine-refused", { graph: graph.id, task: task.id, why: refusal });
		}
	}
	return 0;
};

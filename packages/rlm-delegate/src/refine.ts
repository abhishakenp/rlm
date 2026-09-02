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
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { askIn } from "./derive.ts";
import { describeProof, type Graph, type Proof, type Task, type TaskInput } from "./graph.ts";
import { check } from "./proof.ts";
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

/**
 * A criterion that already passes is not a criterion.
 *
 * The first real drive proved five tasks and three of them were proved by
 * `echo 'Write a skill'`, `echo tool-loop-alive` and `echo 'skill' | grep -q
 * 'skill'`. Every one exits zero on a machine where nothing has happened. The
 * graph did exactly what it promised — it ran the criterion and the criterion
 * held — and the result was three receipts for nothing, which is the failure
 * this whole package was written about, arriving through the one door left
 * open.
 *
 * The reviewer's seam is the general answer to a criterion written to be easy,
 * and it is still where judgement belongs. But a criterion that passes *before
 * the work starts* needs no judgement at all: it is decidable, here, by running
 * it. So it is run, once, before the plan is accepted, and a plan that could
 * not have failed is handed back to the planner saying so.
 *
 * Only `shell` is checked, and only for passing. `file` criteria are already
 * safe against this — the interesting ones say `contains`, and a file that
 * already contains the answer means the work really is done. A criterion that
 * *errors* is not gaming and is left alone; that is a different question, and
 * impasse.ts asks it.
 */
export const alreadyTrue = async (
	tasks: TaskInput[],
	cwd?: string,
): Promise<Array<{ id: string; proof: Proof }>> => {
	const found: Array<{ id: string; proof: Proof }> = [];
	for (const task of tasks) {
		if (task.proof?.kind !== "shell") continue;
		try {
			const verdict = await check(task.proof, { cwd });
			if (verdict.verdict === "passed") found.push({ id: task.id, proof: task.proof });
		} catch {
			/* a criterion that will not run is not a criterion that cannot fail */
		}
	}
	return found;
};

/**
 * What each shell criterion printed *before* any of the work existed.
 *
 * Recorded on the proof as `inertIf`. Later, a criterion that fails with the
 * exact same output has been shown to be independent of the work — it is not
 * evidence that the work failed, it is evidence that the check never measured
 * it. Nothing here judges: it only writes down what was true at the one moment
 * when the answer is known for certain.
 */
/**
 * Criteria that name a place which will not be there next time.
 *
 * A delegated agent runs in a fresh temp directory, so a criterion like
 * `/var/folders/…/T/iris-rlm-mkzFts/skills/fashion-trends/SKILL.md contains …`
 * is checking a directory that existed only for the run that wrote it. It
 * cannot hold afterwards no matter how well the work was done, and it fails
 * with "does not exist", which reads exactly like the agent having done
 * nothing. Two tasks failed this way and nine went unreachable behind them.
 *
 * This is decidable before anybody starts, which is the only good moment: the
 * plan is refused and the planner is told to name somewhere that outlives the
 * run.
 */
export const ephemeral = (tasks: TaskInput[]): Array<{ id: string; where: string }> => {
	// Both spellings: macOS hands out /var/folders/… while realpath gives
	// /private/var/folders/…, and a plan can carry either.
	let real = tmpdir();
	try {
		real = realpathSync(tmpdir());
	} catch {
		/* the temp dir is always there; if it is not, nothing below matters */
	}
	const temporary = (place: string) => [real, tmpdir(), "/tmp/"].some((prefix) => place.includes(prefix));

	const found: Array<{ id: string; where: string }> = [];
	for (const task of tasks) {
		const proof: any = task.proof;
		if (!proof) continue;
		const places = [proof.path, proof.cwd].filter((x): x is string => typeof x === "string");
		// A shell criterion carries its paths inside the command text, so the
		// whole command is searched for a temp path rather than parsed.
		if (typeof proof.run === "string") {
			for (const word of proof.run.split(/\s+/)) if (temporary(word)) places.push(word);
		}
		for (const place of places) {
			if (!temporary(place)) continue;
			// Under the temp area *and* nothing there yet. A workspace somebody
			// deliberately made for this run exists already and is fine to check
			// against; a directory the plan merely imagines is one the agent will
			// create fresh, differently, on every attempt.
			const parent = dirname(place);
			if (existsSync(parent)) continue;
			found.push({ id: task.id, where: place });
			break;
		}
	}
	return found;
};

export const noteBaselines = async (tasks: TaskInput[], cwd?: string): Promise<void> => {
	for (const task of tasks) {
		if (task.proof?.kind !== "shell") continue;
		try {
			const verdict = await check(task.proof, { cwd });
			if (verdict.verdict === "failed") task.proof.inertIf = verdict.detail;
		} catch {
			/* a criterion that will not run at all is a separate fault, left to the
			   run itself to report; guessing a baseline here would invent one. */
		}
	}
};

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
	options: { cwd?: string; allowVacuous?: boolean } = {},
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
		// Before it is written down: did any of these already pass, with nobody
		// having done anything? Those are receipts, not criteria.
		// Somewhere that will not exist next time is not somewhere.
		const fleeting = ephemeral(tasks);
		if (fleeting.length) {
			refusal =
				`${fleeting.length} of your criteria point inside a temporary directory that only exists for one ` +
				`run: ${fleeting.map((f) => `${f.id} (${f.where})`).join("; ")}. ` +
				`Whoever does the work gets a different temporary directory, so the check will say the file is ` +
				`missing however well the work was done. Name somewhere that outlives the run.`;
			say("rlm/delegate-refine-refused", { graph: graph.id, task: task.id, why: refusal, ephemeral: fleeting.map((f) => f.id) });
			continue;
		}

		if (!options.allowVacuous) {
			const vacuous = await alreadyTrue(tasks, options.cwd);
			if (vacuous.length) {
				refusal =
					`${vacuous.length} of your criteria pass right now, before anybody has done any of the work: ` +
					`${vacuous.map((v) => `${v.id} (${describeProof(v.proof)})`).join("; ")}. ` +
					`A check that cannot fail is a receipt for nothing. Replace each one with a command that ` +
					`exits non-zero today and zero only once the work is actually finished.`;
				say("rlm/delegate-refine-refused", { graph: graph.id, task: task.id, why: refusal, vacuous: vacuous.map((v) => v.id) });
				continue;
			}
		}

		// The plan is about to be accepted, so this is the last moment at which
		// "before the work" is still true. Every shell criterion is run once and
		// what it printed is kept, so a later identical failure can be told
		// apart from a real one.
		await noteBaselines(tasks, options.cwd);

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

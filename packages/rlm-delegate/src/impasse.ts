/**
 * When to stop trying and ask him.
 *
 * This is the judgement the rest of the package exists to make well, and it is
 * a judgement in one direction: getting it wrong by asking costs him ten
 * seconds; getting it wrong by looping costs the night. He has said, more than
 * once, that he would rather be asked ten times than find nothing done. So the
 * rule is deliberately eager, and it is a rule about *information*, not about
 * effort or difficulty:
 *
 *   **Another attempt is worth making only if it would have something the last
 *   one did not.**
 *
 * The runner has exactly three sources of new information for an attempt: the
 * task text, how the last attempt failed, and the state of the machine. That is
 * the whole list, so the branches are countable:
 *
 *   HARD — the failure shape is new. Something is known now that was not known
 *          before, so the next attempt is genuinely a different attempt. Retry,
 *          carrying it.
 *
 *   HARD, but the approach must change — the shape repeated. The error text has
 *          already been supplied once and did not help; supplying it again is
 *          the same attempt with more words. A different carrier of the
 *          guidance gets it instead (see `diagnose` in lapse.ts). Retry, once.
 *
 *   IMPOSSIBLE FOR NOW — the same shape survived a changed approach, or the
 *          budget is spent. Two different approaches producing the identical
 *          failure sentence is the machine telling you it has run out of
 *          things it knows. Stop, and ask.
 *
 *   IMPOSSIBLE IMMEDIATELY, with no attempt spent — the obstacle is one that no
 *          attempt could move. Three of these, and none is a judgement call:
 *            · nobody said how to tell it is finished. A standard cannot be
 *              invented from below; only the person who asked has it.
 *            · the criterion cannot be RUN from here. The work may well be
 *              done. Retrying the work does not make the checker able to see.
 *            · it stands on something that died. Fix the root, not the leaf.
 *
 * "Impossible" here never means impossible in principle. It means *this loop
 * has nothing left to try*, which is the only kind of impossibility a machine
 * is entitled to assert, and it is why every one of these leaves a question
 * rather than a verdict. Answer any of them and the task goes straight back
 * into the pool.
 */
import { describeProof, type Graph, type Task } from "./graph.ts";

export type ImpasseKind =
	| "no-criterion"
	| "unchecked-criterion"
	| "same-way-twice"
	| "budget-spent"
	| "stands-on-a-corpse";

export interface Impasse {
	graph: string;
	goal: string;
	task: Task;
	kind: ImpasseKind;
	/** One sentence, specific, answerable. Never "something went wrong". */
	question: string;
	/** What was tried, so he can tell whether the question is a fair one. */
	tried: string;
}

const firstLine = (text: string | undefined): string =>
	String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

const HOW_TO_ANSWER =
	"Answer with a criterion this process can run by itself: a command that exits 0, a file that must " +
	"exist or contain something, a composition row that must reach ACTIVE, or a command that must be in " +
	"the registry.";

/** Every task that is stopped and needs a person, with the sentence to put to him. */
export const impasses = (graphs: Graph[]): Impasse[] => {
	const out: Impasse[] = [];

	for (const graph of graphs) {
		for (const task of graph.tasks) {
			const attempts = task.attempts.length;
			const tried = attempts
				? `${attempts} attempt${attempts === 1 ? "" : "s"}; the last ended: ${firstLine([...task.attempts].reverse()[0]?.detail)}`
				: "never attempted";

			// Nobody said how to tell. This is not a failure and must never be
			// retried: handing back a task nobody can judge produces another turn
			// nobody can judge.
			if (task.proof.kind === "unstated" && task.state !== "done") {
				out.push({
					graph: graph.id,
					goal: graph.goal,
					task,
					kind: "no-criterion",
					question: `How will we know "${task.title}" is done? ${HOW_TO_ANSWER}`,
					tried,
				});
				continue;
			}

			if (task.state === "unreachable") {
				out.push({
					graph: graph.id,
					goal: graph.goal,
					task,
					kind: "stands-on-a-corpse",
					question:
						`"${task.title}" cannot be started: it needs ${(task.blockedBy ?? []).join(", ")}, which did not ` +
						`hold. Should the thing it needs be fixed, or should this stop needing it?`,
					tried,
				});
				continue;
			}

			if (task.state !== "failed" && task.state !== "rejected") continue;

			const reason = task.reason ?? "";
			if (/could not be checked|no attempt can settle this/i.test(reason)) {
				out.push({
					graph: graph.id,
					goal: graph.goal,
					task,
					kind: "unchecked-criterion",
					question:
						`"${task.title}" may well be finished — nothing here can tell, because its criterion ` +
						`(${describeProof(task.proof)}) cannot be run from this process. ${HOW_TO_ANSWER}`,
					tried,
				});
				continue;
			}

			const sameWay = /same way/i.test(reason);
			out.push({
				graph: graph.id,
				goal: graph.goal,
				task,
				kind: sameWay ? "same-way-twice" : "budget-spent",
				question: sameWay
					? `"${task.title}" failed the same way every time it was tried, from more than one angle: ` +
						`${firstLine(reason.split("\n").slice(1).join("\n")) || firstLine(reason)}. ` +
						`Is the obstacle something only you can move, or is the task wrong?`
					: `"${task.title}" was tried until the attempts ran out and never worked: ${firstLine(reason)}. ` +
						`Should it keep being tried, or is it wrong?`,
				tried,
			});
		}
	}

	return out;
};

/** The questions as a file he can read in the morning, in one screen. */
export const renderImpasses = (found: Impasse[], now = new Date()): string => {
	if (!found.length) return `# Nothing is waiting on you\n\nAs of ${now.toISOString()}.\n`;
	const heading: Record<ImpasseKind, string> = {
		"no-criterion": "Nobody said how to tell these are finished",
		"unchecked-criterion": "These may be done — nothing here can check them",
		"same-way-twice": "These failed the same way from more than one angle",
		"budget-spent": "These were tried until the attempts ran out",
		"stands-on-a-corpse": "These are waiting on something that did not hold",
	};
	const order: ImpasseKind[] = [
		"same-way-twice",
		"budget-spent",
		"unchecked-criterion",
		"no-criterion",
		"stands-on-a-corpse",
	];
	const lines = [
		`# ${found.length} thing${found.length === 1 ? "" : "s"} waiting on one sentence from you`,
		"",
		`As of ${now.toISOString()}. Nothing here was dropped — every one is still owed and goes straight`,
		"back into the pool the moment it is answered.",
	];
	for (const kind of order) {
		const rows = found.filter((f) => f.kind === kind);
		if (!rows.length) continue;
		lines.push("", `## ${heading[kind]}`, "");
		for (const row of rows) {
			lines.push(`- **${row.graph}/${row.task.id}** — ${row.question}`);
			lines.push(`  <sub>${row.tried}</sub>`);
		}
	}
	return `${lines.join("\n")}\n`;
};

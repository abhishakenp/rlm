/**
 * me-2 — the reviewer that reviews the way he does.
 *
 * The `Reviewer` seam has been in graph.ts since the beginning with nothing
 * plugged into it, and its comment says so: "his me-2, not built here". This
 * is the smallest thing that can honestly sit there.
 *
 * What makes it his rather than mine is where the criteria come from. It is
 * handed the lessons — real incidents, in his words — and asked to look for a
 * *new instance* of one of them, not to tick them off. That distinction is the
 * whole design: a checklist finds what it lists, and every defect that has cost
 * us a night was one nobody had listed.
 *
 * It reviews against `task.prompt`, which carries what he actually asked for,
 * because a change can be correct, tested and wired and still not be the thing
 * he wanted.
 *
 * It refuses to accept on silence. A reviewer that cannot be reached returns
 * `rejected` with the reason, never `accepted` — unreviewable is not reviewed,
 * and that confusion is the same one that made `unproven` read as done.
 */
import type { Graph, Reviewer, Task } from "./graph.ts";
import { brief, load, type Lesson } from "./lessons.ts";

export interface Me2Options {
	/** Ask a model. Returns free text. */
	ask(prompt: string): Promise<string>;
	lessons?: Lesson[];
	/** What actually changed, if the caller can say. Reviewing prose is weaker. */
	diff?(task: Task, graph: Graph): Promise<string | undefined>;
}

/**
 * A line that is a verdict and nothing else.
 *
 * Whole-line on purpose. Both words appear constantly inside the paragraph
 * while it explains itself ("this is the exact failure mode..., so it is
 * rejected"), and a substring match turns any of that into the answer.
 */
const VERDICT = /^[ \t]*[*_`#>\-]*[ \t]*(accepted|rejected)[ \t]*[*_`.!:]*[ \t]*$/gim;

/**
 * Reasoning models answer inside `<think>` before they answer.
 *
 * The first real run spent its whole budget thinking and never reached a
 * verdict, and the words "accepted" and "rejected" appear all through that
 * reasoning while it weighs them — so the block has to be removed rather than
 * searched. An unterminated one means it was cut off mid-thought, which is not
 * a verdict either.
 */
const strip = (text: string): string =>
	String(text ?? "")
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<think>[\s\S]*$/i, "")
		.trim();

export const me2 = (options: Me2Options): Reviewer => ({
	async review(task: Task, graph: Graph) {
		const lessons = options.lessons ?? load();
		const evidence = task.attempts
			.slice(-2)
			.map((a, i) => `attempt ${i + 1}: ${a.ok ? "reported done" : "failed"} — ${String(a.detail ?? "").slice(0, 700)}`)
			.join("\n");
		const changed = (await options.diff?.(task, graph).catch(() => undefined)) ?? "";

		const prompt = [
			"You are reviewing finished work before it is called done. You are not a linter and not a",
			"style critic. You are looking for the one thing that would make him say 'this should never",
			"have happened'.",
			"",
			brief(lessons),
			"",
			"## What he asked for",
			"",
			task.prompt || task.title,
			"",
			"## What the criterion was",
			"",
			JSON.stringify(task.proof),
			"",
			"## What happened",
			"",
			evidence || "(no attempts recorded)",
			...(changed ? ["", "## What changed", "", changed.slice(0, 12_000)] : []),
			"",
			"## Answer",
			"",
			"Look for a NEW instance of one of those lessons — not a repeat of the example. Ask in",
			"particular: is any of this redundant with something that already exists; is it wired such",
			"that something really reaches it at runtime; does it match what he asked for rather than a",
			"reasonable version of it; and does anything here read like success without having looked.",
			"",
			"Write the paragraph FIRST, then the verdict — in that order, and the order is not cosmetic.",
			"Asked for the verdict first, a model names one before it has committed to an argument, and",
			"then writes the argument for the other one: observed on real work, where it answered",
			"`accepted` above a paragraph that ended \"this is the exact failure mode from lesson one\".",
			"",
			"So: one short paragraph. If you would reject, name the lesson and say what to do. Do not",
			"reject for style, for missing tests, or for anything you cannot point at. Then, on the very",
			"last line, on a line of its own and as the whole line, write exactly one word — `accepted`",
			"or `rejected` — and make it the one your paragraph argued for.",
		].join("\n");

		let answer: string;
		try {
			answer = await options.ask(prompt);
		} catch (error: any) {
			// Unreviewable is not reviewed. Accepting here would rebuild the exact
			// confusion that let `unproven` read as done.
			return { verdict: "rejected", reason: `me-2 could not be reached, so nothing has been reviewed: ${error?.message ?? error}` };
		}

		const said = strip(answer);
		const hits = [...said.matchAll(VERDICT)];
		if (!hits.length) {
			return {
				verdict: "rejected",
				reason: `me-2 did not answer with a verdict, so nothing has been reviewed: ${(said || String(answer ?? "")).slice(0, 300)}`,
			};
		}

		// It contradicted itself, so it has not answered.
		//
		// A model that says `accepted` on top and `rejected` at the bottom has
		// argued both, and picking either is picking for it. This is the same
		// rule as silence — unreviewable is not reviewed — and it must fail this
		// way round: an acceptance nobody meant is the outcome me-2 exists to
		// prevent, and it is the one that leaves no trace of having gone wrong.
		const words = [...new Set(hits.map((h) => h[1].toLowerCase()))];
		if (words.length > 1) {
			return {
				verdict: "rejected",
				reason:
					`me-2 answered both ways, so nothing has been reviewed — it said ${words.join(" and ")}. ` +
					`What it wrote: ${said.slice(0, 400)}`,
			};
		}

		const verdict = words[0] as "accepted" | "rejected";
		// The argument, which is everything that is not the verdict line.
		const last = hits[hits.length - 1];
		const before = said.slice(0, last.index).trim();
		const after = said.slice(last.index + last[0].length).trim();
		const reason = (before.length >= after.length ? before : after).slice(0, 1200) || "(no reason given)";
		return { verdict, reason };
	},
});

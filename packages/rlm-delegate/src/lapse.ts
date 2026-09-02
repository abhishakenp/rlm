/**
 * Failure shapes — why a task is not simply handed back unchanged.
 *
 * An agent that failed the same way six times will fail the seventh. Retrying
 * an identical prompt is not resilience, it is a loop with a nicer name, and it
 * spends the only budget there is.
 *
 * The clustering here is deliberately the same idea as `@iris/lapse` in the
 * Iris tree (normalise the sentence, Dice coefficient over its words, only
 * compare failures from the same producer) — reproduced rather than imported
 * because that package is welded to Iris's Cordis services and its diagnosis
 * engine answers a question this loop does not ask. What is borrowed is the
 * part that matters here: two failures are "the same" when the *sentence* is
 * the same once identifiers are stripped out.
 *
 * What is deliberately NOT borrowed: the four-cause diagnosis. Lapse asks why
 * the guidance never reached the decision, which is a question about a whole
 * system over weeks. This loop only needs one decision, now: is another
 * attempt going to be any different?
 */

/** Strip the parts that differ between two occurrences of the same failure. */
export const normalise = (reason: string): string =>
	String(reason ?? "")
		.toLowerCase()
		.replace(/`[^`\n]*`/g, " ") // backticked literals
		.replace(/"[^"\n]*"/g, " ")
		.replace(/'[^'\n]*'/g, " ")
		.replace(/\S*\/\S*/g, " ") // paths
		.replace(/\b\d[\d.,_-]*\b/g, " ") // numbers, ids, timestamps
		.replace(/[^\p{L}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

/**
 * Dice over the word sets. Dice rather than Jaccard because these sentences are
 * short, and Jaccard punishes a single unshared token far too hard.
 */
export const similarity = (a: string, b: string): number => {
	const left = new Set(normalise(a).split(" ").filter(Boolean));
	const right = new Set(normalise(b).split(" ").filter(Boolean));
	if (!left.size || !right.size) return 0;
	let shared = 0;
	for (const word of left) if (right.has(word)) shared += 1;
	return (2 * shared) / (left.size + right.size);
};

/**
 * The first line is the shape. A stack trace below it varies with every run and
 * says nothing about whether the next attempt will go differently.
 */
/**
 * Did something outside the work refuse to run it?
 *
 * Credits, quota, rate limits, a 402. Deliberately narrow: a wrong guess here
 * turns a real failure into an eternal retry, which is worse than the bug it
 * fixes. Every pattern below came from output actually seen in the journal,
 * not imagined.
 */
export const wall = (detail: string): boolean =>
	/run out of credits|insufficient (?:credit|quota|balance)|quota exceeded|\b402\b|rate.?limit(?:ed|s)?\b|too many requests|overloaded_error|billing/i.test(
		String(detail ?? ""),
	);

export const shapeOf = (reason: string): string => {
	const first = String(reason ?? "")
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);
	return normalise(first ?? "").slice(0, 200);
};

export interface Verdict {
	/** Hand it to an agent again? */
	retry: boolean;
	/** Said in the delegator's own words, and recorded on the task. */
	why: string;
	/** How many previous attempts failed this same way. */
	repeats: number;
}

/**
 * Decide whether another attempt is worth anything.
 *
 * Three refusals, in order of how badly a retry would waste time:
 *   - this exact shape has already been seen `floor` times → the agent does not
 *     know how to get past it, and saying it again louder will not help;
 *   - the attempt budget is spent;
 *   - otherwise retry, but only because the caller will change the prompt —
 *     see `carry()`. An unchanged retry is never returned as `retry: true`
 *     without something new to carry.
 */
export const judge = (
	previous: Array<{ ok: boolean; shape?: string }>,
	latest: string,
	options: { maxAttempts?: number; floor?: number; similarity?: number } = {},
): Verdict => {
	const maxAttempts = options.maxAttempts ?? 3;
	const floor = options.floor ?? 2;
	const near = options.similarity ?? 0.6;

	const failures = previous.filter((a) => !a.ok);
	const shape = shapeOf(latest);
	// The failure in hand counts. `floor: 2` has to mean "it has now failed this
	// way twice, stop", not "let it fail this way twice more first".
	const repeats = failures.filter((a) => a.shape && similarity(a.shape, shape) >= near).length + 1;

	if (repeats >= floor) {
		return {
			retry: false,
			repeats,
			why: `gave up after failing the same way ${repeats} times: ${shape || "(no message)"}`,
		};
	}
	if (failures.length + 1 >= maxAttempts) {
		return { retry: false, repeats, why: `gave up after ${failures.length + 1} attempts` };
	}
	return { retry: true, repeats, why: `retrying once, carrying the failure into the prompt` };
};

/**
 * Move the failure to where the decision is made.
 *
 * The retry is not the same task again — the agent is told, in the task text
 * itself and not somewhere up in a system prompt, exactly how the last attempt
 * ended. If nothing can be carried, there is nothing to retry.
 */
export const carry = (prompt: string, failure: string): string =>
	[
		prompt,
		"",
		"The previous attempt at this exact task failed. Do not repeat it:",
		failure.split("\n").slice(0, 20).join("\n").trim(),
	].join("\n");

// ─── Which carrier of the guidance failed ───────────────────────────────────
//
// `judge()` above answers "is another go worth anything?". It does not answer
// the more useful question: *what should be different about the next one?*
//
// `@iris/lapse` answers that with a model of carriers — the positions guidance
// can occupy relative to the decision — and a diagnosis that names the one that
// failed. Its four kinds are `standing` (loaded once, far above the decision),
// `in-turn` (injected next to it), `posthoc` (speaks only after the attempt: it
// can refuse, it cannot redirect) and `affordance` (whether the right thing was
// reachable at all). Reproduced rather than imported, for the same reason the
// clustering above is: that package is welded to Iris's Cordis services, and it
// re-derives its own Dice for exactly this reason.
//
// One task attempt has all four, and they are concrete here:
//
//   standing    the task text as declared, written before anybody tried
//   in-turn     how the last attempt failed, carried into the task text
//   posthoc     the criterion — it runs after the work and can only refuse
//   affordance  whether the thing the agent reached for was there at all
//
// Reading a failure that way says what to change, and the answers differ:
//
//   only-after-the-fact  the criterion refused and nothing else ever spoke.
//                        Move it in front: tell the next attempt what will be
//                        run against it, and have it run that itself.
//   not-offered          what it reached for was not there. Nothing said can
//                        fix that, so stop saying things — establish what does
//                        exist first, and forbid the route that was missing.
//   never-carried        nothing anywhere had the failure on it. Carry it.
//
// The last one is the ordinary case and the weakest change, which is why it is
// last: it is the only rung that is "the same attempt, better informed".

export type Carrier = "standing" | "in-turn" | "posthoc" | "affordance";

export type CauseKind = "not-offered" | "only-after-the-fact" | "never-carried" | "cut-off" | "exhausted";

export interface Diagnosis {
	cause: CauseKind;
	/** The carrier that failed, in one word. */
	carrier: Carrier;
	/** Said in the loop's own words, for the journal and for a person. */
	sentence: string;
	/** What the next attempt must do differently. Empty when there is no next. */
	directive: string[];
}

/**
 * A criterion refusing is not the same failure as a command not existing.
 *
 * These are read out of the failure sentence because that is all there is —
 * the runner is handed text. They are deliberately few: a taxonomy nobody can
 * tell apart is worse than none, and every branch here has to change what the
 * next attempt does or it has no business existing.
 */
const NOT_OFFERED =
	/\b(command not found|no such file|not found|is not registered|cannot find|could not find|unknown command|enoent|not recognised|not recognized|permission denied|eacces|is not mounted|no such command)\b/i;

/**
 * The criterion pushed back, which means the work may have happened and still
 * not counted. Tested before the one above, and that order is load-bearing: a
 * criterion refusing says "dirsize.of is not registered", which reads exactly
 * like something the agent could not find. It is not — the agent found nothing
 * missing; the check did. Getting that backwards sends the wrong instruction.
 */
/**
 * The attempt was cut off rather than refused.
 *
 * Worth its own branch, and worth testing before either of the others, because
 * the journal is full of these and they read like incapacity: a fifteen-minute
 * delegation timeout killed every multi-task backlog partway through, and each
 * one came back as a failure whose sentence said nothing about time. Telling an
 * agent "you failed, here is the error" when what happened is that it was
 * killed mid-sentence teaches it the wrong lesson, and clustering two of them
 * as "the same failure" gives up on work that was never actually refused.
 */
const CUT_OFF = /\b(ran past|timed ?out|timeout|etimedout|sigkill|sigterm|killed|stopped mid-attempt|socket hang ?up)\b/i;

const CRITERION_REFUSED = /it reported done, but the criterion did not hold/i;

export const diagnose = (
	previous: Array<{ ok: boolean; shape?: string; detail?: string }>,
	latest: string,
	options: { similarity?: number } = {},
): Diagnosis => {
	const near = options.similarity ?? 0.6;
	const shape = shapeOf(latest);
	const failures = previous.filter((a) => !a.ok);
	const sameShape = failures.filter((a) => a.shape && similarity(a.shape, shape) >= near);

	// Every carrier has now been used, and used with this exact failure on it.
	// There is nothing left to move and nothing left to say.
	if (sameShape.length >= 2) {
		return {
			cause: "exhausted",
			carrier: "affordance",
			sentence:
				`the same failure survived a changed approach — every carrier has now had it on it ` +
				`(${sameShape.length + 1} attempts, all "${shape || "no message"}") and none of them reached the decision`,
			directive: [],
		};
	}

	if (CRITERION_REFUSED.test(latest)) {
		return {
			cause: "only-after-the-fact",
			carrier: "posthoc",
			sentence: "the work was reported finished and only the criterion disagreed, which it can only do afterwards",
			directive: [
				"The last attempt believed it had finished. The check disagreed, and the check is the only",
				"thing that decides. So run the check YOURSELF, before you say anything, and keep working",
				"until it passes. Reporting success without having run it is the failure being repeated.",
			],
		};
	}

	if (CUT_OFF.test(latest)) {
		return {
			cause: "cut-off",
			carrier: "affordance",
			sentence: "the last attempt was cut off rather than refused — it ran out of time or was killed",
			directive: [
				"The last attempt did not fail; it was stopped partway through, so nothing it says about",
				"what is impossible can be trusted. Do the SMALLEST piece that can be proven on its own",
				"first, and prove it, before going near the rest. Do not restart from the beginning if the",
				"earlier part is already done — check what is there before redoing it.",
			],
		};
	}

	if (NOT_OFFERED.test(latest)) {
		return {
			cause: "not-offered",
			carrier: "affordance",
			sentence: "what the last attempt reached for was not there, so nothing said to it can fix that",
			directive: [
				"The last attempt reached for something that does not exist. Do not reach for it again.",
				"Before doing anything else, establish what actually IS there — list the directory, run the",
				"command with no arguments, read the file — and say what you found. Then use only that.",
			],
		};
	}

	return {
		cause: "never-carried",
		carrier: "in-turn",
		sentence: "nothing the last attempt was given mentioned this failure, because it had not happened yet",
		directive: ["The previous attempt at this exact task failed. Do not repeat it."],
	};
};

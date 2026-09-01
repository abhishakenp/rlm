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

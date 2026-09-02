/**
 * What he has already had to say twice.
 *
 * A reviewer whose criteria I invented is a reviewer that checks my idea of
 * the system, and my idea is what keeps being wrong — a flag parsed and never
 * read, a guard that could not be true, a filter that ate every graph and
 * reported success. Every one of those had a passing test.
 *
 * So the criteria are not mine. Each lesson here is a thing that actually went
 * wrong, recorded with *his words about it*, because the wording is the part
 * that generalises: "an empty array is truthy" is a fact about JavaScript, but
 * "the sentence that reads like success is the one nobody checks" is a way of
 * looking at code that catches the next one too.
 *
 * The set grows. `add()` is how a new correction becomes a standing check, and
 * nothing here is a fixed list to be completed — he changes his mind every
 * second, and a reviewer that cannot follow him is a reviewer he stops reading.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Lesson {
	id: string;
	/** The rule, in the shortest form that still bites. */
	rule: string;
	/** His words, verbatim. Never paraphrased — the phrasing is the lesson. */
	said: string;
	/** What actually happened, so a reviewer can recognise the shape again. */
	incident: string;
	/** A shell command that finds this class mechanically, when one exists. */
	check?: string;
	at: string;
}

const HOME = () => process.env.RLM_HOME || join(homedir(), ".rlm");
const FILE = () => join(HOME(), "agent", "lessons.jsonl");

/**
 * Seeded from what went wrong on 2026-09-01/02, in his words.
 *
 * These are not examples. Each one is an incident that cost real hours, and
 * the file is append-only from here — a lesson is never edited to look
 * better, because "we already knew that" is how the same bug ships twice.
 */
export const SEED: Lesson[] = [
	{
		id: "reads-nobody",
		rule: "A value written and read by nobody is a bug, always. Ask of every new field, flag or env var: who reads this?",
		said: "this should never ever have happened with right review gates",
		incident:
			"`--session-id` was parsed and assigned to PRIME_AGENT_SESSION_ID, which nothing read. Every delegated " +
			"retry started from nothing while the flag looked implemented from every angle except the one that mattered.",
		check: "node scripts/gates/written-never-read.mjs <dirs>",
		at: "2026-09-02",
	},
	{
		id: "test-is-not-verification",
		rule:
			"A passing test is not evidence the thing works. Exercise the real path and observe the real effect, or say " +
			"UNVERIFIED. A test encodes the author's idea of the system, and the author's idea is what is wrong.",
		said: "writing test isnt a good way at all to verify something works. we must actually verify it, and so should iris",
		incident:
			"A stall detector guarded on `ready > 0`, where `ready` is derived on load and never written to the journal " +
			"it replayed. The guard could not be true. It stayed silent through 630 attempts and zero completions, and " +
			"its test passed the whole time.",
		at: "2026-09-02",
	},
	{
		id: "success-over-nothing",
		rule:
			"A report that reads like success while nothing happened is worse than an error. Any 'nothing to do' or " +
			"'all clear' must prove it looked.",
		said: "unproven is a task not completed claimed as complete",
		incident:
			"`only: []` is truthy, so the drive selected zero of twenty graphs and printed 'the drive worked everything " +
			"it could'. Every run for a day did nothing and reported success.",
		at: "2026-09-02",
	},
	{
		id: "not-wired",
		rule:
			"Written is not wired. A row in a config, a package on disk, a registered handler — none of it counts until " +
			"something reached it at runtime and you watched it happen.",
		said: "if anything is not wired correctly",
		incident:
			"iris-hmr sat untracked with cordis.yml claiming it as a row; four packages mounted while still answering " +
			"the plugin template's greeting; `approveProposal` has zero callers.",
		at: "2026-09-02",
	},
	{
		id: "redundant",
		rule:
			"Before adding, look for what already does this. Two things claiming the same job is worse than either alone, " +
			"because which one answers becomes an accident.",
		said: "verify absolutely if anything is redundant",
		incident:
			"`search-person` and `person-search` were written two minutes apart with the same triggers; three separate " +
			"fashion-trends skills exist; a bare `{person}` trigger then swallowed every utterance.",
		at: "2026-09-02",
	},
	{
		id: "against-his-prompt",
		rule:
			"Check the change against what he actually asked for, in his words — not against the task title, and not " +
			"against what would be reasonable.",
		said: "see all code changes against my prompt",
		incident:
			"Credentials were built into ~/.rlm when he had asked for ~/.iris; 298 of 324 things he asked for were in " +
			"no graph at all; three YouTube commands became three jobs when he had said they were one.",
		at: "2026-09-02",
	},
	{
		id: "outside-fault",
		rule:
			"Distinguish the work failing from the world refusing to run it. Credits, quota, a missing binary, a broken " +
			"check — none of those are the task's fault and none may spend its attempts.",
		said: "augment balance shouldnt matter",
		incident:
			"24 delegations were recorded as the agent failing when the output was 'You have run out of credits'. " +
			"`auggie` prints that banner and exits 0, so it was logged as a success and handed back as the answer.",
		at: "2026-09-02",
	},
];

export const load = (): Lesson[] => {
	let raw = "";
	try {
		raw = readFileSync(FILE(), "utf8");
	} catch {
		return [...SEED];
	}
	const seen = new Map<string, Lesson>();
	for (const lesson of SEED) seen.set(lesson.id, lesson);
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const lesson = JSON.parse(line) as Lesson;
			if (lesson?.id) seen.set(lesson.id, lesson);
		} catch {
			/* a malformed line must not cost every lesson after it */
		}
	}
	return [...seen.values()];
};

/** A correction becomes a standing check. Append-only, by design. */
export const add = (lesson: Omit<Lesson, "at"> & { at?: string }): Lesson => {
	const full: Lesson = { ...lesson, at: lesson.at ?? new Date().toISOString().slice(0, 10) };
	const file = FILE();
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(full)}\n`, "utf8");
	return full;
};

/**
 * The lessons as a reviewer reads them.
 *
 * His words come first in each entry, deliberately. A rule in my phrasing is
 * something a model will agree with and not apply; a rule in his is one it can
 * hear him saying.
 */
export const brief = (lessons = load()): string =>
	[
		"Every one of these is a thing that already went wrong here, with what he said about it.",
		"They are not a checklist to tick. They are how he looks at code, and the next defect will",
		"be a new instance of one of them rather than a repeat.",
		"",
		...lessons.flatMap((l) => [
			`## ${l.rule}`,
			`He said: "${l.said}"`,
			`It happened: ${l.incident}`,
			...(l.check ? [`Mechanically: ${l.check}`] : []),
			"",
		]),
	].join("\n");

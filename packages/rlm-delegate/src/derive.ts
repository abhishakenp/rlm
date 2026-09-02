/**
 * Reading a criterion out of the request, before anyone is asked for one.
 *
 * `unstated` — nobody said how to tell — is honest, but it should be the last
 * answer rather than the first. A great deal of what arrives here says exactly
 * how it could be checked, in words, and needs no model to notice:
 *
 *   "build me an X plugin"        → the row X reaches ACTIVE
 *   "add a command that does Y"   → Y is in the registry afterwards
 *   "fix the thing in path/Z"     → path/Z is not the file it was
 *   "make `npm test` pass"        → that command exits 0
 *
 * The rules below are deliberately few and deliberately literal. A matcher that
 * ships and covers the obvious cases beats a clever one that never does, and
 * each rule says in words why it fired, so a wrong guess argues with a person
 * rather than hiding behind a machine.
 *
 * What is not attempted: inferring a criterion from tone, from verbs alone, or
 * from anything that would produce a check easy to pass by accident. A
 * criterion that passes when the work did not happen is worse than no criterion
 * at all — it is the original bug with a certificate. When nothing here is
 * confident, the answer is `null`, which becomes a question for a person.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Proof } from "./graph.ts";

export interface Derived {
	proof: Proof;
	/** Said in words, because a person may need to disagree with it. */
	why: string;
}

/**
 * Backticked or quoted spans, longest first — the asker's own emphasis.
 *
 * Backticks are read separately from quotes, because a backticked command very
 * often contains quotes of its own (`iris recall.match text="..."`) and a single
 * character class stops at the first inner quote, handing back a truncated
 * fragment that looks like a command and is not one.
 */
const quoted = (text: string): string[] => {
	const found = [
		...[...text.matchAll(/`([^`\n]{2,160})`/g)].map((m) => m[1]),
		...[...text.matchAll(/"([^"\n]{2,160})"/g)].map((m) => m[1]),
		...[...text.matchAll(/'([^'\n]{2,160})'/g)].map((m) => m[1]),
	].map((v) => v.trim());
	return [...new Set(found)].sort((a, b) => b.length - a.length);
};

/**
 * A template, not a command.
 *
 * Found the hard way against five real delegations: Iris's standard preamble
 * carries a checklist containing `iris recall.match text="…"`, which is an
 * instruction to the agent about how to finish, not a command anyone could run.
 * Deriving from it produced a confidently wrong criterion on every single
 * request — five turns that would have been marked failed for the wrong reason.
 * A placeholder is the clearest signal that a span is illustrative, and an
 * illustrative span is worth strictly less than admitting nobody said.
 */
const PLACEHOLDER = /(…|\.\.\.|<[^>]*>|\{[^}]*\}|\[[^\]]*\]|[=:]\s*$|\bTODO\b)/;

const RUNNER = /^(npm|npx|bun|bunx|node|pnpm|yarn|make|cargo|pytest|python3?|go|git|rlm|iris|sh|bash|\.\/)\b/;
const VERIFIABLE = /\b(pass(es|ing)?|exits? 0|succeeds?|green|works?|returns?|prove[sn]?)\b/i;

/** A plugin/package name: kebab-case, at least two characters, no spaces. */
const NAMEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A command or tool name: `thing.method`, `thing:method`. */
const COMMANDY = /^[a-z][a-z0-9_-]*(?:[.:][a-z][a-z0-9_-]*)+$/i;

/** `index.ts` has the same shape as `dirsize.of` and is not a command. */
const EXTENSION = /\.(ts|tsx|js|mjs|cjs|jsx|json|md|py|sh|txt|ya?ml|html|css|toml|lock|log)$/i;
const commandLike = (token: string): boolean =>
	COMMANDY.test(token) && !EXTENSION.test(token) && !token.includes("/") && !PLACEHOLDER.test(token);

/** Something that looks like a path, and turns out to be one. */
const pathsIn = (text: string, cwd: string): string[] =>
	[...text.matchAll(/(?:^|[\s(`'"])((?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+\.?[\w]*)/g)]
		.map((m) => m[1])
		.filter((p) => p.includes("/") && !p.endsWith("/"))
		.map((p) => (isAbsolute(p) || p.startsWith("~") ? p.replace(/^~/, process.env.HOME ?? "~") : resolve(cwd, p)))
		.filter((p, i, all) => all.indexOf(p) === i);

/**
 * The best criterion the request itself supports, or null.
 *
 * Rules run in order of how badly you would want to be wrong about them: an
 * explicitly quoted command the asker said should pass is nearly their own
 * words, while a path mentioned in passing is a guess.
 */
export const derive = (
	request: string,
	options: { cwd?: string; now?: string } = {},
): Derived | null => {
	const text = String(request ?? "");
	if (!text.trim()) return null;

	/**
	 * Only read a criterion out of something short enough to be an ask.
	 *
	 * Three rounds of whack-a-mole against real traffic taught this one. Iris's
	 * standard preamble runs to a hundred lines and is full of example commands
	 * — `iris plugin.new`, `iris plugin.revert`, `iris recall.match text="…"` —
	 * each of them an instruction about how to work, none of them a criterion.
	 * Every guard that removed one just promoted the next, because the problem
	 * was never the individual rule: pattern-matching emphasis markers inside a
	 * document written to instruct is reading someone else's mail.
	 *
	 * A person asking for something writes a line or two. A request this long is
	 * a template, and the honest answer to a template is that nobody said how to
	 * tell — which becomes a question, which is what he asked for. It is also
	 * the request most in need of being broken into several tasks anyway, and
	 * `refine()` is where that happens with a model that can actually read it.
	 */
	const ASK = 600;
	if (text.length > ASK) return null;
	const cwd = options.cwd ?? process.cwd();
	const now = options.now ?? new Date().toISOString();
	const spans = quoted(text);

	// 1. A command the asker themselves said should pass. Closest thing to being
	//    told the criterion outright — but only when the two are next to each
	//    other. Testing the cue against the whole request was wrong and real
	//    traffic proved it: Iris's preamble runs to a hundred lines, somewhere in
	//    it something always says "works", and every delegation came back with a
	//    criterion lifted out of an unrelated checklist. A command mentioned in
	//    "if it goes wrong, run `iris plugin.revert`" is the opposite of a
	//    criterion. So the cue has to sit within a sentence of the command.
	const command = spans.find((span) => {
		if (!RUNNER.test(span) || !span.includes(" ") || PLACEHOLDER.test(span)) return false;
		const at = text.indexOf(span);
		if (at === -1) return false;
		const near = text.slice(Math.max(0, at - 70), at + span.length + 70);
		return VERIFIABLE.test(near) && !/\b(if|unless|otherwise|revert|undo|roll ?back|on failure)\b/i.test(near);
	});
	if (command) {
		return {
			proof: { kind: "shell", run: command },
			why: `the request says \`${command}\` should work, so that is the criterion`,
		};
	}

	// 2. A plugin, row or capability to be mounted. `rlm-plugins` mounts a
	//    package as a row named after it minus any `rlm-` prefix, so the row id
	//    is not a guess. ACTIVE is the part that matters: a scaffold written to
	//    disk and never mounted was exactly how a capability got announced that
	//    did not exist.
	if (/\b(plugin|row|mount(ed|s)?|capability)\b/i.test(text)) {
		// A name built here becomes a package under `packages/`, so the row id
		// follows even when the name is Iris-flavoured. A request to mount
		// something into a *different* composition would fail this check loudly,
		// which is the right way round: loud beats a turn that reads like success.
		const name = spans.find((s) => NAMEY.test(s) && !PLACEHOLDER.test(s)) ?? text.match(/\b((?:rlm|iris)-[a-z0-9-]+)\b/)?.[1];
		if (name) {
			const row = name.replace(/^rlm-/, "");
			return {
				proof: { kind: "row", id: row, state: "ACTIVE" },
				why: `it asks for a plugin, so the row \`${row}\` has to actually reach ACTIVE — written to disk is not mounted`,
			};
		}
	}

	// 3. A command or tool that must exist afterwards. The dirsize case: the
	//    scaffold mounted, the command never appeared, and the turn said Done.
	if (/\b(command|tool|slash ?command|so (i|we) can (run|call)|expose)\b/i.test(text)) {
		// Unquoted too: people write `dirsize.of` without backticks far more often
		// than they remember to add them.
		const bare = [...text.matchAll(/\b([a-z][a-z0-9_-]*(?:[.:][a-z][a-z0-9_-]*)+)\b/gi)].map((m) => m[1]);
		const name = [...spans, ...bare].find(commandLike);
		if (name) {
			return {
				proof: { kind: "command", name },
				why: `it asks for a command, so \`${name}\` has to be in the registry afterwards`,
			};
		}
	}

	// 4. A file that must change. Weaker, so it needs the path to be real and
	//    the verb to be about altering it. `changedSince` is what makes it worth
	//    having: nobody satisfies it by leaving the file exactly as it was.
	const candidates = pathsIn(text, cwd);
	const existing = candidates.find((p) => existsSync(p));
	if (existing && /\b(fix|repair|edit|change|update|refactor|rewrite|patch|correct|improve)\b/i.test(text)) {
		return {
			proof: { kind: "file", path: existing, changedSince: now },
			why: `it asks for a change to ${existing}, so that file has to be different afterwards`,
		};
	}
	const missing = candidates.find((p) => !existsSync(p));
	if (missing && /\b(create|write|add|generate|scaffold|new)\b/i.test(text)) {
		return {
			proof: { kind: "file", path: missing },
			why: `it asks for ${missing} to be created, so that file has to exist afterwards`,
		};
	}

	// Nothing here was confident. That is a question, not a conclusion.
	return null;
};

/** The question to put to a person when nothing could be derived. */
export const question = (title: string): string =>
	`How will we know "${title}" is done? Name a command that exits 0, a file that must exist or change, ` +
	`a row that must reach ACTIVE, or a command that must be in the registry.`;

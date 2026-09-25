/**
 * Criteria the agent can make true by writing the thing that answers them.
 *
 * ## What happened
 *
 * On 2026-09-02 four delegated children were handed criteria of the shape
 * `iris <something> | grep -q '<string>'`. None of them could make the real
 * `iris` say that string. Each of them worked out — correctly, from inside the
 * task — that a criterion which runs a *name* is satisfied by putting a
 * different program under that name, and wrote one. `/opt/homebrew/bin/iris`
 * became a bash `case` statement that printed `{"daemon":"connected"}` whether
 * or not any daemon was connected; `~/.local/bin/iris` became a three-line shim
 * into a different CLI. Twenty seconds later each child ran its own criterion,
 * watched it pass, and reported success.
 *
 * `rlm-guard`'s PATH-directory protection now refuses those writes at the door,
 * and it should stay. But the door is the symptom's end of the problem. The
 * cause is upstream, in `refine.ts`: the planner is allowed to write a
 * criterion whose oracle the doer controls, and no screen looks at that.
 *
 * ## The property, stated once
 *
 * A criterion is **forgeable** when the agent can make the oracle say yes
 * *without the underlying thing being true*.
 *
 * That is not a property of the command text. `iris notify.status | grep -q
 * '"running"'` is forgeable when the fleet can write whatever `iris` resolves
 * to, and is sound when it cannot. So forgeability is a property of the
 * **pair** — the oracle, and what the actor may write — and it can only be
 * decided by resolving the oracle against this machine. That is what this file
 * does, and it is why there is no regex here that matches the word `grep`.
 * `grep` is not the problem and never was; `grep` reading bytes the agent
 * authored is.
 *
 * ## Where independence actually comes from
 *
 * Not from the criterion being hard. From at least one link in the chain that
 * produces the verdict lying outside the actor's reach. Ways a link is outside
 * reach, all decidable here:
 *
 *   - it is a system binary, under a directory the operating system owns;
 *   - it is inside a directory `rlm-guard` seals — every PATH directory outside
 *     the repo, plus `~/.local/bin` and `/opt/homebrew/bin` — where a write is
 *     refused at the door;
 *   - the criterion observes a *file's contents* rather than a *program's
 *     behaviour*, which is the `kind: "file"` case and has its own screens
 *     (`changedSince`, `alreadyTrue`).
 *
 * And four ways a link is inside reach:
 *
 *   - **absent** — the name resolves to nothing. This is the worst one and it
 *     is the one that actually fired: `discover-iris-commands` recorded
 *     `inertIf: "/bin/sh: iris: command not found"`, so the only way that check
 *     could ever go green was for something to appear under that name. A
 *     criterion naming a program which does not exist is not a check on the
 *     work, it is an instruction to build an oracle.
 *   - **rebindable** — it resolves, but to somewhere nothing seals, so it can
 *     be overwritten.
 *   - **delegating** — it resolves *into* a sealed directory, and the sealed
 *     file is a thin launcher that hands straight over to a tree the fleet
 *     edits all day. Measured, not supposed: both `iris` entries on this
 *     machine are now one line, `exec
 *     /Users/abhi/proj/sensei/iris-mama/packages/iris-cli/bin/iris "$@"`. The
 *     guard seals the *name* and buys nothing about the *behaviour*, so a
 *     screen that stopped at "it is in a sealed directory" would clear the
 *     exact criterion class that started all this.
 *   - **self-produced** — the bytes being matched are a literal in the command
 *     itself (`echo 'skill' | grep -q 'skill'`). `alreadyTrue` catches these
 *     only while they pass today; one behind a step that fails today slips
 *     through it and not through here.
 *
 * ## What it deliberately does not flag
 *
 * A criterion that reads a *file* — `grep -q X somefile`, `cat f | grep X`. The
 * head of that chain is `grep` or `cat`, both system-owned, and the thing being
 * observed is bytes on disk, which is what `kind: "file"` is for. Flagging
 * those would flag most honest criteria in the graphs and the screen would be
 * worth nothing.
 *
 * And a criterion that runs repo code through a sound interpreter — `node -e
 * "require('./packages/x/dist/index.js')"`, `bun test`. The instrument is the
 * workpiece there too, and that is a real hole, stated rather than closed:
 * closing it flags every test-shaped criterion in the tree, which is a screen
 * that says no to everything and therefore says nothing.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, resolve, sep } from "node:path";
import type { Proof, TaskInput } from "./graph.ts";

/** How a criterion's oracle can be got at. */
export type Grip =
	/** The name resolves to nothing, so passing it requires creating it. */
	| "absent"
	/** It resolves somewhere nothing seals, so it can be overwritten. */
	| "rebindable"
	/** It resolves into a sealed directory, and hands straight to one that is not. */
	| "delegating"
	/** The bytes being matched are a literal in the criterion itself. */
	| "self-produced";

export interface Forgery {
	/** The task whose criterion this is. */
	id: string;
	/** How it can be got at. */
	grip: Grip;
	/** The program (or literal) the verdict rests on. */
	oracle: string;
	/**
	 * Where it lands. Absolute path for `rebindable`; the chain's writable end
	 * for `delegating`; empty for `absent` and `self-produced`.
	 */
	lands: string;
	/** One sentence, for the refusal handed back to the planner. */
	why: string;
}

/**
 * What the actor cannot write.
 *
 * Derived the same way `rlm-guard` derives it, and deliberately not imported
 * from it: `@rlm/delegate` depends on cordis and nothing else, and `agent.ts`
 * already settles this question for the fence — take the shape, not the
 * dependency. If the guard's list moves, this drifts, and the drift is safe in
 * the direction that matters: a directory this thinks is sealed and is not
 * produces a missed forgery, which is the status quo, while nothing here can
 * invent a sealed directory that PATH does not name.
 */
export interface Reach {
	/** Absolute directories whose contents the fleet may not write. */
	sealed: string[];
	/** Where a bare name is looked up, in order. */
	lookup: string[];
	home: string;
	/** The tree the fleet works in. Its PATH entries are not sealed. */
	root: string;
}

/**
 * Owned by the operating system. Under SIP on macOS, so not writable by the
 * user and not writable by root either.
 */
const SYSTEM_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/libexec", "/System", "/usr/local/bin"];

/** Sealed by `rlm-guard` whether or not PATH names them. See INHERENT_PATH_DIRS there. */
const INHERENT_DIRS = ["~/.local/bin", "/opt/homebrew/bin"];

const posix = (p: string): string => p.split(sep).join("/");

const expandHome = (path: string, home: string): string =>
	path
		.replace(/^~(?=\/|$)/, home)
		.replace(/^\$\{HOME\}(?=\/|$)/, home)
		.replace(/^\$HOME(?=\/|$)/, home);

const unquote = (token: string): string => token.replace(/^['"]|['"]$/g, "");

export const reachOf = (options: { path?: string; root?: string; home?: string } = {}): Reach => {
	const home = options.home ?? homedir();
	const root = resolve(options.root ?? process.cwd());
	const raw = options.path ?? process.env.PATH ?? "";
	const lookup: string[] = [];
	for (const entry of raw.split(delimiter)) {
		const trimmed = unquote(entry.trim()).replace(/\/+$/, "");
		if (!trimmed || !isAbsolute(trimmed)) continue;
		const abs = real(resolve(trimmed));
		if (!lookup.includes(abs)) lookup.push(abs);
	}
	const sealed = SYSTEM_DIRS.map((dir) => real(dir));
	for (const dir of INHERENT_DIRS) {
		const abs = real(resolve(expandHome(dir, home)));
		if (!sealed.includes(abs)) sealed.push(abs);
	}
	for (const abs of lookup) {
		// Inside the repo is exactly what the fleet is for, and `node_modules/.bin`
		// is rewritten by every install. Neither is sealed.
		if (posix(abs) === posix(root) || posix(abs).startsWith(`${posix(root)}/`)) continue;
		if (!sealed.includes(abs)) sealed.push(abs);
	}
	// The installation, not just its doorway.
	//
	// `git` on PATH is `/opt/homebrew/bin/git`, a symlink to
	// `/opt/homebrew/Cellar/git/2.49.0/bin/git`; `npm` is a symlink into
	// `…/node-versions/v20.20.2/installation/lib/node_modules/npm/`. Resolving
	// the symlink — which has to happen, see `whichIs` — walks straight out of
	// the sealed directory into the same prefix, and a screen that stopped at
	// the doorway would then call every homebrew and every node tool writable
	// and flag every honest criterion in the tree.
	//
	// A PATH directory called `bin` is the entry point of an installation
	// prefix, and the prefix is the unit: the fleet has no business anywhere
	// inside one. The home directory and the root are never prefixes, because
	// sealing either would seal everything.
	for (const abs of [...sealed]) {
		const name = basename(abs);
		if (name !== "bin" && name !== "sbin") continue;
		const prefix = dirname(abs);
		if (prefix === "/" || prefix === home || prefix === root) continue;
		if (posix(prefix) === posix(root) || posix(prefix).startsWith(`${posix(root)}/`)) continue;
		if (!sealed.includes(prefix)) sealed.push(prefix);
	}
	return { sealed, lookup, home, root };
};

const within = (abs: string, dir: string): boolean => abs === dir || abs.startsWith(`${dir}/`);

/**
 * The path with every symlink taken out of it.
 *
 * macOS hands out `/var/folders/…` and `realpath` gives `/private/var/folders/…`,
 * and `~/.local/state/fnm_multishells/…` is a symlink farm. A sealed directory
 * recorded under one spelling and a program resolved under the other do not
 * compare equal, and the screen then calls an installed tool writable. Both
 * ends go through here so there is only ever one spelling.
 */
const real = (abs: string): string => {
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
};

const isSealed = (abs: string, reach: Reach): boolean => reach.sealed.some((dir) => within(abs, dir));

const isFile = (abs: string): boolean => {
	try {
		return statSync(abs).isFile();
	} catch {
		return false;
	}
};

/* ────────────────────────── reading the command ────────────────────────── */

export interface Segment {
	/** Word tokens, quotes stripped. */
	words: string[];
	/** True when this segment is the first of its clause — the one being observed. */
	head: boolean;
	/**
	 * True when a `|` follows it, so something downstream reads what it printed.
	 *
	 * Needed to tell `echo X | grep X` — the criterion comparing itself with
	 * itself — from `… && echo 'Tests passed'`, which is a trailing courtesy
	 * that decides nothing. Asking whether the *whole command* contained a pipe
	 * confused the two and flagged an honest criterion.
	 */
	pipedInto: boolean;
}

/**
 * One shell command, split at `&&`, `||`, `;` and newlines, then at `|`, with
 * quotes respected.
 *
 * Deliberately small, and it must never grow into a shell parser. It exists to
 * answer one question — which programs does this run, and which of them is
 * being observed rather than reading — well enough to be right on the criteria
 * actually in the graphs.
 */
export const segments = (command: string): Segment[] => {
	const out: Segment[] = [];
	let words: string[] = [];
	let word = "";
	let head = true;
	let quote: '"' | "'" | null = null;
	let depth = 0;

	const endWord = () => {
		if (word) words.push(word);
		word = "";
	};
	const endSegment = (nextHead: boolean, pipedInto = false) => {
		endWord();
		if (words.length) out.push({ words, head, pipedInto });
		words = [];
		head = nextHead;
	};

	for (let i = 0; i < command.length; i++) {
		const c = command[i] as string;
		if (quote) {
			if (c === quote) quote = null;
			else word += c;
			continue;
		}
		if (c === "\\" && i + 1 < command.length) {
			word += command[i + 1];
			i += 1;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		// `$( … )` holds a whole command of its own. Kept intact as one word here
		// and unwrapped by `commandsIn`, so a program only ever reachable through
		// a substitution — `TEXT=$(iris ears transcribe …)` — is still seen.
		if (c === "$" && command[i + 1] === "(") {
			let j = i + 2;
			let inner = 1;
			while (j < command.length && inner > 0) {
				if (command[j] === "(") inner++;
				else if (command[j] === ")") inner--;
				if (inner > 0) j++;
			}
			word += command.slice(i, j + 1);
			i = j;
			continue;
		}
		if (c === "(" || c === ")") {
			depth += c === "(" ? 1 : -1;
			endWord();
			continue;
		}
		if (depth === 0) {
			if (c === "&" && command[i + 1] === "&") {
				endSegment(true);
				i += 1;
				continue;
			}
			if (c === "|" && command[i + 1] === "|") {
				endSegment(true);
				i += 1;
				continue;
			}
			if (c === "|") {
				endSegment(false, true);
				continue;
			}
			if (c === ";" || c === "\n") {
				endSegment(true);
				continue;
			}
		}
		if (c === " " || c === "\t") {
			endWord();
			continue;
		}
		word += c;
	}
	endSegment(true);
	return out;
};

/** Every command text in here, including the ones inside `$( … )` and backticks. */
export const commandsIn = (command: string, seen = new Set<string>()): string[] => {
	if (seen.has(command) || seen.size > 24) return [];
	seen.add(command);
	const out = [command];
	for (const match of command.matchAll(/\$\(([\s\S]*?)\)/g)) out.push(...commandsIn(match[1] as string, seen));
	for (const match of command.matchAll(/`([^`]*)`/g)) out.push(...commandsIn(match[1] as string, seen));
	return out;
};

/**
 * Wrappers that run something else, and shell words that are not programs.
 *
 * `cd` is here because a clause that only changes directory observes nothing;
 * `test` and `[` because they read the filesystem rather than run a program.
 */
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nice", "nohup", "xargs", "builtin"]);
const NOT_A_PROGRAM = new Set([
	"cd", "test", "[", "[[", ":", "true", "false", "export", "set", "unset", "read", "exit", "return",
	"source", ".", "wait", "local", "eval", "shift", "trap", "then", "else", "fi", "do", "done", "if", "while", "for",
]);
/** Emits its own argument. The one case where the literal is the producer. */
const EMITTERS = new Set(["echo", "printf", "yes"]);

/** The program a segment runs, or null when it runs none. */
export const programOf = (words: string[]): string | null => {
	for (const word of words) {
		if (!word || word === "!") continue;
		// `FOO=bar cmd` — an assignment prefix, not the program.
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
		if (word.startsWith("-")) continue;
		if (WRAPPERS.has(word)) continue;
		return word;
	}
	return null;
};

/* ────────────────────────── resolving the oracle ────────────────────────── */

/**
 * Where a bare name lands on this machine, or null when nothing is there.
 *
 * **Through the symlink, always.** A sealed directory full of symlinks seals
 * nothing, and that is not hypothetical here: `/opt/homebrew/bin/rlm` is a
 * symlink to `/Users/abhi/proj/rlm/cordis-shell.mjs` and
 * `/opt/homebrew/bin/pixel` to a build artifact in another checkout. Both
 * sit in the directory the guard protects and both are one `ln -s` away from
 * whatever the fleet likes. Stopping at the link would have called the single
 * most forgeable oracle on the machine sound — measured, on this tree, before
 * this line existed.
 */
export const whichIs = (name: string, reach: Reach): string | null => {
	const bare = unquote(name);
	if (!bare) return null;
	if (bare.includes("/")) {
		const abs = resolve(reach.root, expandHome(bare, reach.home));
		return isFile(abs) ? real(abs) : null;
	}
	for (const dir of reach.lookup) {
		const abs = resolve(dir, bare);
		if (isFile(abs)) return real(abs);
	}
	return null;
};

/**
 * Follow a thin launcher to the thing it actually runs.
 *
 * A sealed one-line `exec /somewhere/else "$@"` gives no independence at all —
 * the name is protected and the behaviour is wherever the exec points. This
 * walks that, and stops the moment a file is not a small text launcher, so a
 * real program is never mistaken for a hop.
 */
export const launchesInto = (abs: string, reach: Reach, depth = 0): string | null => {
	if (depth > 4) return null;
	let text: string;
	try {
		if (statSync(abs).size > 8192) return null;
		text = readFileSync(abs, "utf8");
	} catch {
		return null;
	}
	if (!text.startsWith("#!")) return null;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (!/^exec\b/.test(trimmed) && !/\$@/.test(trimmed)) continue;
		// The first absolute path on the line is the thing being handed to.
		const target = trimmed.match(/(?:^|\s)((?:~|\$HOME|\$\{HOME\}|\/)[^\s'"`;|&]+)/);
		if (!target) continue;
		const next = resolve(expandHome(unquote(target[1] as string), reach.home));
		if (!isFile(next)) continue;
		return launchesInto(next, reach, depth + 1) ?? next;
	}
	return null;
};

/** How this one program can be got at, or null when it cannot. */
export const gripOn = (name: string, reach: Reach): { grip: Grip; lands: string } | null => {
	const abs = whichIs(name, reach);
	if (!abs) return { grip: "absent", lands: "" };
	if (!isSealed(abs, reach)) return { grip: "rebindable", lands: abs };
	const into = launchesInto(abs, reach);
	if (into && !isSealed(into, reach)) return { grip: "delegating", lands: into };
	return null;
};

/* ────────────────────────── the screen ────────────────────────── */

const say = (grip: Grip, oracle: string, lands: string): string => {
	switch (grip) {
		case "absent":
			return `\`${oracle}\` is not on PATH here, so the only way this check can ever go green is for somebody to put something under that name — that is a check on the name, not on the work`;
		case "rebindable":
			return `\`${oracle}\` is ${lands}, which nothing stops the agent rewriting, so it can make this check say yes by changing what answers it`;
		case "delegating":
			return `\`${oracle}\` is protected where it sits but is only a launcher into ${lands}, which the fleet edits, so the protection buys nothing about what it prints`;
		case "self-produced":
			return `the bytes this matches are written in the command itself (${oracle}), so it is comparing the criterion with itself`;
	}
};

/**
 * The same judgement on one criterion. Exported so a sweep can reuse it.
 *
 * At most one finding — the planner has to rewrite the criterion whichever link
 * is the weak one, and four objections about one command read as four problems.
 */
export const forgeryIn = (proof: Proof | undefined, reach: Reach = reachOf()): Omit<Forgery, "id"> | null => {
	if (!proof) return null;

	// A criterion that asserts the contents of a file *on PATH* is the hijack
	// wearing the other hat: "`~/.local/bin/iris` contains connected" is made
	// true by writing that file, and writing that file is the incident.
	if (proof.kind === "file") {
		const abs = resolve(expandHome(unquote(proof.path), reach.home));
		if (isSealed(abs, reach) && reach.lookup.some((dir) => within(abs, dir))) {
			return {
				grip: "rebindable",
				oracle: proof.path,
				lands: abs,
				why: `${proof.path} is a command on PATH, and a criterion about what is inside a command file is made true by writing that command file — which is the hijack itself`,
			};
		}
		return null;
	}

	if (proof.kind !== "shell") return null;

	for (const command of commandsIn(proof.run)) {
		for (const segment of segments(command)) {
			const program = programOf(segment.words);
			if (!program) continue;
			if (NOT_A_PROGRAM.has(program)) continue;
			if (EMITTERS.has(program)) {
				// Only when something downstream is reading it. `… && echo FOUND`
				// at the end of a clause decides nothing and is not a forgery.
				if (segment.pipedInto) {
					const shown = segment.words.join(" ").slice(0, 120);
					return { grip: "self-produced", oracle: shown, lands: "", why: say("self-produced", shown, "") };
				}
				continue;
			}
			// Only the head of a clause is *observed*. The stages after a pipe are
			// reading what the head produced — `grep`, `jq`, `head` — and judging
			// them would flag every criterion that reads a file.
			if (!segment.head) continue;
			const grip = gripOn(program, reach);
			if (!grip) continue;
			return { grip: grip.grip, oracle: program, lands: grip.lands, why: say(grip.grip, program, grip.lands) };
		}
	}
	return null;
};

/**
 * Every criterion in this plan whose oracle the doer controls.
 *
 * Third member of the family in `refine.ts`, alongside `alreadyTrue` (a check
 * that passes before anybody starts) and `ephemeral` (a check that points
 * somewhere which will not exist next time). Same shape, same moment, same
 * consequence: the plan is handed back carrying the exact objection.
 */
export const forgeable = (tasks: TaskInput[], reach: Reach = reachOf()): Forgery[] => {
	const found: Forgery[] = [];
	for (const task of tasks) {
		const hit = forgeryIn(task.proof, reach);
		if (hit) found.push({ id: task.id, ...hit });
	}
	return found;
};

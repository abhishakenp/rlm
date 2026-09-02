/**
 * The door: does this code cell write a protected file?
 *
 * ## What this is and is not
 *
 * It is a heuristic, and it is written down here as one so that nobody later
 * mistakes it for a sandbox. The agent's `code` tool runs arbitrary JavaScript
 * in a vm with `execSync` in scope, as the same user, with the same filesystem
 * permissions as rlm itself. Nothing in this file can stop a determined
 * adversary — `require("fs")["write" + "FileSync"]` defeats it in one line, and
 * so does a compiled helper, and so does `bash -c "$(echo ... | base64 -d)"`.
 *
 * What it can do — and what actually matters, because the thing on the other
 * side is a language model doing its job and not an attacker — is refuse every
 * shape an agent actually produces when it decides the resource limiter is
 * wrong and sets out to fix it. That is `sed -i`, a redirect, a heredoc, `tee`,
 * `cp`/`mv`, `patch`, `git checkout`, `fs.writeFileSync`, and the same again
 * with the path held in a variable. All of those are caught. The backstop for
 * everything else is layer 2 in `restore.ts`, which does not care how the file
 * changed.
 *
 * ## Reads stay open
 *
 * The agent has to be able to read `capacity.ts` — it should be able to reason
 * about the limiter, disagree with it, and say so. So a cell that only reads is
 * never refused. The consequence, deliberately accepted: a cell that reads a
 * protected file *and* writes something else is refused too, because once the
 * path is in scope as a value there is no honest way to tell which write is
 * pointed at it. The refusal says to split the two, which costs the agent one
 * extra cell.
 *
 * ## How a write site is judged
 *
 * Each site gets a target classification:
 *
 *   - `protected`     — a literal in the target position names a protected file.
 *   - `elsewhere`     — the target is literal and is not a protected file.
 *   - `unknown`       — the target is a variable, an interpolation, a
 *                       concatenation: something this file cannot evaluate.
 *
 * Any `protected` site refuses. An `unknown` site refuses only when the cell
 * names a protected file somewhere — which is what catches indirection through
 * a variable without refusing every dynamic write in the repository.
 */
import type { ProtectedFile } from "./protect.ts";
import { dirTargeted, namedIn } from "./protect.ts";

export interface Refusal {
	block: true;
	reason: string;
	/** The protected file this cell was pointed at. */
	file: ProtectedFile;
	/** Whether the target was named outright or reached through a variable. */
	how: "direct" | "indirect";
	/** The fragment of the cell that decided it, for the log. */
	evidence: string;
}

type Target = { kind: "protected"; file: ProtectedFile } | { kind: "elsewhere" } | { kind: "unknown" };

/* ────────────────────────── shell regions ────────────────────────── */

/**
 * The parts of a cell that reach a shell.
 *
 * Only three routes exist, and knowing them is what keeps `if (a > b)` in
 * ordinary JavaScript from being read as a redirect: `%%bash` at offset zero
 * (the kernel recognises it nowhere else), a line starting with `!`, and an
 * `exec`-family call, whose whole argument list is taken as shell text so that
 * `execFileSync("sed", ["-i", ...])` is covered as well as `execSync("sed -i …")`.
 */
export const shellRegions = (code: string): string[] => {
	const out: string[] = [];
	const bash = code.match(/^[ \t]*%%bash\b[^\n]*\n([\s\S]*)$/);
	if (bash) out.push(bash[1] as string);
	for (const line of code.split("\n")) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("!")) out.push(trimmed.slice(1));
	}
	const call = /\b(?:execSync|execFileSync|exec|execFile|spawnSync|spawn|\$)\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = call.exec(code))) {
		const args = balanced(code, m.index + m[0].length - 1);
		// The shell text is inside JavaScript quoting, and the quoting is not
		// part of the command. `execSync("sed -i '' … path")` and
		// `execFileSync("sed", ["-i", "", …, "path"])` are the same call; joining
		// the literals makes them the same string here too.
		const literals = literalsIn(args);
		out.push(literals.length ? literals.join(" ") : args);
		// A command assembled from a variable keeps its raw form as well, so the
		// interpolation is still visible to the unknown-target rule.
		if (/[$`]/.test(args)) out.push(args);
	}
	// `$\`…\`` / Bun.$`…` — a template, not a call.
	for (const t of code.matchAll(/\$`([^`]*)`/g)) out.push(t[1] as string);
	return out;
};

/** The text between `code[open]` (a `(`) and its matching `)`, or to the end. */
const balanced = (code: string, open: number): string => {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		const c = code[i];
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return code.slice(open + 1, i);
		}
	}
	return code.slice(open + 1);
};

/* ────────────────────────── shell writes ────────────────────────── */

/**
 * Commands that write. `sed`, `perl` and `awk` only count with their in-place
 * flag; everything else counts whenever it is the head of a segment.
 */
const WRITE_BINS = new Set([
	"tee",
	"cp",
	"mv",
	"rm",
	"rmdir",
	"ln",
	"install",
	"patch",
	"dd",
	"truncate",
	"touch",
	"chmod",
	"chown",
	"shred",
	"sponge",
	"mkdir",
	"unlink",
]);

/** `git <sub>` that puts bytes on disk. `reset` is gitpixel's to refuse; named here too. */
const GIT_WRITES = new Set(["checkout", "restore", "apply", "reset", "clean", "stash", "rm", "mv"]);

/**
 * Split a shell region into command segments — pipelines, lists, lines.
 *
 * A heredoc body stays glued to the command that opened it. `python3 - <<PY`
 * names no path on its own line; the path is three lines down inside the
 * program, and splitting on newlines is how that walks through.
 */
/**
 * Split one line on `;`, `|`, `&&`, `||` — but not inside quotes.
 *
 * This is not pedantry. `sed -i '' 's/floor ?? 0.3;/floor ?? 0.0;/' path` has a
 * semicolon inside the sed script, and a naive split turns one write command
 * into two fragments, neither of which has `sed` at its head. Measured: that
 * exact cell walked straight through an earlier version of this file.
 */
const splitOperators = (line: string): string[] => {
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i] as string;
		if (quote) {
			current += c;
			if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			current += c;
			continue;
		}
		if (c === ";" || c === "|" || c === "&") {
			// `&&`, `||` and `|` all end a command; a lone `&` backgrounds it.
			if ((c === "|" || c === "&") && line[i + 1] === c) i++;
			out.push(current);
			current = "";
			continue;
		}
		current += c;
	}
	out.push(current);
	return out;
};

export const segments = (region: string): string[] => {
	const lines = region.split("\n");
	const chunks: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const here = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/);
		if (!here) {
			for (const part of splitOperators(line)) chunks.push(part);
			continue;
		}
		const delimiter = here[2] as string;
		const body: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			if ((lines[j] as string).trim() === delimiter) break;
			body.push(lines[j] as string);
		}
		// One segment, operators and all: the body is data, not a command list.
		chunks.push([line, ...body].join("\n"));
		i = j;
	}
	return chunks.map((c) => c.trim()).filter(Boolean);
};

const tokens = (segment: string): string[] => segment.match(/(?:"[^"]*"|'[^']*'|\S)+/g) ?? [];

const unquote = (t: string): string => t.replace(/^['"]|['"]$/g, "").replace(/^['"]|['"]$/g, "");

/** Does this segment reach for a value this file cannot evaluate? */
const interpolated = (text: string): boolean => /[$`]/.test(text);

/**
 * Every write target this shell segment has, as classified targets.
 *
 * Redirections are found first because they can hang off any command, then the
 * head of the segment decides whether its operands are targets too.
 */
const shellTargets = (segment: string, root: string, files: ProtectedFile[]): Target[] => {
	const out: Target[] = [];
	const classify = (text: string): Target => {
		const hit = namedIn(text, files) ?? dirTargeted(text, root, files);
		if (hit) return { kind: "protected", file: hit };
		return interpolated(text) ? { kind: "unknown" } : { kind: "elsewhere" };
	};

	// Redirection: `> f`, `>> f`, `2> f`, `&> f`, `>| f`. Not `2>&1`, not `<`.
	for (const r of segment.matchAll(/(?:^|\s)(?:\d*|&)>{1,2}\|?\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g)) {
		const target = r[1] as string;
		if (target.startsWith("&")) continue;
		out.push(classify(target));
	}

	const parts = tokens(segment);
	// Skip leading `VAR=value` assignments and `sudo`/`env`.
	let i = 0;
	while (i < parts.length && (/^[A-Za-z_][\w]*=/.test(parts[i] as string) || parts[i] === "sudo" || parts[i] === "env"))
		i++;
	const head = unquote(parts[i] ?? "").replace(/^.*\//, "");
	const rest = parts.slice(i + 1);
	if (!head) return out;

	const operandsAreTargets =
		WRITE_BINS.has(head) ||
		(/^g?sed$/.test(head) && rest.some((t) => /^-[a-zA-Z]*i/.test(t) || t === "--in-place")) ||
		(/^perl$/.test(head) && rest.some((t) => /^-[a-zA-Z]*i/.test(t))) ||
		(/^g?awk$/.test(head) && rest.some((t) => /inplace/.test(t))) ||
		(head === "git" && GIT_WRITES.has(unquote(rest[0] ?? ""))) ||
		// An interpreter handed a program is a write in disguise: `python - <<EOF`,
		// `node -e "fs.writeFileSync(…)"`. The program text is scanned as JS by the
		// caller anyway; here it is enough that its operands are suspect.
		(/^(?:python3?|node|bun|ruby|perl|php|osascript)$/.test(head) &&
			rest.some((t) => /^-(?:e|c)$/.test(t) || t.startsWith("<<")));

	const carriesAProgram =
		/^(?:python3?|node|bun|ruby|perl|php|osascript|sh|bash|zsh)$/.test(head) || /<<-?\s*['"]?[A-Za-z_]/.test(segment);
	// An interpreter's program, or a heredoc body, is where the path actually
	// lives — the operand list only says "read a program from stdin". So the
	// whole segment is the target text. This over-blocks a heredoc that merely
	// mentions a protected file while writing elsewhere; that is the documented
	// price of not being able to evaluate the program.
	if (carriesAProgram) out.push(classify(segment));
	if (operandsAreTargets) for (const t of rest) if (!t.startsWith("-")) out.push(classify(t));
	return out;
};

/* ────────────────────────── javascript writes ────────────────────────── */

/**
 * Names that put bytes on disk.
 *
 * Split in two because half of them are ordinary English. `write`, `open`,
 * `rm`, `cp` and `link` are only taken as filesystem calls behind an `fs.`-ish
 * receiver; the distinctive ones are taken bare, because destructuring
 * (`const { writeFileSync } = require("fs")`) is what an agent actually writes.
 */
const JS_DISTINCT = [
	"writeFileSync",
	"appendFileSync",
	"copyFileSync",
	"createWriteStream",
	"openSync",
	"renameSync",
	"rmSync",
	"rmdirSync",
	"unlinkSync",
	"truncateSync",
	"ftruncateSync",
	"cpSync",
	"mkdirSync",
	"chmodSync",
	"chownSync",
	"symlinkSync",
	"linkSync",
	"utimesSync",
	"writeFile",
	"appendFile",
	"copyFile",
	"unlink",
	"outputFile",
];
const JS_RECEIVER_ONLY = ["write", "open", "rm", "rmdir", "cp", "rename", "truncate", "chmod", "chown", "symlink", "link", "utimes"];

const jsSites = (code: string): string[] => {
	const out: string[] = [];
	const distinct = new RegExp(`\\b(?:${JS_DISTINCT.join("|")})\\s*\\(`, "g");
	const receiver = new RegExp(
		`\\b(?:fs|fsp|fsPromises|promises|fse|Bun|node:fs)\\s*\\.\\s*(?:${JS_RECEIVER_ONLY.join("|")})\\s*\\(`,
		"g",
	);
	for (const rx of [distinct, receiver]) {
		let m: RegExpExecArray | null;
		while ((m = rx.exec(code))) out.push(balanced(code, m.index + m[0].length - 1));
	}
	return out;
};

/** The first argument of a call, as text. */
const firstArg = (args: string): string => {
	let depth = 0;
	let quote: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const c = args[i] as string;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) return args.slice(0, i);
	}
	return args;
};

const literalsIn = (text: string): string[] =>
	[...text.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$]*)`/g)].map(
		(m) => (m[1] ?? m[2] ?? m[3] ?? "") as string,
	);

const jsTarget = (argText: string, root: string, files: ProtectedFile[]): Target => {
	const text = argText.trim();
	const hit = namedIn(text, files) ?? dirTargeted(literalsIn(text)[0] ?? "", root, files);
	if (hit) return { kind: "protected", file: hit };
	const literals = literalsIn(text);
	// Anything that is not entirely made of literals — a bare identifier, a
	// template with a substitution, a concatenation with a variable — cannot be
	// resolved here, and that is exactly the indirection case.
	const withoutLiterals = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, "");
	if (/\$\{/.test(text) || /[A-Za-z_$][\w$]*/.test(withoutLiterals)) return { kind: "unknown" };
	return literals.length ? { kind: "elsewhere" } : { kind: "unknown" };
};

/* ────────────────────────── the verdict ────────────────────────── */

const refusal = (file: ProtectedFile, how: "direct" | "indirect", evidence: string): Refusal => ({
	block: true,
	reason:
		`Refused by rlm-guard: this cell writes ${file.rel}, which is protected.\n\n` +
		`${file.why}\n\n` +
		(how === "indirect"
			? `The write here does not name the file outright — the path is reached through a variable or an ` +
				`interpolation — but this cell both names ${file.rel} and writes somewhere it cannot resolve, so it is ` +
				`refused. If the write was aimed at something else entirely, split it into its own cell that does not ` +
				`mention ${file.rel} and it will run.\n\n`
			: ``) +
		`Reading it is fine, and encouraged: read it, work out what it should do, and say so in your answer. ` +
		`Changing it is not yours to do — raise it with Abhi, or open a task saying what it should be and what you ` +
		`measured. Do not look for another way to write this path: there is a second layer that watches the file and ` +
		`will put it back.`,
	file,
	how,
	evidence: evidence.slice(0, 200),
});

/**
 * Inspect one `code` cell. `null` means it may run.
 *
 * Never throws: a guard that can crash the agent is a guard that gets removed.
 * The caller decides what an internal failure means (see index.ts — it fails
 * closed, but only for cells that name a protected file at all).
 */
export const inspectCell = (code: string, root: string, files: ProtectedFile[]): Refusal | null => {
	if (!files.length || typeof code !== "string" || !code) return null;

	const mentioned = namedIn(code, files);

	const unknowns: string[] = [];
	const consider = (target: Target, evidence: string): Refusal | null => {
		if (target.kind === "protected") return refusal(target.file, "direct", evidence);
		if (target.kind === "unknown") unknowns.push(evidence);
		return null;
	};

	for (const region of shellRegions(code)) {
		for (const segment of segments(region)) {
			for (const target of shellTargets(segment, root, files)) {
				const hit = consider(target, segment);
				if (hit) return hit;
			}
		}
	}

	for (const args of jsSites(code)) {
		const hit = consider(jsTarget(firstArg(args), root, files), args);
		if (hit) return hit;
	}

	if (mentioned && unknowns.length) return refusal(mentioned, "indirect", unknowns[0] as string);
	return null;
};

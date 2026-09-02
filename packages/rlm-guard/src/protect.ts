/**
 * What is protected, and how a cell's words are matched against it.
 *
 * A path guard is only as good as its notion of "names this file". An agent
 * writing to `packages/rlm-delegate/src/capacity.ts` will spell it that way
 * about half the time; the rest of the time it has already `cd`'d somewhere
 * and writes `src/capacity.ts`, or the absolute path, or just `capacity.ts`.
 * All of those are the same file and all of them have to be caught.
 *
 * The naive fix — match the basename — is worse than no fix, because the
 * guard's own source is `packages/rlm-guard/src/index.ts` and matching
 * `index.ts` would refuse every write to every index.ts in the repository.
 *
 * So the accepted spellings of a protected file are: its absolute path, its
 * repo-relative path, and every path suffix down to the *shortest one that is
 * unique across the whole tracked tree*. `capacity.ts` occurs once, so bare
 * `capacity.ts` is accepted. `index.ts` occurs many times, so the guard's own
 * entry point is only recognised from `rlm-guard/src/index.ts` downward. That
 * is measured off `git ls-files` at boot rather than guessed.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ProtectedFile {
	/** Absolute path on this machine. */
	abs: string;
	/** Path relative to the repo root, with forward slashes. */
	rel: string;
	/** Every spelling of this file the guard will recognise in a code cell. */
	spellings: string[];
	/**
	 * Spellings of a *directory* that contains this file.
	 *
	 * `rm -rf packages/rlm-guard/src` names no file at all and would otherwise
	 * walk straight through a guard that only knows filenames. Computed the same
	 * shortest-unique way, so `rlm-guard/src` is recognised and bare `src` — which
	 * occurs under every package — is not.
	 */
	dirSpellings: string[];
	/** Why this file is protected, in one sentence, for the refusal message. */
	why: string;
	/** Protected regardless of config — the guard's own footing. */
	inherent: boolean;
	/**
	 * Does the backstop watch this file?
	 *
	 * Almost always yes. The exception is the unlock sentinel: its whole purpose
	 * is to be created and deleted, so a watcher that restores it to whatever it
	 * was at boot fights the one legitimate use of the file — and, once a stale
	 * one is in the snapshot, keeps writing an expired sentinel back for ever.
	 * It stays on the door's list, which is where refusing an agent that writes
	 * it belongs.
	 */
	watched: boolean;
}

const posix = (p: string): string => p.split(sep).join("/");

/** Every file git knows about, relative to the repo root. Empty when git cannot answer. */
export const trackedFiles = (root: string): string[] => {
	try {
		return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64e6 })
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
};

/**
 * The shortest suffix of `rel` that no other file in the tree shares, plus
 * every longer one.
 *
 * "Shortest unique" is the whole point: it is what lets `capacity.ts` be
 * recognised on its own while `index.ts` is not, without either being written
 * down by hand.
 */
export const spellingsFor = (rel: string, tree: string[]): string[] => {
	const parts = rel.split("/");
	const out: string[] = [];
	let unique = false;
	for (let i = parts.length - 1; i >= 0; i--) {
		const suffix = parts.slice(i).join("/");
		if (!unique) {
			// No tree to consult (no git): only the full relative path is safe to
			// accept, because nothing here can tell a unique name from a common one.
			if (!tree.length) {
				if (i > 0) continue;
				unique = true;
			} else {
				let hits = 0;
				for (const f of tree) {
					if (f === suffix || f.endsWith(`/${suffix}`)) hits++;
					if (hits > 1) break;
				}
				if (hits > 1) continue;
				unique = true;
			}
		}
		out.push(suffix);
	}
	return out;
};

/**
 * The same treatment for the directories above a file.
 *
 * A directory counts as unique when no other directory in the tree ends with
 * the same suffix, so `rlm-guard/src` is accepted and `src` is not. Only
 * directories strictly inside the repo are considered — the repo root itself is
 * not a spelling of anything.
 */
export const dirSpellingsFor = (rel: string, tree: string[]): string[] => {
	const dirs = new Set<string>();
	for (const f of tree) {
		const parts = f.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
	}
	const all = [...dirs];
	const out: string[] = [];
	const parts = rel.split("/");
	for (let depth = parts.length - 1; depth >= 1; depth--) {
		const dir = parts.slice(0, depth).join("/");
		if (!dir) continue;
		for (const suffix of spellingsFor(dir, all)) if (suffix && !out.includes(suffix)) out.push(suffix);
	}
	return out;
};

const walk = (dir: string, out: string[] = []): string[] => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
};

/** `packages/rlm-guard/src/**` and friends, as a regex over repo-relative paths. */
const globToRegex = (glob: string): RegExp => {
	const segments = glob.split("/");
	let body = "";
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i] as string;
		const last = i === segments.length - 1;
		if (seg === "**") body += last ? "(?:[^/]+/)*[^/]+" : "(?:[^/]+/)*";
		else body += seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + (last ? "" : "/");
	}
	return new RegExp(`^${body}$`);
};

/** Expand a config entry — a literal path, a directory, or a glob — into real files. */
const expand = (root: string, pattern: string): string[] => {
	// A protected path outside the repo — the unlock sentinel in ~/.rlm — keeps
	// its absolute form. `relative()` would render it as `../../.rlm/…`, which is
	// correct and unreadable, and would make its ancestor list climb out of the
	// tree.
	const outside = isAbsolute(pattern) && !posix(resolve(pattern)).startsWith(`${posix(root)}/`);
	const rel = outside
		? posix(resolve(pattern))
		: posix(isAbsolute(pattern) ? relative(root, pattern) : pattern).replace(/^\.\//, "");
	if (!rel.includes("*")) {
		try {
			const abs = resolve(root, rel);
			return statSync(abs).isDirectory() ? walk(abs).map((p) => posix(relative(root, p))) : [rel];
		} catch {
			// A protected file that does not exist yet is still protected: the
			// guard must refuse a cell that would create it.
			return [rel];
		}
	}
	const base = rel.slice(0, rel.indexOf("*")).replace(/\/[^/]*$/, "");
	const rx = globToRegex(rel);
	try {
		return walk(resolve(root, base))
			.map((p) => posix(relative(root, p)))
			.filter((p) => rx.test(p));
	} catch {
		return [];
	}
};

export interface ProtectSpec {
	pattern: string;
	why: string;
	inherent?: boolean;
	/** Default true. See `ProtectedFile.watched`. */
	watch?: boolean;
}

/**
 * The list, resolved against this checkout.
 *
 * `inherent` entries are the guard's own footing and are added whatever the
 * config says — see the header of index.ts for why that is not optional.
 */
export const resolveProtected = (root: string, specs: ProtectSpec[]): ProtectedFile[] => {
	const tree = trackedFiles(root);
	const byRel = new Map<string, ProtectedFile>();
	for (const spec of specs) {
		for (const rel of expand(root, spec.pattern)) {
			const existing = byRel.get(rel);
			if (existing) {
				if (spec.inherent === true) existing.inherent = true;
				continue;
			}
			byRel.set(rel, {
				abs: resolve(root, rel),
				rel,
				spellings: spellingsFor(rel, tree),
				dirSpellings: dirSpellingsFor(rel, tree),
				why: spec.why,
				inherent: spec.inherent === true,
				watched: spec.watch !== false,
			});
		}
	}
	return [...byRel.values()];
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches one spelling at a path boundary, so `mycapacity.ts` is not
 * `capacity.ts`.
 *
 * A leading `/` is deliberately *allowed* before the spelling. The spellings
 * are already the shortest suffixes unique in the tree, so any prefix in front
 * of one still names the same file — and forbidding `/` meant a path spelled
 * with a prefix the guard had not enumerated (`~/.rlm/cordis.patch.yml`, an
 * absolute path from a second checkout) matched nothing at all.
 */
const boundary = (spelling: string): RegExp => new RegExp(`(?<![\\w.\\-])${escape(spelling)}(?![\\w.\\-])`);

/** Which protected file, if any, this piece of text names. */
export const namedIn = (text: string, files: ProtectedFile[]): ProtectedFile | null => {
	for (const file of files) {
		if (text.includes(file.abs)) return file;
		for (const spelling of file.spellings) if (boundary(spelling).test(text)) return file;
	}
	return null;
};

/**
 * Is this one token a directory that holds a protected file?
 *
 * Exact match, and only ever against a single operand — never a substring scan
 * of the whole cell. `rm -rf packages/rlm-guard/src` has to be caught; editing
 * `packages/rlm-delegate/src/scheduler.ts`, which sits in a protected file's
 * directory and is not protected itself, must not be. A substring test cannot
 * tell those apart and an exact one can.
 */
export const dirTargeted = (token: string, root: string, files: ProtectedFile[]): ProtectedFile | null => {
	const raw = token.replace(/^['"]|['"]$/g, "").replace(/\/+$/, "");
	if (!raw) return null;
	const rel = posix(isAbsolute(raw) ? relative(root, raw) : raw).replace(/^\.\//, "");
	for (const file of files) for (const dir of file.dirSpellings) if (raw === dir || rel === dir) return file;
	return null;
};

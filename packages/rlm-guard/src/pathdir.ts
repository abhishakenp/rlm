/**
 * Directories on PATH — protected by prefix, not by name.
 *
 * ## Why the file list was not enough
 *
 * On 2026-09-03 two delegated children rewrote executables on Abhi's PATH.
 * `~/.local/bin/iris` became a three-line shim that ran rlm's own CLI, and
 * `/opt/homebrew/bin/iris` became a bash `case` statement that printed
 * `{"daemon":"connected"}` whether or not anything was connected. Neither child
 * was misbehaving on purpose. Each had been handed a criterion of the shape
 * "`iris <something>` exits 0", could not make the real `iris` do it, and
 * discovered that a criterion which runs a *name* can be satisfied by putting a
 * different program under that name. From inside the task that is not cheating,
 * it is the shortest path to a green check.
 *
 * The cost was not the two files. `scripts/gates/hmr-live.mjs` and
 * `scripts/deadman/deadman.mjs` in iris-mama both invoke `~/.local/bin/iris`,
 * so both monitors went blind and alarmed "HOT RELOAD IS NOT WORKING" every
 * three and a half minutes for six hours while hot reload was in fact working.
 * A fabricated success is worse than a failure, and an alarm somebody learns to
 * ignore is worse than no alarm.
 *
 * ## Why this is a different shape from `protect.ts`
 *
 * `protect.ts` protects *files*, recorded at boot, recognised by the shortest
 * suffix unique in the tracked tree. Two things about that do not carry over:
 *
 *   - A PATH directory has to be protected by **prefix**. The dangerous write
 *     is to a filename nobody has enumerated — including one that does not
 *     exist yet, which is how `/opt/homebrew/bin/iris` came to exist at all.
 *   - Suffix spellings would be catastrophic here. The shortest unique suffix
 *     of `~/.local/bin/node` is `node`; matching that would refuse every cell
 *     in the repository. So a PATH-dir path is only ever recognised from an
 *     **absolute** spelling (or `~`/`$HOME`, which resolve to one), never from
 *     a bare basename.
 *
 * ## What is protected, and how far
 *
 * Every directory on rlm's own PATH that lies outside the repo, plus
 * `~/.local/bin` and `/opt/homebrew/bin` whether or not PATH mentions them.
 * Deriving the list from PATH rather than writing it down is the point: the
 * property that matters is "a name the shell will find", and that is exactly
 * what PATH means. A directory inside the repo is excluded — repo files are
 * `protect.ts`'s business and the repo is what the fleet is *for*.
 *
 * ## The backstop's honest limit, stated once
 *
 * See `readDirBaseline`. In short: entries that existed at boot are snapshotted
 * and put back; entries that *arrive* after boot are logged loudly and left
 * alone, because `brew install`, `pipx install` and `cargo install` all create
 * files in exactly these directories and a guard that deletes new arrivals
 * would eventually delete somebody's real software. Noticing is worth a great
 * deal and deleting is worth less than nothing.
 *
 * ## The limit that is not a bug, and is not fixed here
 *
 * The baseline is taken at boot, so **a restart while a file is already wrong
 * bakes the wrong file in as the truth**. Measured, not theorised: during the
 * verification of this row the drive was restarted by its supervisor eight
 * seconds after a test hijack of `~/.local/bin/iris`, and the new boot
 * snapshotted the shim. From then on the guard would have defended the shim.
 *
 * Fixing it means persisting the baseline across restarts, and that trades one
 * problem for a harder one: a stored baseline is itself a file on disk, it goes
 * stale the moment Abhi installs anything while rlm is down, and something then
 * has to decide which of the two is the truth. That is his call, not this
 * file's. What is here instead is that boot says out loud how many entries it
 * snapshotted, so a wrong baseline is at least visible in the log.
 *
 * The practical consequence: after any hijack, put the real file back **before**
 * rlm restarts, or under an unlock so the sweep re-baselines it deliberately.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	unwatchFile,
	watch,
	watchFile,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve, sep } from "node:path";

const posix = (p: string): string => p.split(sep).join("/");

/** Strip one layer of shell quoting and any trailing slashes. */
const bare = (token: string): string => token.replace(/^['"]|['"]$/g, "").replace(/\/+$/, "");

/**
 * `~`, `$HOME` and `${HOME}` at the head of a path.
 *
 * Only at the head, and only followed by `/` or end: `$HOMEBREW_PREFIX` is not
 * `$HOME`, and `x~y` is not a home directory.
 */
export const expandHome = (path: string, home = homedir()): string =>
	path
		.replace(/^~(?=\/|$)/, home)
		.replace(/^\$\{HOME\}(?=\/|$)/, home)
		.replace(/^\$HOME(?=\/|$)/, home);

export interface ProtectedPathDir {
	/** Absolute, resolved, no trailing slash. */
	abs: string;
	/** How a cell may spell this directory: the absolute path, and the `~`/`$HOME` forms. */
	spellings: string[];
	/** Why it is protected, in one sentence, for the refusal message. */
	why: string;
	/** Does the backstop snapshot and watch this directory? */
	watched: boolean;
}

export interface PathDirSpec {
	dir: string;
	why: string;
	watch?: boolean;
}

const spellingsForDir = (abs: string, home: string): string[] => {
	const out = [abs];
	if (abs === home || abs.startsWith(`${home}/`)) {
		const tail = abs.slice(home.length);
		out.push(`~${tail}`, `$HOME${tail}`, `\${HOME}${tail}`);
	}
	return out;
};

/**
 * The PATH directories worth protecting, given a PATH string and a repo root.
 *
 * Relative entries and the empty entry (a bare `:` in PATH, which means the
 * current directory) are dropped — they name a different place in every
 * process and cannot be protected coherently.
 */
/**
 * The system directories, which this guard should not claim.
 *
 * On macOS these are under System Integrity Protection: not writable by the
 * user, not writable by root, so the guard buys nothing by naming them. What
 * it *costs* is real — `#!/usr/bin/env node` is the first line of most scripts
 * an agent writes, and protecting `/usr/bin` turned that shebang into a
 * refusal twice within four minutes of this row going live. The right owner of
 * `/usr/bin` is the operating system.
 */
const SYSTEM_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/libexec", "/System"];

export const pathDirsFromEnv = (pathEnv: string | undefined, root: string): string[] => {
	const out: string[] = [];
	for (const raw of (pathEnv ?? "").split(delimiter)) {
		const entry = bare(raw.trim());
		if (!entry || !isAbsolute(entry)) continue;
		const abs = resolve(entry);
		if (SYSTEM_DIRS.some((d) => abs === d || abs.startsWith(`${d}/`))) continue;
		// Inside the repo is protect.ts's territory, and `node_modules/.bin` is
		// rewritten by every install.
		if (posix(abs) === posix(root) || posix(abs).startsWith(`${posix(root)}/`)) continue;
		if (!out.includes(abs)) out.push(abs);
	}
	return out;
};

export const resolvePathDirs = (specs: PathDirSpec[], home = homedir()): ProtectedPathDir[] => {
	const byAbs = new Map<string, ProtectedPathDir>();
	for (const spec of specs) {
		const abs = resolve(expandHome(bare(spec.dir), home));
		if (byAbs.has(abs)) continue;
		byAbs.set(abs, { abs, spellings: spellingsForDir(abs, home), why: spec.why, watched: spec.watch !== false });
	}
	return [...byAbs.values()];
};

/* ────────────────────────── matching ────────────────────────── */

/** Is `abs` the directory itself, or something inside it? */
const inside = (abs: string, dir: ProtectedPathDir): boolean => abs === dir.abs || abs.startsWith(`${dir.abs}/`);

/**
 * Does this one token name a path in a protected directory?
 *
 * A **token**, not free text: a redirect target, an operand of `cp`, the first
 * argument of `writeFileSync`. Precision here is what keeps the guard from
 * refusing every cell that merely runs a homebrew binary by its full path.
 *
 * `cwdDir` covers the segment that has already `cd`'d in — `cd ~/.local/bin &&
 * cat > iris` writes the same file as `cat > ~/.local/bin/iris`, and the
 * redirect target on its own is just the word `iris`.
 */
export const underPathDir = (
	token: string,
	dirs: ProtectedPathDir[],
	cwdDir: ProtectedPathDir | null = null,
	home = homedir(),
): ProtectedPathDir | null => {
	const raw = bare(token);
	if (!raw) return null;
	const expanded = expandHome(raw, home);
	if (isAbsolute(expanded)) {
		const abs = resolve(expanded);
		for (const dir of dirs) if (inside(abs, dir)) return dir;
		return null;
	}
	// Relative, and this segment is standing in a protected directory.
	if (cwdDir && !/[$`]/.test(raw)) {
		const abs = resolve(cwdDir.abs, expanded);
		if (inside(abs, cwdDir)) return cwdDir;
	}
	return null;
};

/** One path-like run of characters — what a path looks like inside a program. */
const PATH_CHARS = "[^\\s'\"`;|&()\\[\\]{}<>,]+";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The spelling has to *start* a path, not sit in the middle of one.
 *
 * Without this, the spelling `/bin` matches inside `/Users/abhi/.local/bin/x`
 * and the guard reports a refusal against `/bin/x`, a file nobody named.
 * Observed in production within four minutes of this row going live:
 * `rlm-guard: refused a write to /bin/list-tasks`, where the cell was writing
 * to `~/.local/bin/list-tasks`. Right refusal, wrong reason, and a wrong reason
 * is how a guard stops being believed.
 */
const LEFT = "(?<![\\w./~$-])";

/**
 * Shebang lines, removed before any free-text scan.
 *
 * `#!/usr/bin/env node` is the first line of most scripts an agent writes, and
 * it names a directory on PATH while writing somewhere else entirely. Also
 * observed in production: two refusals against `/usr/bin/env` for cells that
 * were creating a CLI in the repo. The shebang is content, not a target.
 *
 * Deliberately not anchored to the start of a line. The script being written is
 * usually a JavaScript string — ``const s = `#!/bin/bash\n…` `` — where the
 * shebang sits mid-line and a `^`-anchored rule misses it entirely. `#!`
 * followed by an absolute path is a shebang wherever it appears; nothing else
 * spells that.
 */
const withoutShebangs = (text: string): string => text.replace(/#!\s*\/\S+/g, "");

/**
 * Free text — a python program, a heredoc body — naming a *file* inside a
 * protected directory.
 *
 * Requires the trailing `/name`: a mention of the bare directory is not enough,
 * because `PATH=/opt/homebrew/bin:$PATH` mentions it and writes nothing.
 */
export const pathDirFileIn = (
	text: string,
	dirs: ProtectedPathDir[],
): { dir: ProtectedPathDir; evidence: string } | null => {
	for (const dir of dirs) {
		for (const spelling of dir.spellings) {
			const hit = new RegExp(`${LEFT}${escape(spelling)}/${PATH_CHARS}`).exec(withoutShebangs(text));
			if (hit) return { dir, evidence: hit[0] as string };
		}
	}
	return null;
};

/**
 * A protected directory mentioned at all — with or without a file after it.
 *
 * Weaker than `pathDirFileIn`, and used for exactly one thing: the indirect
 * rule in `detect.ts`. `const d = "/Users/abhi/.local/bin"` followed by
 * ``writeFileSync(`${d}/iris`, …)`` never spells the whole path anywhere, so
 * the strong matcher above sees nothing. What it does do is put the directory
 * in scope as a value next to a write this file cannot resolve, and that
 * conjunction is the indirection case.
 *
 * On its own a bare mention refuses nothing — `export PATH="/opt/homebrew/bin:$PATH"`
 * mentions the directory and is not a write.
 */
export const pathDirMentionedIn = (
	text: string,
	dirs: ProtectedPathDir[],
): { dir: ProtectedPathDir; evidence: string } | null => {
	for (const dir of dirs) {
		for (const spelling of dir.spellings) {
			const hit = new RegExp(`${LEFT}${escape(spelling)}(?![\\w.\\-])`).exec(withoutShebangs(text));
			if (hit) return { dir, evidence: hit[0] as string };
		}
	}
	return null;
};

/**
 * Does this segment `cd` into a protected directory?
 *
 * `cd`, `pushd`, and `cd -- <dir>`. Anything cleverer than that is not what an
 * agent writes, and the absolute-path rule above already covers the rest.
 */
export const cdTarget = (segment: string, dirs: ProtectedPathDir[], home = homedir()): ProtectedPathDir | null => {
	const m = /(?:^|\s)(?:cd|pushd)\s+(?:--\s+)?("[^"]*"|'[^']*'|[^\s;|&]+)/.exec(segment);
	if (!m) return null;
	const raw = bare(m[1] as string);
	if (/[$`]/.test(raw)) return null;
	const abs = resolve(expandHome(raw, home));
	for (const dir of dirs) if (inside(abs, dir)) return dir;
	return null;
};

/**
 * Words that mean "this program puts bytes somewhere".
 *
 * Used only to gate the whole-segment check on an interpreter's program, where
 * the target is a string three lines inside a python heredoc and there is no
 * token to point at. Without the gate, `bash -c "/opt/homebrew/bin/gh pr list"`
 * — a pure read, and a shape that appears in Abhi's own notes — would be
 * refused. With it, the same heredoc that calls `open(..., "w")` is not.
 *
 * `>` counts as a redirect only when something other than `&` follows it.
 * `2>&1` is not a write, and within a minute of this row going live it turned
 * `bash -c 'source /opt/homebrew/bin/iris 2>&1'` — a read — into a refusal.
 */
export const WRITE_WORDS =
	/\b(?:write|writelines|write_text|write_bytes|writeFile|writeFileSync|appendFile|createWriteStream|outputFile|copyfile|copyfileobj|copy2|shutil|rename|replace|unlink|remove|rmtree|symlink|chmod|touch|tee|install|patch|truncate|mkdir)\b|>\s*[^&\s]|\bopen\s*\([^)]*['"][wax]/;

/* ────────────────────────── the backstop ────────────────────────── */

export type PathIncidentAction =
	| "path-entry-restored"
	| "path-entry-arrived"
	| "path-entry-unrestorable"
	| "path-entry-accepted-under-unlock"
	| "path-entry-accepted-moved";

export interface PathIncident {
	at: number;
	rel: string;
	action: PathIncidentAction;
	detail: string;
}

export interface EntrySnapshot {
	name: string;
	abs: string;
	kind: "file" | "symlink" | "other";
	/** For a symlink: where it pointed at boot. Restorable, and cheap to record. */
	target?: string;
	/** For a small regular file: the bytes. The only thing that can put it back. */
	content?: Buffer;
	/** Permission bits at boot, so a restored shim is executable again. */
	mode: number;
	hash: string;
	size: number;
}

export interface PathDirBaseline {
	dir: ProtectedPathDir;
	entries: Map<string, EntrySnapshot>;
	/** Entries seen arriving after boot, so each is only reported once. */
	arrived: Set<string>;
	/**
	 * Entries whose restore failed, keyed to the state that could not be put
	 * back. Without this a failed restore was retried and re-reported by every
	 * 15 s sweep for as long as rlm ran — 20 identical EPERM warnings for one
	 * `~/.bun/bin/codex` on 2026-09-07. Reported again only if the entry changes.
	 */
	failed?: Map<string, string>;
}

const hashOf = (content: Buffer): string => createHash("sha1").update(content).digest("hex");

/**
 * Snapshot one directory. Cheap on purpose.
 *
 * `~/.local/bin` holds 602 MB of regular files and `/opt/homebrew/bin` holds
 * 310 MB, almost all of it in a handful of large binaries — `omp.bak` alone is
 * 195 MB. Hashing that at every boot would be a quarter of a gigabyte of reads
 * to defend files no agent has ever written. So:
 *
 *   - **symlinks** — 1486 of the 1504 entries in `/opt/homebrew/bin` — are
 *     recorded by their target, which is one `readlink` and fully restorable.
 *   - **regular files at or under `maxBytes`** are read and hashed. Every shim
 *     shape is here: both hijacked files were under 3.4 KB, and the largest
 *     script in either directory is 27 KB.
 *   - **larger regular files** are recorded by size alone. A change is noticed
 *     and reported; it cannot be undone, and the incident says so rather than
 *     pretending it did.
 */
export const readDirBaseline = (dir: ProtectedPathDir, maxBytes: number): PathDirBaseline => {
	const entries = new Map<string, EntrySnapshot>();
	let names: string[] = [];
	try {
		names = readdirSync(dir.abs);
	} catch {
		// The directory may not exist on this machine. It is still protected at
		// the door — a cell that creates it is exactly what this is here for.
		return { dir, entries, arrived: new Set(), failed: new Map() };
	}
	for (const name of names) {
		const abs = `${dir.abs}/${name}`;
		try {
			const st = lstatSync(abs);
			const mode = st.mode & 0o777;
			if (st.isSymbolicLink()) {
				const target = readlinkSync(abs);
				entries.set(name, { name, abs, kind: "symlink", target, mode, hash: `link:${target}`, size: 0 });
			} else if (st.isFile() && st.size <= maxBytes) {
				const content = readFileSync(abs);
				entries.set(name, { name, abs, kind: "file", content, mode, hash: hashOf(content), size: st.size });
			} else if (st.isFile()) {
				entries.set(name, { name, abs, kind: "file", mode, hash: `size:${st.size}`, size: st.size });
			} else {
				entries.set(name, { name, abs, kind: "other", mode, hash: "other", size: 0 });
			}
		} catch {
			/* raced with a removal; the next sweep sees it as gone */
		}
	}
	return { dir, entries, arrived: new Set(), failed: new Map() };
};

/** What the entry is now, in the same terms the snapshot used. */
export const currentEntryHash = (abs: string, maxBytes: number): string => {
	try {
		const st = lstatSync(abs);
		if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
		if (st.isFile() && st.size <= maxBytes) return hashOf(readFileSync(abs));
		if (st.isFile()) return `size:${st.size}`;
		return "other";
	} catch {
		return "";
	}
};

/** Resolve a link target the way the kernel would: relative to the link's own directory. */
const linkResolves = (linkAbs: string, target: string): boolean => existsSync(resolve(dirname(linkAbs), target));

/**
 * The boot snapshot was a symlink, it is still a symlink, its boot target no
 * longer exists and its new target does. That is the shape of `bun add -g`,
 * `brew upgrade` and friends moving a package; a hijack that wants to run its
 * own program has no reason to delete the real one first.
 */
export const packageMoved = (snapshot: EntrySnapshot): boolean => {
	if (snapshot.kind !== "symlink" || snapshot.target === undefined) return false;
	let now: string;
	try {
		if (!lstatSync(snapshot.abs).isSymbolicLink()) return false;
		now = readlinkSync(snapshot.abs);
	} catch {
		return false;
	}
	if (!linkResolves(snapshot.abs, now)) return false;
	return !linkResolves(snapshot.abs, snapshot.target) || versionBumped(snapshot.target, now);
};

/** Directories package managers keep one sub-directory per installed version in. */
const VERSIONED_ROOTS = new Set(["Cellar", "Caskroom", "installs", "versions", "node-versions", "toolchains"]);
const VERSION = /^v?\d+(\.\d+)*([._+-][0-9A-Za-z.+-]*)?$/;

/**
 * The link moved from one version directory of a package to another, with the
 * rest of the path unchanged: `../Cellar/cliproxyapi/6.9.0/bin/cliproxyapi` →
 * `../Cellar/cliproxyapi/7.3.15/bin/cliproxyapi`.
 *
 * `packageMoved` alone waits for the old target to disappear, but `brew
 * upgrade` relinks before it cleans up the old keg, so for one sweep the old
 * target still resolved and the guard put an upgrade back (cliproxyapi, Sep 25
 * 18:44:38, accepted 22s later once brew deleted 6.9.0).
 */
export const versionBumped = (before: string, after: string): boolean => {
	const a = before.split("/");
	const b = after.split("/");
	if (a.length !== b.length) return false;
	const differing = a.flatMap((part, i) => (part === b[i] ? [] : [i]));
	if (differing.length !== 1) return false;
	const i = differing[0];
	// <root>/<package>/<version>/… — the version segment sits two below a known root.
	return i >= 2 && VERSIONED_ROOTS.has(a[i - 2]) && VERSION.test(a[i]) && VERSION.test(b[i]);
};

export const restoreEntry = (snapshot: EntrySnapshot): PathIncident => {
	const at = Date.now();
	if (snapshot.kind === "symlink" && snapshot.target !== undefined) {
		try {
			// A symlink cannot be rewritten in place.
			try {
				rmSync(snapshot.abs, { force: true });
			} catch {
				/* nothing there */
			}
			symlinkSync(snapshot.target, snapshot.abs);
			return { at, rel: snapshot.abs, action: "path-entry-restored", detail: `symlink put back to ${snapshot.target}` };
		} catch (error: unknown) {
			return {
				at,
				rel: snapshot.abs,
				action: "path-entry-unrestorable",
				detail: `symlink changed and could not be put back: ${(error as Error)?.message ?? String(error)}`,
			};
		}
	}
	if (snapshot.content) {
		try {
			writeFileSync(snapshot.abs, snapshot.content, { mode: snapshot.mode });
			return {
				at,
				rel: snapshot.abs,
				action: "path-entry-restored",
				detail: `${snapshot.size} bytes put back from the boot snapshot`,
			};
		} catch (error: unknown) {
			return {
				at,
				rel: snapshot.abs,
				action: "path-entry-unrestorable",
				detail: `writing the boot snapshot back failed: ${(error as Error)?.message ?? String(error)}`,
			};
		}
	}
	return {
		at,
		rel: snapshot.abs,
		action: "path-entry-unrestorable",
		detail: "changed since boot, and it was too large to snapshot — the change stands and this is a notice, not a repair",
	};
};

export interface PathWatchOptions {
	baselines: PathDirBaseline[];
	debounceMs: number;
	maxBytes: number;
	/** Consulted at the moment a change is seen, not when the watch is set up. */
	authorised: () => boolean;
	onIncident: (incident: PathIncident) => void;
}

/**
 * Compare one directory against its boot snapshot and act. Exported so the
 * behaviour can be driven directly rather than only through a filesystem event.
 */
export const sweepDir = (
	baseline: PathDirBaseline,
	maxBytes: number,
	unlocked: boolean,
	onIncident: (incident: PathIncident) => void,
): void => {
	let present: string[] = [];
	try {
		present = readdirSync(baseline.dir.abs);
	} catch {
		return;
	}

	const failed = (baseline.failed ??= new Map());
	for (const [name, snapshot] of baseline.entries) {
		const now = currentEntryHash(snapshot.abs, maxBytes);
		if (now === snapshot.hash) {
			failed.delete(name);
			continue;
		}
		if (failed.get(name) === now) continue;
		if (!unlocked && packageMoved(snapshot)) {
			// A package manager moved the package: the link now points at a real
			// file and the boot target no longer exists. Putting it back would
			// write a dangling link over working software — which is what the
			// guard tried, 20 times, when bun moved `codex` to `@openai/codex`.
			const fresh = readDirBaseline(baseline.dir, maxBytes).entries.get(name);
			if (fresh) baseline.entries.set(name, fresh);
			onIncident({
				at: Date.now(),
				rel: snapshot.abs,
				action: "path-entry-accepted-moved",
				detail: `symlink retargeted from ${snapshot.target} (gone) to ${fresh?.target ?? "?"} (exists) — accepted as a package update`,
			});
			continue;
		}
		if (unlocked) {
			// Abhi is installing something. What is there when the unlock lapses is
			// what gets defended, exactly as restore.ts does it.
			const fresh = readDirBaseline(baseline.dir, maxBytes).entries.get(name);
			if (fresh) baseline.entries.set(name, fresh);
			else baseline.entries.delete(name);
			onIncident({
				at: Date.now(),
				rel: snapshot.abs,
				action: "path-entry-accepted-under-unlock",
				detail: "changed while unlocked — this is the baseline now",
			});
			continue;
		}
		const incident = restoreEntry(snapshot);
		if (incident.action === "path-entry-unrestorable") failed.set(name, currentEntryHash(snapshot.abs, maxBytes));
		onIncident(incident);
	}

	for (const name of present) {
		if (baseline.entries.has(name) || baseline.arrived.has(name)) continue;
		baseline.arrived.add(name);
		if (unlocked) {
			const fresh = readDirBaseline(baseline.dir, maxBytes).entries.get(name);
			if (fresh) baseline.entries.set(name, fresh);
			continue;
		}
		// Left in place on purpose. See the header: brew, pipx, uv and cargo all
		// create files here, and a guard that deletes new arrivals eventually
		// deletes somebody's real software. Saying so loudly is the whole job.
		onIncident({
			at: Date.now(),
			rel: `${baseline.dir.abs}/${name}`,
			action: "path-entry-arrived",
			detail:
				"a new executable appeared on PATH after boot and was NOT removed — the guard cannot tell an install from " +
				"a hijack, so it reports rather than deletes. Check it: if the fleet put it there, it is a fabricated " +
				"success wearing the name of a real command.",
		});
	}
};

/**
 * Watch the protected directories and put back what was overwritten.
 *
 * One `fs.watch` per directory, plus a `watchFile` poll on the directory
 * itself, for the same reason `restore.ts` doubles up: a directory watch can
 * die quietly and a poll cannot. Each wake re-lists the directory and compares
 * against the boot snapshot — a `readdir` and a handful of `lstat`s.
 */
export const watchPathDirs = (options: PathWatchOptions): (() => void) => {
	const { baselines, debounceMs, maxBytes, authorised, onIncident } = options;
	const timers = new Map<string, NodeJS.Timeout>();
	/**
	 * Directories this module is currently writing into, so its own restore does
	 * not re-trigger a sweep of the same directory.
	 *
	 * Per-directory, and this is not a detail. A single shared flag was measured
	 * losing a real restore: `~/.local/bin/iris` and `/opt/homebrew/bin/iris`
	 * were overwritten in the same instant, the first sweep set the flag, the
	 * second directory's sweep was dropped — and nothing ever came back for it,
	 * because a file changing in place does not change its directory's mtime, so
	 * the poll below never fires again either. The shim survived.
	 */
	const settling = new Set<string>();

	const run = (baseline: PathDirBaseline) => {
		const key = baseline.dir.abs;
		// Busy with this one: come back rather than drop it on the floor.
		if (settling.has(key)) return schedule(baseline);
		settling.add(key);
		try {
			sweepDir(baseline, maxBytes, authorised(), onIncident);
		} finally {
			setTimeout(() => settling.delete(key), Math.max(50, debounceMs)).unref?.();
		}
	};

	const schedule = (baseline: PathDirBaseline) => {
		clearTimeout(timers.get(baseline.dir.abs));
		const t = setTimeout(() => {
			timers.delete(baseline.dir.abs);
			run(baseline);
		}, debounceMs);
		t.unref?.();
		timers.set(baseline.dir.abs, t);
	};

	const watchers: FSWatcher[] = [];
	for (const baseline of baselines) {
		try {
			const w = watch(baseline.dir.abs, () => schedule(baseline));
			w.on?.("error", () => {
				/* the poll below is the other half */
			});
			watchers.push(w);
		} catch {
			/* no watch on this directory — the poll still covers it */
		}
		watchFile(baseline.dir.abs, { interval: Math.max(1000, debounceMs * 2) }, () => schedule(baseline));
	}

	// A slow unconditional sweep, because both mechanisms above can miss.
	// `fs.watch` can die quietly, and `watchFile` on a directory only sees its
	// mtime — which a file rewritten in place does not touch. This costs one
	// readdir and ~1600 lstats a quarter of a minute, and it is the difference
	// between a backstop and a backstop that is usually there.
	const sweeper = setInterval(() => {
		for (const baseline of baselines) run(baseline);
	}, Math.max(15_000, debounceMs * 30));
	sweeper.unref?.();

	return () => {
		clearInterval(sweeper);
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
		for (const w of watchers) {
			try {
				w.close();
			} catch {
				/* already closed */
			}
		}
		for (const baseline of baselines) unwatchFile(baseline.dir.abs);
	};
};

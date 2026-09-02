/**
 * Layer 2 — the backstop, because layer 1 is a heuristic.
 *
 * The door in `detect.ts` refuses every shape an agent actually writes, and it
 * will still be walked through eventually, by a spelling nobody thought of or
 * by a subprocess three levels down. This layer does not care how the file
 * changed. It knows what the file was at boot, it watches, and it puts it back.
 *
 * ## What "put it back" means, and why it is not always `git checkout`
 *
 * The instruction was `git checkout -- <path>`, never `git reset`, and reset is
 * indeed never used here — it is destructive far beyond the one path and it is
 * separately gated. But `git checkout --` restores the file to the *index*, and
 * a protected file can perfectly well have legitimate uncommitted work in it:
 * `cordis.yml` is modified in the working tree right now. Restoring that to the
 * index would destroy a person's edits in the name of protecting them, which is
 * the same class of mistake as `reset`.
 *
 * So the baseline is the content at boot, and the restore picks the honest tool:
 *
 *   - boot content is byte-identical to the index → `git checkout -- <path>`,
 *     which is exactly the instructed behaviour and lets git be the authority.
 *   - boot content differs from the index (uncommitted work) → write the boot
 *     snapshot back, because git has no record of it to restore from.
 *   - the file is untracked (a new package, before its first commit) → write the
 *     boot snapshot back; git cannot help at all.
 *
 * ## Not in a delegated child
 *
 * The watcher runs only in a process that is not a `--print` child. Two
 * reasons, and the second is the real one:
 *
 *   - A child lives about fifteen seconds. A watcher it starts and disposes is
 *     cost with no cover.
 *   - The unlock is never honoured in a child (see `unlock.ts`). A child that
 *     also ran the watcher would therefore fight Abhi's own authorised edit,
 *     restoring a file he had just deliberately unlocked and changed. The
 *     parent's watcher is the one with the whole picture, and the parent is a
 *     separate process the child cannot reach into.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, unwatchFile, watch, watchFile, writeFileSync, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import type { ProtectedFile } from "./protect.ts";

export interface Baseline {
	file: ProtectedFile;
	/** Git's blob hash of the content this file had at boot. */
	blob: string;
	/** The bytes themselves — the only thing that can restore uncommitted work. */
	content: Buffer | null;
	/** Does the index hold exactly these bytes? Decides which restore is honest. */
	matchesIndex: boolean;
}

export interface Incident {
	at: number;
	rel: string;
	/** What was done about it. */
	action: "restored-from-git" | "restored-from-snapshot" | "accepted-under-unlock" | "cannot-restore";
	detail: string;
}

/** `git hash-object` without shelling out — the same SHA-1 git would compute. */
export const blobHash = (content: Buffer): string =>
	createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

const indexBlob = (root: string, rel: string): string | null => {
	try {
		// stderr swallowed: a protected path outside the repo (the unlock sentinel
		// in ~/.rlm) makes git print "outside repository", which is the answer, not
		// an error worth putting on the terminal.
		const out = execFileSync("git", ["ls-files", "-s", "--", rel], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim().split(/\s+/)[1] ?? null;
	} catch {
		return null;
	}
};

export const readBaseline = (root: string, file: ProtectedFile): Baseline => {
	let content: Buffer | null = null;
	try {
		content = readFileSync(file.abs);
	} catch {
		/* not on disk yet — protected all the same, and its absence is the baseline */
	}
	const blob = content ? blobHash(content) : "";
	return { file, blob, content, matchesIndex: content !== null && indexBlob(root, file.rel) === blob };
};

/** What the file is now, as a blob hash. Empty string when it is gone. */
export const currentBlob = (abs: string): string => {
	try {
		return blobHash(readFileSync(abs));
	} catch {
		return "";
	}
};

/**
 * Put one file back. Returns what was done, for the log.
 *
 * Never `git reset`, never `git clean`, never anything that touches a path
 * other than this one.
 */
export const restoreFile = (root: string, baseline: Baseline): Incident => {
	const { file } = baseline;
	if (baseline.matchesIndex) {
		try {
			execFileSync("git", ["checkout", "--", file.rel], { cwd: root, encoding: "utf8" });
			if (currentBlob(file.abs) === baseline.blob)
				return { at: Date.now(), rel: file.rel, action: "restored-from-git", detail: `git checkout -- ${file.rel}` };
		} catch (error) {
			/* fall through to the snapshot, which cannot fail for a reason git can */
			void error;
		}
	}
	if (!baseline.content) {
		// It did not exist at boot, so putting it back means removing it. This is
		// how a forged or malformed unlock sentinel gets cleaned up: the sentinel
		// is on the protected list, its baseline is "absent", and a sentinel that
		// does not authorise anything is a file that should not be there.
		if (!existsSync(file.abs))
			return { at: Date.now(), rel: file.rel, action: "restored-from-snapshot", detail: "absent, as at boot" };
		try {
			rmSync(file.abs, { force: true });
			return {
				at: Date.now(),
				rel: file.rel,
				action: "restored-from-snapshot",
				detail: "did not exist at boot and was not authorised — removed",
			};
		} catch (error: unknown) {
			return {
				at: Date.now(),
				rel: file.rel,
				action: "cannot-restore",
				detail: `appeared after boot and could not be removed: ${(error as Error)?.message ?? String(error)}`,
			};
		}
	}
	try {
		writeFileSync(file.abs, baseline.content);
		return {
			at: Date.now(),
			rel: file.rel,
			action: "restored-from-snapshot",
			detail: baseline.matchesIndex
				? "git checkout did not take; wrote the boot snapshot back"
				: "the file had uncommitted work at boot, so git could not restore it — wrote the boot snapshot back",
		};
	} catch (error: unknown) {
		return {
			at: Date.now(),
			rel: file.rel,
			action: "cannot-restore",
			detail: `writing the boot snapshot back failed: ${(error as Error)?.message ?? String(error)}`,
		};
	}
};

export interface WatchOptions {
	root: string;
	baselines: Baseline[];
	debounceMs: number;
	/** Consulted at the moment a change is seen, not when the watch is set up. */
	authorised: () => boolean;
	onIncident: (incident: Incident) => void;
}

/**
 * Watch the protected files and put back what changes without authorisation.
 *
 * Both mechanisms, on purpose. `fs.watch` on the *directory* rather than the
 * file, because an editor saving atomically writes a temp file and renames it
 * over the target: the inode the file watch was holding is gone and the watch
 * dies silently. `fs.watchFile` polls, so it survives that and covers the case
 * where the directory watch never fires at all. Both feed the same debounce, so
 * the doubling costs nothing but a cancelled timer.
 */
export const watchProtected = (options: WatchOptions): (() => void) => {
	const { root, baselines, debounceMs, authorised, onIncident } = options;
	const byDir = new Map<string, Baseline[]>();
	for (const baseline of baselines) {
		const dir = dirname(baseline.file.abs);
		byDir.set(dir, [...(byDir.get(dir) ?? []), baseline]);
	}

	const timers = new Map<string, NodeJS.Timeout>();
	/** Set while this module is writing, so its own restore does not re-trigger. */
	let settling = false;

	const check = (baseline: Baseline) => {
		if (settling) return;
		const now = currentBlob(baseline.file.abs);
		if (now === baseline.blob) return;
		if (authorised()) {
			// The new content becomes the baseline: when the unlock lapses, what is
			// on disk then is what is defended, not what was there before Abhi
			// started. Anything else would silently revert his work an hour later.
			baseline.content = existsSync(baseline.file.abs) ? readFileSync(baseline.file.abs) : null;
			baseline.blob = now;
			baseline.matchesIndex = indexBlob(root, baseline.file.rel) === now;
			onIncident({
				at: Date.now(),
				rel: baseline.file.rel,
				action: "accepted-under-unlock",
				detail: `changed while unlocked — this is the baseline now (${now.slice(0, 8) || "deleted"})`,
			});
			return;
		}
		settling = true;
		try {
			onIncident(restoreFile(root, baseline));
		} finally {
			// Long enough for the write to land and the watch to fire on it.
			setTimeout(() => {
				settling = false;
			}, Math.max(50, debounceMs)).unref?.();
		}
	};

	const schedule = (baseline: Baseline) => {
		clearTimeout(timers.get(baseline.file.abs));
		const t = setTimeout(() => {
			timers.delete(baseline.file.abs);
			check(baseline);
		}, debounceMs);
		t.unref?.();
		timers.set(baseline.file.abs, t);
	};

	const watchers: FSWatcher[] = [];
	for (const [dir, group] of byDir) {
		try {
			const w = watch(dir, (_event, name) => {
				for (const baseline of group) {
					if (!name || baseline.file.abs.endsWith(`/${name}`)) schedule(baseline);
				}
			});
			w.on?.("error", () => {
				/* the poll below is the other half, and it does not die on a rename */
			});
			watchers.push(w);
		} catch {
			/* no watch on this directory — the poll still covers it */
		}
	}
	for (const baseline of baselines) {
		watchFile(baseline.file.abs, { interval: Math.max(500, debounceMs * 2) }, () => schedule(baseline));
	}

	return () => {
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
		for (const w of watchers) {
			try {
				w.close();
			} catch {
				/* already closed */
			}
		}
		for (const baseline of baselines) unwatchFile(baseline.file.abs);
	};
};

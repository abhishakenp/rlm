/**
 * The saved-session catalog: every session on disk, subagents included, fast.
 *
 * `SessionManager.listAll` reads `sessions/*.jsonl` and nothing else, so the
 * agents view never saw a saved subagent — they live under the parent's
 * artifact directory (`session-artifacts/<parentId>/sub-<childId>/<id>.jsonl`,
 * and a grandchild under `session-artifacts/<parentId>/session-artifacts/
 * <childId>/sub-…/`). Their headers already name the parent
 * (`parentSession`), and the view already nests a saved row under the row
 * whose path that is, so listing them is all the tree needs.
 *
 * It also re-read all ~6,300 files (510 MB here) on every `rlm -r`, because the
 * only cache was in memory. This one persists, keyed by path + size + mtime:
 * the first pass hands the cached rows to `onSession` before touching the
 * disk, so the view paints from the index, then every file is stat'ed and only
 * the changed ones are re-read. A row that changed is emitted again; the view
 * reconciles by path.
 *
 * Delegated task sessions (`rlm-delegate-<graph>-<task>.jsonl`, ~1,300 here)
 * are the drive's bookkeeping, not anyone's conversation, so the tree leaves
 * them out unless asked (`includeDelegated`).
 *
 * Kept free of UI and daemon types so a catalog subprocess can run it as is.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readSessionInfo, type SessionInfo } from "./session-manager.js";

export const SESSION_CATALOG_CACHE_VERSION = 1;
/** Search text kept per row in the persisted index; the live scan keeps its own 64 KiB. */
const CACHED_SEARCH_TEXT_MAX_CHARS = 2048;
const CACHED_FIRST_MESSAGE_MAX_CHARS = 512;
const DELEGATED_PREFIX = "rlm-delegate-";

export interface SessionCatalogOptions {
	/** `…/agent/sessions`. */
	sessionsDir: string;
	/** `…/agent/session-artifacts`; defaults to the sibling of `sessionsDir`. */
	artifactsDir?: string;
	/** Where the index lives; defaults to `<agent>/session-catalog.json`. `false` disables it. */
	cachePath?: string | false;
	/** Keep rows whose `cwd` resolves to this directory, and their descendants. */
	cwd?: string;
	/** Include the drive's `rlm-delegate-*` task sessions. */
	includeDelegated?: boolean;
	onSession?: (session: SessionInfo) => void;
	onProgress?: (loaded: number, total: number) => void;
}

interface CachedRow {
	size: number;
	mtimeMs: number;
	info: SerializedInfo;
}

type SerializedInfo = Omit<SessionInfo, "created" | "modified"> & { created: number; modified: number };

interface CacheFile {
	version: number;
	rows: Record<string, CachedRow>;
}

export const defaultCatalogCachePath = (sessionsDir: string): string =>
	join(dirname(resolve(sessionsDir)), "session-catalog.json");

export const isDelegatedSessionFile = (path: string): boolean =>
	path.slice(path.lastIndexOf("/") + 1).startsWith(DELEGATED_PREFIX);

const serialize = (info: SessionInfo): SerializedInfo => ({
	...info,
	// A first message can be a pasted file; the row shows one line of it.
	firstMessage: info.firstMessage.slice(0, CACHED_FIRST_MESSAGE_MAX_CHARS),
	allMessagesText: info.allMessagesText.slice(0, CACHED_SEARCH_TEXT_MAX_CHARS),
	created: info.created.getTime(),
	modified: info.modified.getTime(),
});

const deserialize = (info: SerializedInfo): SessionInfo => ({
	...info,
	created: new Date(info.created),
	modified: new Date(info.modified),
});

const readCache = (path: string | false): CacheFile => {
	if (!path || !existsSync(path)) return { version: SESSION_CATALOG_CACHE_VERSION, rows: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
		if (parsed?.version === SESSION_CATALOG_CACHE_VERSION && parsed.rows && typeof parsed.rows === "object") return parsed;
	} catch {
		// A torn or foreign file is rebuilt, never trusted.
	}
	return { version: SESSION_CATALOG_CACHE_VERSION, rows: {} };
};

const writeCache = (path: string | false, cache: CacheFile): void => {
	if (!path) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(cache));
		renameSync(tmp, path);
	} catch {
		// The index is an optimisation; failing to write it costs a slow next open.
	}
};

/** Top-level session files plus every subagent file under the artifact tree. */
export const listSessionFiles = async (sessionsDir: string, artifactsDir: string): Promise<string[]> => {
	const files: string[] = [];
	try {
		for (const name of await readdir(sessionsDir)) if (name.endsWith(".jsonl")) files.push(join(sessionsDir, name));
	} catch {
		// No sessions yet.
	}
	const walk = async (dir: string, underSub: boolean): Promise<void> => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				// Only `sub-*` directories hold child sessions; `harness`, tool
				// output and the rest are skipped without descending.
				if (entry.name.startsWith("sub-")) await walk(path, true);
				else if (entry.name === "session-artifacts" || !underSub) await walk(path, false);
			} else if (underSub && entry.name.endsWith(".jsonl")) {
				files.push(path);
			}
		}
	};
	await walk(artifactsDir, false);
	return files;
};

const matchesCwd = (info: SessionInfo, cwd: string): boolean => resolve(info.cwd || ".") === resolve(cwd);

/**
 * List every saved session, subagents included, newest first.
 *
 * `onSession` sees cached rows immediately and changed rows again once
 * re-read; the returned array is the settled catalog.
 */
export const listSessionCatalog = async (options: SessionCatalogOptions): Promise<SessionInfo[]> => {
	const sessionsDir = resolve(options.sessionsDir);
	const artifactsDir = resolve(options.artifactsDir ?? join(dirname(sessionsDir), "session-artifacts"));
	const cachePath = options.cachePath === undefined ? defaultCatalogCachePath(sessionsDir) : options.cachePath;
	const keepFile = (path: string) => options.includeDelegated || !isDelegatedSessionFile(path);
	const cache = readCache(cachePath);

	// Paint first: whatever the index knows, before any disk access.
	const emitted = new Set<string>();
	const inScope = (info: SessionInfo) => !options.cwd || matchesCwd(info, options.cwd);
	for (const [path, row] of Object.entries(cache.rows)) {
		if (!keepFile(path)) continue;
		const info = deserialize(row.info);
		if (!inScope(info) && !info.parentSessionPath) continue;
		emitted.add(path);
		options.onSession?.(info);
	}

	const files = (await listSessionFiles(sessionsDir, artifactsDir)).filter(keepFile);
	const next: CacheFile = { version: SESSION_CATALOG_CACHE_VERSION, rows: {} };
	const settled: SessionInfo[] = [];
	let loaded = 0;
	for (const path of files) {
		let size: number;
		let mtimeMs: number;
		try {
			const stats = await stat(path);
			size = stats.size;
			mtimeMs = stats.mtimeMs;
		} catch {
			loaded++;
			continue;
		}
		const cached = cache.rows[path];
		let info: SessionInfo | null;
		if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
			info = deserialize(cached.info);
			next.rows[path] = cached;
		} else {
			info = await readSessionInfo(path);
			if (info) {
				next.rows[path] = { size, mtimeMs, info: serialize(info) };
				options.onSession?.(info);
				emitted.add(path);
			}
		}
		loaded++;
		options.onProgress?.(loaded, files.length);
		if (info) settled.push(info);
	}
	writeCache(cachePath, options.includeDelegated ? next : mergeDelegated(cache, next));

	const scoped = options.cwd ? scopeToCwd(settled, options.cwd) : settled;
	scoped.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return scoped;
};

/** Delegated rows are skipped, not deleted: keep their index entries for whoever asks with them. */
const mergeDelegated = (previous: CacheFile, next: CacheFile): CacheFile => {
	for (const [path, row] of Object.entries(previous.rows)) {
		if (isDelegatedSessionFile(path) && !next.rows[path]) next.rows[path] = row;
	}
	return next;
};

/** Rows for `cwd`, plus every descendant of one, whatever cwd the child recorded. */
export const scopeToCwd = (sessions: readonly SessionInfo[], cwd: string): SessionInfo[] => {
	const kept = new Set(sessions.filter((s) => matchesCwd(s, cwd)).map((s) => resolve(s.path)));
	let grew = true;
	while (grew) {
		grew = false;
		for (const s of sessions) {
			if (kept.has(resolve(s.path)) || !s.parentSessionPath) continue;
			if (kept.has(resolve(s.parentSessionPath))) {
				kept.add(resolve(s.path));
				grew = true;
			}
		}
	}
	return sessions.filter((s) => kept.has(resolve(s.path)));
};

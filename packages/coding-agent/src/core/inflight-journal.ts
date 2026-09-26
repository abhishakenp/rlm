/**
 * In-flight journal and subagent relink — what survives a dead process.
 *
 * A turn in progress, the subagents under it, and a result on its way to a
 * parent used to live only in memory. When the process died (crash, kill -9,
 * laptop sleep that never came back, a worker the supervisor restarted), the
 * transcript survived on disk but nothing knew the work had been interrupted:
 * the turn never resumed, the children were orphaned, and a child resumed by
 * hand later answered into a parent that never heard it.
 *
 * Three small files beside each session file carry that state, so any process
 * that opens the session later — `rlm -c`, `rlm -r`, a daemon worker the
 * supervisor restarted — can finish the job:
 *
 *   <session>.jsonl.inflight.json   who has the session open, and whether a turn
 *                                   is in progress (the journal)
 *   <session>.jsonl.recover.lock    one process claims an interrupted session;
 *                                   a second opener backs off
 *   <session>.jsonl.inbox/*.json    results addressed to this session by a child
 *                                   that finished while this session was not
 *                                   running (the relink)
 *
 * The parent↔child links themselves are already on disk: every subagent's
 * header carries `parentSession` and `rlmDepth`, and children live under the
 * parent's artifact directory. So the "registry" is derived from the files, not
 * a second index that could disagree with them.
 *
 * Pure filesystem logic, no UI and no daemon types: the in-process host and the
 * daemon's workers use it the same way.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isProcessAlive } from "../utils/child-process.js";
import { getPsProcessStartId } from "./session-lease.js";
import { getSessionArtifactPathForFile } from "./session-manager.js";

export interface InflightRecord {
	v: 1;
	/** Absolute path of the session file this record describes. */
	sessionFile: string;
	/** Process that has (or last had) the session open. */
	pid: number;
	/** `ps` start id of that process, so a recycled pid is not mistaken for it. */
	startId?: string;
	/**
	 * Identity of the process image. Survives hot reload (it lives on
	 * globalThis) but not execve, so an in-place re-exec — same pid, same start
	 * time — still reads as a different owner.
	 */
	imageId: string;
	/** The session is open in that process. */
	open: boolean;
	/** A turn is in progress (agent_start without agent_end). */
	busy: boolean;
	/** Header fields, copied so recovery need not re-read the session. */
	parentSession?: string;
	depth: number;
	updatedAt: string;
}

export interface InboxMessage {
	id: string;
	/** Session file of the child that produced this result. */
	fromSession: string;
	fromName?: string;
	/** The child's final answer. */
	text: string;
	createdAt: string;
}

export const inflightPath = (sessionFile: string): string => `${sessionFile}.inflight.json`;
export const recoverLockPath = (sessionFile: string): string => `${sessionFile}.recover.lock`;
export const inboxDir = (sessionFile: string): string => `${sessionFile}.inbox`;

/** One id per process image; hot reload re-evaluates this module but keeps globalThis. */
export const currentImageId = (): string => {
	const g = globalThis as { __rlmImageId?: string };
	g.__rlmImageId ??= randomUUID();
	return g.__rlmImageId;
};

/** This process's `ps` start id, computed once (it spawns `ps`). */
export const currentStartId = (): string | undefined => {
	const g = globalThis as { __rlmStartId?: string | null };
	if (g.__rlmStartId === undefined) g.__rlmStartId = getPsProcessStartId(process.pid) ?? null;
	return g.__rlmStartId ?? undefined;
};

const writeAtomic = (path: string, text: string): void => {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
};

export const readInflight = (sessionFile: string): InflightRecord | undefined => {
	try {
		const record = JSON.parse(readFileSync(inflightPath(sessionFile), "utf8")) as InflightRecord;
		return record?.v === 1 && typeof record.pid === "number" ? record : undefined;
	} catch {
		return undefined;
	}
};

export const writeInflight = (
	sessionFile: string,
	fields: Pick<InflightRecord, "open" | "busy" | "depth"> & { parentSession?: string },
): InflightRecord => {
	const record: InflightRecord = {
		v: 1,
		sessionFile,
		pid: process.pid,
		startId: currentStartId(),
		imageId: currentImageId(),
		open: fields.open,
		busy: fields.busy,
		depth: fields.depth,
		...(fields.parentSession ? { parentSession: fields.parentSession } : {}),
		updatedAt: new Date().toISOString(),
	};
	writeAtomic(inflightPath(sessionFile), `${JSON.stringify(record)}\n`);
	return record;
};

export type OwnerProbe = {
	isAlive: (pid: number) => boolean;
	startIdOf: (pid: number) => string | undefined;
};

const defaultProbe: OwnerProbe = { isAlive: isProcessAlive, startIdOf: (pid) => getPsProcessStartId(pid) };

/** Is the process recorded as owning this session still that same, running process? */
export const ownerAlive = (record: InflightRecord, probe: OwnerProbe = defaultProbe): boolean => {
	if (record.pid === process.pid) return record.imageId === currentImageId();
	if (!probe.isAlive(record.pid)) return false;
	if (!record.startId) return true;
	const now = probe.startIdOf(record.pid);
	return now === undefined || now === record.startId;
};

/** A turn was running when its process went away. */
export const wasInterrupted = (record: InflightRecord | undefined, probe?: OwnerProbe): boolean =>
	!!record && record.busy && !ownerAlive(record, probe);

/** The session is open in some live process right now. */
export const isLive = (sessionFile: string, probe?: OwnerProbe): boolean => {
	const record = readInflight(sessionFile);
	return !!record && record.open && ownerAlive(record, probe);
};

/**
 * Claim the right to recover an interrupted session. Exactly one process wins;
 * a lock left by a process that died mid-recovery, or older than `staleMs`, is
 * taken over.
 */
export const claimRecovery = (sessionFile: string, staleMs = 10 * 60_000, probe: OwnerProbe = defaultProbe): boolean => {
	const lock = recoverLockPath(sessionFile);
	const body = `${JSON.stringify({ pid: process.pid, startId: currentStartId(), imageId: currentImageId(), at: Date.now() })}\n`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lock, "wx");
			try {
				writeSync(fd, body);
			} finally {
				closeSync(fd);
			}
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			let holder: { pid?: number; startId?: string; imageId?: string; at?: number } = {};
			try {
				holder = JSON.parse(readFileSync(lock, "utf8"));
			} catch {
				/* unreadable lock: treat as stale */
			}
			const stale =
				typeof holder.at !== "number" ||
				Date.now() - holder.at > staleMs ||
				typeof holder.pid !== "number" ||
				!ownerAlive(
					{
						v: 1,
						sessionFile,
						pid: holder.pid,
						startId: holder.startId,
						imageId: holder.imageId ?? "",
						open: true,
						busy: true,
						depth: 0,
						updatedAt: "",
					},
					probe,
				);
			if (!stale) return false;
			rmSync(lock, { force: true });
		}
	}
	return false;
};

export const releaseRecovery = (sessionFile: string): void => {
	rmSync(recoverLockPath(sessionFile), { force: true });
};

/** First line of a session file: its header, or undefined when it is not a session. */
export const readSessionHeader = (
	file: string,
): { id?: string; parentSession?: string; rlmDepth?: number; cwd?: string } | undefined => {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(8192);
		const n = readSync(fd, buffer, 0, buffer.length, 0);
		const line = buffer.subarray(0, n).toString("utf8").split("\n", 1)[0];
		const header = JSON.parse(line);
		return header?.type === "session" ? header : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

/**
 * Direct children of a session: subagent session files under its artifact
 * directory whose header names it as parent. Both nesting layouts are covered
 * (see session-catalog.ts), bounded in depth so a pathological tree cannot run
 * away.
 */
export const listChildSessions = (sessionFile: string, maxDepth = 4): string[] => {
	const out: string[] = [];
	const walk = (dir: string, depth: number, filesHere = true) => {
		if (depth > maxDepth) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith("sub-") || depth === 0) walk(path, depth + 1);
			} else if (filesHere && entry.name.endsWith(".jsonl")) {
				const header = readSessionHeader(path);
				if (header?.parentSession && sameFile(header.parentSession, sessionFile)) out.push(path);
			}
		}
	};
	// A root's children live under its artifact directory; a subagent's own
	// children live in `sub-*` directories beside its file (measured: a depth-2
	// leaf at `…/<root>/sub-a/sub-b/<id>.jsonl`). Scan both; the parentSession
	// check keeps only this session's children.
	walk(getSessionArtifactPathForFile(sessionFile), 0);
	// Beside the file: descend into `sub-*` only, never read sibling sessions
	// (a root sits among thousands of other roots).
	walk(dirname(sessionFile), 1, false);
	return [...new Set(out)].sort();
};

const sameFile = (a: string, b: string): boolean => {
	if (a === b) return true;
	try {
		const sa = statSync(a);
		const sb = statSync(b);
		return sa.ino === sb.ino && sa.dev === sb.dev;
	} catch {
		return false;
	}
};

/** Children whose turn was running when their process died. */
export const interruptedChildren = (sessionFile: string, probe?: OwnerProbe): string[] =>
	listChildSessions(sessionFile).filter((child) => wasInterrupted(readInflight(child), probe));

/* ─────────────────────────────── inbox ─────────────────────────────── */

/** Leave a child's result for a parent that is not running (or not listening). */
export const postToInbox = (parentSession: string, message: Omit<InboxMessage, "id" | "createdAt">): InboxMessage => {
	const full: InboxMessage = { id: randomUUID(), createdAt: new Date().toISOString(), ...message };
	const dir = inboxDir(parentSession);
	writeAtomic(join(dir, `${Date.now()}-${full.id}.json`), `${JSON.stringify(full)}\n`);
	return full;
};

/**
 * Take every pending message, oldest first. Each file is claimed by renaming it
 * into a per-process name before it is read, so two processes draining the same
 * inbox never both deliver a message.
 */
export const takeInbox = (parentSession: string): InboxMessage[] => {
	const dir = inboxDir(parentSession);
	let names: string[];
	try {
		names = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch {
		return [];
	}
	const out: InboxMessage[] = [];
	for (const name of names) {
		const from = join(dir, name);
		const claimed = `${from}.claimed-${process.pid}-${currentImageId().slice(0, 8)}`;
		try {
			renameSync(from, claimed);
		} catch {
			continue;
		}
		try {
			out.push(JSON.parse(readFileSync(claimed, "utf8")) as InboxMessage);
		} catch {
			/* unreadable: dropped below */
		}
		rmSync(claimed, { force: true });
	}
	return out;
};

export const inboxHasMail = (parentSession: string): boolean => {
	try {
		return readdirSync(inboxDir(parentSession)).some((name) => name.endsWith(".json"));
	} catch {
		return false;
	}
};

/* ───────────────────────────── messages ───────────────────────────── */

export const INTERRUPTED_CUSTOM_TYPE = "rlm.inflight.interrupted";
export const CHILD_RESULT_CUSTOM_TYPE = "rlm.inflight.child_result";

const childLabel = (file: string): string => basename(dirname(file)).replace(/^sub-/, "") || basename(file);

/** What the model reads when it is woken to finish an interrupted turn. */
export const interruptedNotice = (children: string[]): string => {
	const lines = [
		"<rlm_interrupted>",
		"The process running this session stopped while a turn was in progress (crash, kill, or restart).",
		"Continue from the saved transcript. Any model, tool, shell or subagent work in flight may have been partially completed — check before redoing it.",
	];
	if (children.length > 0) {
		lines.push(
			`${children.length} subagent(s) were also interrupted and are being resumed automatically: ${children
				.map(childLabel)
				.join(", ")}. Their results will arrive here as messages. Do not spawn them again.`,
		);
	}
	lines.push("</rlm_interrupted>");
	return lines.join("\n");
};

/** What a parent reads when a child result arrives by the inbox. */
export const childResultText = (messages: InboxMessage[]): string =>
	messages
		.map(
			(m) =>
				`<rlm_child_result from="${m.fromName ?? childLabel(m.fromSession)}" session="${m.fromSession}">\n${m.text}\n</rlm_child_result>`,
		)
		.join("\n\n");

/** For tests and callers that want to know whether anything is on disk at all. */
export const hasJournal = (sessionFile: string): boolean => existsSync(inflightPath(sessionFile));

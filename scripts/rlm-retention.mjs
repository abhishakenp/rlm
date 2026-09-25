#!/usr/bin/env node
/**
 * Retention for the two directories that actually grow: sessions and their
 * artifacts.
 *
 *   node scripts/rlm-retention.mjs                    what would go, and why
 *   node scripts/rlm-retention.mjs --apply            actually remove it
 *   node scripts/rlm-retention.mjs --artifacts-days 3 keep artifacts 3 days
 *   node scripts/rlm-retention.mjs --json             machine-readable plan
 *
 * ## Why the two directories are not treated alike
 *
 * `sessions/<id>.jsonl` is the transcript — the primary forensic record, the
 * thing you read when you want to know what the agent actually did. It is also
 * cheap: 521 MB across 6,000 files, most of them tiny.
 *
 * `session-artifacts/<id>/` is working state: kernel snapshots
 * (`kernel-state.dill`), sub-agent trees, harness scratch. 543 MB, but 94% of
 * the directories are completely empty and eight of them hold 507 MB. Losing an
 * artifact directory costs the ability to *resume* an old session's kernel. It
 * does not cost the record of what happened.
 *
 * So the defaults keep transcripts far longer than the state beside them, and
 * removing an artifact whose transcript is being kept is a deliberate,
 * explained outcome rather than an accident.
 *
 * ## What is never removed, at any threshold
 *
 *   - anything under `--floor-days` (default 3). The size sweep cannot cross
 *     this line either; it is the one number that is not negotiable, because a
 *     session written minutes ago may not have a lease yet at all.
 *   - anything named by a live lease in `session-leases/*\/owner.json` whose pid
 *     is still alive.
 *   - anything named on the command line of a running process, or held open
 *     according to `lsof`.
 *   - anything in `sessions/` that is not a `*.jsonl` file. Agents have cwd'd
 *     into that directory and left `.md`, `.txt` and `.json` output there, and
 *     there is a `.pixel/` index and at least one bare-id *directory*. None
 *     of that is a session and none of it is ours to delete.
 *
 * A session's transcript is removed before its artifact directory, the same
 * order `core/session-file-actions.ts` uses, so an interrupted run can leave an
 * orphaned artifact directory (harmless, and collected next time) but never a
 * transcript pointing at state that is already gone.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const has = (...names) => names.some((n) => argv.includes(n));
const flag = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const num = (name, fallback) => {
	const raw = flag(name, undefined);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		console.error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
		process.exit(2);
	}
	return value;
};

if (has("-h", "--help")) {
	console.log(
		[
			"rlm-retention — prune ~/.rlm/agent/sessions and session-artifacts",
			"",
			"  --apply                 remove; without it this is a dry run",
			"  --root <dir>            agent dir (default $RLM_CODING_AGENT_DIR or ~/.rlm/agent)",
			"  --sessions-days <n>     keep transcripts younger than n days (default 30)",
			"  --artifacts-days <n>    keep artifact dirs younger than n days (default 7)",
			"  --sessions-max-mb <n>   cap sessions/ total, oldest first (0 = uncapped, default 0)",
			"  --artifacts-max-mb <n>  cap session-artifacts/ total (0 = uncapped, default 0)",
			"  --floor-days <n>        nothing younger than this is ever removed (default 3, min 1)",
			"  --json                  print the plan as JSON",
		].join("\n"),
	);
	process.exit(0);
}

const APPLY = has("--apply");
const JSON_OUT = has("--json");
const ROOT = resolve(flag("--root", process.env.RLM_CODING_AGENT_DIR || join(homedir(), ".rlm", "agent")));
const SESSIONS = join(ROOT, "sessions");
const ARTIFACTS = join(ROOT, "session-artifacts");
const LEASES = join(ROOT, "session-leases");

const SESSION_DAYS = num("--sessions-days", 30);
const ARTIFACT_DAYS = num("--artifacts-days", 7);
const SESSION_CAP_MB = num("--sessions-max-mb", 0);
const ARTIFACT_CAP_MB = num("--artifacts-max-mb", 0);
const FLOOR_DAYS = Math.max(1, num("--floor-days", 3));

const DAY_MS = 86_400_000;
const now = Date.now();
const ageDays = (mtimeMs) => (now - mtimeMs) / DAY_MS;

/** A name that could escape the directory it is supposed to be inside. */
const unsafeName = (name) => !name || name === "." || name === ".." || name.includes("/") || name.includes("\\");

/**
 * Session ids whose lease is still held by a living process.
 *
 * The lease directory is keyed by sha256 of the canonical session path, so the
 * id is not in the name — it has to be read out of `owner.json`. A lease whose
 * owner is dead says nothing: `core/session-lease.ts` reaps those, and a stale
 * lease must not pin a session for ever.
 */
function leasedSessionPaths() {
	const held = new Set();
	let entries = [];
	try {
		entries = readdirSync(LEASES);
	} catch {
		return held;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".lock")) continue;
		try {
			const owner = JSON.parse(readFileSync(join(LEASES, entry, "owner.json"), "utf8"));
			if (typeof owner?.sessionPath !== "string" || typeof owner?.pid !== "number") continue;
			try {
				process.kill(owner.pid, 0);
			} catch (error) {
				if (error?.code !== "EPERM") continue;
			}
			held.add(owner.sessionPath);
			held.add(basename(owner.sessionPath).replace(/\.jsonl$/, ""));
		} catch {
			// An unreadable lease is not evidence of life.
		}
	}
	return held;
}

/**
 * Session ids the running process table mentions.
 *
 * A plain substring search over the whole table is not good enough in either
 * direction: it matches an id that merely appears inside some unrelated
 * argument, and on a busy machine that quietly turns the whole run into a
 * no-op nobody can explain. So the ids are extracted by shape — the uuidv7
 * transcripts and the `rlm-delegate-…` ones — plus the basename of any path
 * mentioned under the two directories we prune.
 *
 * `undefined` means the table could not be read at all, which is not the same
 * as "nothing is running": in that case the caller keeps everything.
 */
function mentionedSessionIds() {
	let table;
	for (let attempt = 0; attempt < 2 && table === undefined; attempt++) {
		try {
			table = execFileSync("ps", ["-Ao", "command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
		} catch {
			// `ps` can fail transiently under load; one retry, then give up safely.
		}
	}
	if (table === undefined) return undefined;

	const mentioned = new Set();
	for (const match of table.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
		mentioned.add(match[0]);
	}
	for (const match of table.matchAll(/rlm-delegate-[A-Za-z0-9._-]+/g)) {
		mentioned.add(match[0].replace(/\.jsonl$/, ""));
	}
	for (const directory of [SESSIONS, ARTIFACTS]) {
		const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		for (const match of table.matchAll(new RegExp(`${escaped}/([^\\s'"]+)`, "g"))) {
			mentioned.add(match[1].split("/")[0].replace(/\.jsonl$/, ""));
		}
	}
	return mentioned;
}

/** `du -sk`, batched, because 6,000 recursive walks in JS is not a plan. */
function sizesKb(paths) {
	const sizes = new Map();
	for (let i = 0; i < paths.length; i += 400) {
		const batch = paths.slice(i, i + 400);
		let out = "";
		try {
			out = execFileSync("du", ["-sk", "--", ...batch], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				maxBuffer: 64 * 1024 * 1024,
			});
		} catch (error) {
			// du exits non-zero on an unreadable child but still reports the rest.
			out = error?.stdout ?? "";
		}
		for (const line of out.split("\n")) {
			const match = /^(\d+)\t(.*)$/.exec(line);
			if (match) sizes.set(match[2], Number(match[1]));
		}
	}
	return sizes;
}

/** Paths `lsof` says are open right now. Files only — `+D` on 6,000 dirs is not viable. */
function openPaths(paths) {
	const open = new Set();
	for (let i = 0; i < paths.length; i += 200) {
		const batch = paths.slice(i, i + 200);
		let out = "";
		try {
			out = execFileSync("lsof", ["-Fn", "--", ...batch], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				maxBuffer: 32 * 1024 * 1024,
			});
		} catch (error) {
			// lsof exits 1 when nothing matches, which is the common case.
			out = error?.stdout ?? "";
		}
		for (const line of out.split("\n")) {
			if (line.startsWith("n")) open.add(line.slice(1));
		}
	}
	return open;
}

function listEntries(directory, wantFile) {
	const rows = [];
	let names = [];
	try {
		names = readdirSync(directory);
	} catch {
		return rows;
	}
	for (const name of names) {
		if (unsafeName(name)) continue;
		const path = join(directory, name);
		let stat;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (wantFile ? !stat.isFile() : !stat.isDirectory()) continue;
		rows.push({ name, path, mtimeMs: stat.mtimeMs });
	}
	return rows;
}

const leases = leasedSessionPaths();
const mentioned = mentionedSessionIds();

const sessions = listEntries(SESSIONS, true)
	.filter((row) => row.name.endsWith(".jsonl"))
	.map((row) => ({ ...row, id: row.name.slice(0, -".jsonl".length) }))
	.filter((row) => !unsafeName(row.id));
const artifacts = listEntries(ARTIFACTS, false).map((row) => ({ ...row, id: row.name }));

const sessionIds = new Set(sessions.map((row) => row.id));
const artifactById = new Map(artifacts.map((row) => [row.id, row]));

const sessionSizes = sizesKb(sessions.map((row) => row.path));
const artifactSizes = sizesKb(artifacts.map((row) => row.path));
for (const row of sessions) row.kb = sessionSizes.get(row.path) ?? 0;
for (const row of artifacts) row.kb = artifactSizes.get(row.path) ?? 0;

/**
 * Why this entry is untouchable, or `undefined` if the policy may consider it.
 *
 * An unreadable process table means nothing can be shown to be idle, so the
 * whole run degrades to keeping everything rather than guessing.
 */
function pinnedReason(row) {
	if (ageDays(row.mtimeMs) < FLOOR_DAYS) return `newer than the ${FLOOR_DAYS}d floor`;
	if (leases.has(row.id) || leases.has(row.path)) return "held by a live session lease";
	if (mentioned === undefined) return "process table unavailable";
	if (mentioned.has(row.id)) return "named by a running process";
	return undefined;
}

const removals = [];
const kept = new Map();
const keep = (reason) => kept.set(reason, (kept.get(reason) ?? 0) + 1);

function planSession(row, why) {
	const artifact = artifactById.get(row.id);
	removals.push({
		kind: "session",
		id: row.id,
		path: row.path,
		artifactPath: artifact?.path,
		kb: row.kb + (artifact?.kb ?? 0),
		ageDays: ageDays(row.mtimeMs),
		why,
	});
	if (artifact) artifactById.delete(row.id);
}

for (const row of sessions) {
	const pinned = pinnedReason(row);
	if (pinned) {
		keep(pinned);
		continue;
	}
	if (SESSION_DAYS > 0 && ageDays(row.mtimeMs) < SESSION_DAYS) {
		keep(`transcript younger than ${SESSION_DAYS}d`);
		continue;
	}
	planSession(row, `transcript older than ${SESSION_DAYS}d`);
}

if (SESSION_CAP_MB > 0) {
	const planned = new Set(removals.map((entry) => entry.path));
	let total = sessions.reduce((sum, row) => sum + row.kb, 0);
	const cap = SESSION_CAP_MB * 1024;
	const oldestFirst = sessions
		.filter((row) => !planned.has(row.path) && !pinnedReason(row))
		.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const row of oldestFirst) {
		if (total <= cap) break;
		total -= row.kb;
		planSession(row, `sessions/ over ${SESSION_CAP_MB} MB, oldest first`);
	}
}

for (const row of artifactById.values()) {
	const pinned = pinnedReason(row);
	if (pinned) {
		keep(pinned);
		continue;
	}
	if (ARTIFACT_DAYS > 0 && ageDays(row.mtimeMs) < ARTIFACT_DAYS) {
		keep(`artifacts younger than ${ARTIFACT_DAYS}d`);
		continue;
	}
	removals.push({
		kind: "artifact",
		id: row.id,
		path: row.path,
		kb: row.kb,
		ageDays: ageDays(row.mtimeMs),
		why: sessionIds.has(row.id)
			? `state older than ${ARTIFACT_DAYS}d (its transcript is kept)`
			: `orphaned state older than ${ARTIFACT_DAYS}d`,
	});
}

if (ARTIFACT_CAP_MB > 0) {
	const planned = new Set(removals.map((entry) => entry.artifactPath ?? entry.path));
	let total = artifacts.reduce((sum, row) => sum + row.kb, 0);
	const cap = ARTIFACT_CAP_MB * 1024;
	const oldestFirst = artifacts
		.filter((row) => !planned.has(row.path) && !pinnedReason(row))
		.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const row of oldestFirst) {
		if (total <= cap) break;
		total -= row.kb;
		removals.push({
			kind: "artifact",
			id: row.id,
			path: row.path,
			kb: row.kb,
			ageDays: ageDays(row.mtimeMs),
			why: `session-artifacts/ over ${ARTIFACT_CAP_MB} MB, oldest first`,
		});
	}
}

// Last gate, and the narrowest: a file somebody has open right now, whatever the
// process table said. Directories are covered by the floor and the lease check.
const openNow = openPaths(removals.filter((entry) => entry.kind === "session").map((entry) => entry.path));
const plan = removals.filter((entry) => {
	if (openNow.has(entry.path)) {
		keep("open in a running process");
		return false;
	}
	return true;
});

const totalKb = plan.reduce((sum, entry) => sum + entry.kb, 0);
const mb = (kb) => `${(kb / 1024).toFixed(1)}M`;

if (JSON_OUT) {
	console.log(JSON.stringify({ root: ROOT, apply: APPLY, totalKb, kept: Object.fromEntries(kept), plan }, null, 2));
} else {
	console.log(`${APPLY ? "REMOVING" : "DRY RUN — nothing will be removed"}   root=${ROOT}`);
	console.log(
		`policy: transcripts>${SESSION_DAYS}d, artifacts>${ARTIFACT_DAYS}d, floor=${FLOOR_DAYS}d,` +
			` caps=${SESSION_CAP_MB || "off"}/${ARTIFACT_CAP_MB || "off"} MB`,
	);
	console.log(`${sessions.length} transcript(s), ${artifacts.length} artifact dir(s) examined\n`);
	for (const entry of plan.sort((a, b) => b.kb - a.kb)) {
		console.log(
			`  ${entry.kind.padEnd(8)} ${mb(entry.kb).padStart(7)}  ${entry.ageDays.toFixed(1).padStart(5)}d  ${entry.id}` +
				`\n           ${entry.why}${entry.artifactPath ? `\n           + artifact ${entry.artifactPath}` : ""}`,
		);
	}
	console.log(`\n${plan.length} entr(ies), ${mb(totalKb)} reclaimable`);
	if (kept.size) {
		console.log("\nkept:");
		for (const [reason, count] of [...kept].sort((a, b) => b[1] - a[1])) {
			console.log(`  ${String(count).padStart(6)}  ${reason}`);
		}
	}
	if (!APPLY) console.log("\nre-run with --apply to remove.");
}

if (!APPLY) process.exit(0);

let removed = 0;
let failed = 0;
for (const entry of plan) {
	try {
		// Transcript first, then its state — the order core/session-file-actions.ts
		// uses, so a crash mid-run never leaves a transcript pointing at nothing.
		rmSync(entry.path, { recursive: true, force: true });
		if (entry.artifactPath && existsSync(entry.artifactPath)) {
			rmSync(entry.artifactPath, { recursive: true, force: true });
		}
		removed++;
	} catch (error) {
		failed++;
		console.error(`  failed ${entry.path}: ${error?.message ?? error}`);
	}
}
console.log(`\nremoved ${removed} entr(ies), ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

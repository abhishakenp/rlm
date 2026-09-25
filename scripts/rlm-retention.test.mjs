/**
 * A retention script earns trust by what it refuses to delete.
 *
 * Every case here is a thing that would be a genuine loss: a transcript
 * somebody is still writing, one pinned by a live lease, and the stray files
 * that agents have left lying in the sessions directory and that are not
 * sessions at all. The one deletion case exists mostly to prove the refusals
 * are not vacuous.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const SCRIPT = resolve(import.meta.dirname, "rlm-retention.mjs");
const DAY = 86_400;

function run(root, args = []) {
	const out = execFileSync("node", [SCRIPT, "--root", root, ...args], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return out;
}

function plan(root, args = []) {
	return JSON.parse(run(root, ["--json", ...args]));
}

function aged(path, days) {
	const when = Date.now() / 1000 - days * DAY;
	utimesSync(path, when, when);
}

/** A tree shaped exactly like ~/.rlm/agent, with the mess included. */
function makeRoot() {
	const root = mkdtempSync(join(tmpdir(), "rlm-retention-test-"));
	mkdirSync(join(root, "sessions"), { recursive: true });
	mkdirSync(join(root, "session-artifacts"), { recursive: true });
	mkdirSync(join(root, "session-leases"), { recursive: true });
	return root;
}

function addSession(root, id, days, { artifact = true } = {}) {
	const file = join(root, "sessions", `${id}.jsonl`);
	writeFileSync(file, `{"type":"message","id":"${id}"}\n`);
	if (artifact) {
		const dir = join(root, "session-artifacts", id);
		mkdirSync(join(dir, "sub-deadbeef"), { recursive: true });
		writeFileSync(join(dir, "kernel-state.dill"), "x".repeat(4096));
		aged(join(dir, "sub-deadbeef"), days);
		aged(dir, days);
	}
	aged(file, days);
	return file;
}

/** A lease exactly as core/session-lease.ts writes it: keyed by sha256 of the path. */
function addLease(root, sessionFile, pid) {
	const canonical = resolve(sessionFile);
	const key = createHash("sha256").update(canonical).digest("hex");
	const dir = join(root, "session-leases", `${key}.lock`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "owner.json"),
		JSON.stringify({ version: 1, token: "t", pid, sessionPath: canonical, createdAt: new Date(0).toISOString() }),
	);
}

test("a dry run is the default and removes nothing", () => {
	const root = makeRoot();
	try {
		const file = addSession(root, "01a00000-0000-7000-8000-000000000001", 60);
		const out = run(root);
		assert.match(out, /DRY RUN/);
		assert.match(out, /re-run with --apply/);
		assert.equal(existsSync(file), true);
		assert.equal(existsSync(join(root, "session-artifacts", "01a00000-0000-7000-8000-000000000001")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an old transcript goes with its artifact, a recent one stays", () => {
	const root = makeRoot();
	try {
		const old = addSession(root, "01a00000-0000-7000-8000-000000000002", 60);
		const fresh = addSession(root, "01a00000-0000-7000-8000-000000000003", 1);
		run(root, ["--apply"]);
		assert.equal(existsSync(old), false, "old transcript removed");
		assert.equal(existsSync(join(root, "session-artifacts", "01a00000-0000-7000-8000-000000000002")), false);
		assert.equal(existsSync(fresh), true, "recent transcript kept");
		assert.equal(existsSync(join(root, "session-artifacts", "01a00000-0000-7000-8000-000000000003")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a transcript pinned by a live lease is never removed, however old", () => {
	const root = makeRoot();
	try {
		const file = addSession(root, "01a00000-0000-7000-8000-000000000004", 400);
		addLease(root, file, process.pid);
		const dry = plan(root);
		assert.equal(
			dry.plan.some((entry) => entry.path === file),
			false,
			"a leased transcript must not be planned for removal",
		);
		assert.ok(Object.keys(dry.kept).includes("held by a live session lease"), JSON.stringify(dry.kept));
		run(root, ["--apply"]);
		assert.equal(existsSync(file), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a lease whose owner is dead pins nothing", () => {
	const root = makeRoot();
	try {
		const file = addSession(root, "01a00000-0000-7000-8000-000000000005", 400);
		addLease(root, file, 2_147_483_647);
		run(root, ["--apply"]);
		assert.equal(existsSync(file), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the floor outranks every threshold, including the size cap", () => {
	const root = makeRoot();
	try {
		const file = addSession(root, "01a00000-0000-7000-8000-000000000006", 2);
		run(root, ["--apply", "--sessions-days", "0", "--artifacts-days", "0", "--sessions-max-mb", "0.0001"]);
		assert.equal(existsSync(file), true, "inside the floor, nothing goes");
		assert.equal(existsSync(join(root, "session-artifacts", "01a00000-0000-7000-8000-000000000006")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nothing in sessions/ that is not a transcript is touched", () => {
	const root = makeRoot();
	try {
		const stray = join(root, "sessions", "analysis-report.md");
		writeFileSync(stray, "not a session");
		aged(stray, 400);
		const index = join(root, "sessions", ".pixel");
		mkdirSync(index, { recursive: true });
		writeFileSync(join(index, "base.sig"), "sig");
		aged(index, 400);
		const bareDir = join(root, "sessions", "01a00000-0000-7000-8000-000000000007");
		mkdirSync(bareDir, { recursive: true });
		aged(bareDir, 400);

		run(root, ["--apply", "--sessions-days", "1"]);
		assert.equal(existsSync(stray), true, "stray output kept");
		assert.equal(existsSync(join(index, "base.sig")), true, "pixel index kept");
		assert.equal(existsSync(bareDir), true, "bare-id directory kept");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an orphaned artifact directory is collected, and says so", () => {
	const root = makeRoot();
	try {
		const dir = join(root, "session-artifacts", "01a00000-0000-7000-8000-000000000008");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "kernel-state.dill"), "x".repeat(4096));
		aged(dir, 30);
		const dry = plan(root);
		const entry = dry.plan.find((row) => row.path === dir);
		assert.ok(entry, "orphan planned");
		assert.match(entry.why, /orphaned state older than 7d/);
		run(root, ["--apply"]);
		assert.equal(existsSync(dir), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a transcript kept by policy can still shed its state, and the reason says which", () => {
	const root = makeRoot();
	try {
		const file = addSession(root, "01a00000-0000-7000-8000-000000000009", 20);
		const dir = join(root, "session-artifacts", "01a00000-0000-7000-8000-000000000009");
		const dry = plan(root);
		const entry = dry.plan.find((row) => row.path === dir);
		assert.ok(entry, `artifact planned; got ${JSON.stringify(dry.plan)}`);
		assert.match(entry.why, /its transcript is kept/);
		run(root, ["--apply"]);
		assert.equal(existsSync(file), true, "the record survives");
		assert.equal(existsSync(dir), false, "the resumable state does not");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

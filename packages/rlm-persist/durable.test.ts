/**
 * The properties this seam has to have, checked against the real filesystem and
 * real process deaths rather than against a mock. Each of these is a failure
 * mode that a held descriptor or a buffered stream actually has.
 */
import { deepStrictEqual as deep, ok, strictEqual as eq } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
	appendLine,
	appendedSize,
	closeAllAppends,
	closeAppend,
	DeltaLog,
	jsonChunks,
	openAppends,
	writeAtomic,
} from "/Users/abhi/proj/rlm/packages/rlm-persist/src/durable.ts";

const DIR = mkdtempSync(join(tmpdir(), "rlm-persist-"));
const NODE = process.execPath;
const lines = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean);

test("an append round-trips, and holds one descriptor however many lines it writes", () => {
	const f = join(DIR, "a.jsonl");
	for (let i = 0; i < 500; i++) appendLine(f, JSON.stringify({ i }));
	eq(lines(f).length, 500);
	eq(JSON.parse(lines(f)[499]).i, 499);
	eq(openAppends().filter((h) => h.path === f).length, 1);
	// the handle's own byte count agrees with the filesystem, so a caller with a
	// size policy never needs a statSync per write
	eq(appendedSize(f), statSync(f).size);
	closeAppend(f);
});

test("a torn tail is healed once, not run onto", () => {
	const f = join(DIR, "torn.jsonl");
	writeFileSync(f, '{"ok":1}\n{"half":', "utf8"); // a crash mid-line
	appendLine(f, JSON.stringify({ next: true }));
	const parsed = lines(f).map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return "TORN";
		}
	});
	// the torn line is still torn — nothing can recover it — but it did not
	// swallow the line written after it
	deep(parsed, [{ ok: 1 }, "TORN", { next: true }]);
	closeAppend(f);
});

test("a rotate under a held descriptor does not send writes into the orphan", () => {
	const f = join(DIR, "rot.jsonl");
	appendLine(f, "one");
	// the owner rotates, the honest way: let go first
	closeAppend(f);
	renameSync(f, `${f}.old`);
	appendLine(f, "two");
	deep(lines(`${f}.old`), ["one"]);
	deep(lines(f), ["two"]);
	closeAppend(f);
});

test("a rotate done from OUTSIDE the process is noticed and recovered from", async () => {
	const f = join(DIR, "extrot.jsonl");
	appendLine(f, "one");
	// somebody else moves it — no closeAppend, which is the dangerous case
	renameSync(f, `${f}.old`);
	await new Promise((r) => setTimeout(r, 1100)); // past REVALIDATE_MS
	appendLine(f, "two");
	deep(lines(f), ["two"], "the new file has the new line");
	deep(lines(`${f}.old`), ["one"], "the rotated file did not silently gain it");
	closeAppend(f);
});

test("an unlink from outside is noticed and the file comes back", async () => {
	const f = join(DIR, "unlinked.jsonl");
	appendLine(f, "one");
	unlinkSync(f);
	await new Promise((r) => setTimeout(r, 1100));
	appendLine(f, "two");
	ok(existsSync(f), "writes did not vanish into an unlinked inode");
	deep(lines(f), ["two"]);
	closeAppend(f);
});

test("writeAtomic replaces a file with byte-identical content and never a partial one", () => {
	const f = join(DIR, "atomic.json");
	const doc = { a: [1, 2, 3], b: { c: "x" }, d: "ünïcøde", e: null };
	writeAtomic(f, jsonChunks(doc));
	eq(readFileSync(f, "utf8"), JSON.stringify(doc));
	deep(JSON.parse(readFileSync(f, "utf8")), doc);
	ok(!existsSync(`${f}.tmp`), "the tmp file is gone");
});

test("jsonChunks never builds the whole document as one string", () => {
	const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(50) })) };
	let longest = 0;
	let total = 0;
	for (const c of jsonChunks(big)) {
		if (c.length > longest) longest = c.length;
		total += c.length;
	}
	eq(total, JSON.stringify(big).length, "the chunks are the document");
	ok(longest < 200, `largest single chunk was ${longest} bytes, not the ${total}-byte document`);
});

test("a DeltaLog replays snapshot + changes to the same state a full rewrite would", () => {
	const f = join(DIR, "delta.json");
	const log = new DeltaLog<{ v: Record<string, number> }, { k: string; n: number }>({ path: f, maxDeltaBytes: 1024 });
	writeAtomic(f, jsonChunks({ v: { a: 1 } }));
	log.push({ k: "b", n: 2 });
	log.push({ k: "c", n: 3 });
	log.push({ k: "b", n: 20 }); // an upsert over an earlier one

	const fold = () => {
		const { snapshot, deltas } = log.read();
		const v = { ...(snapshot?.v ?? {}) };
		for (const d of deltas) v[d.k] = d.n;
		return v;
	};
	deep(fold(), { a: 1, b: 20, c: 3 });

	// compaction must produce the same logical document
	const before = fold();
	log.compact(jsonChunks({ v: before }));
	eq(log.deltaBytes, 0, "the change log restarted");
	deep(fold(), before, "compaction changed nothing about the state");
	deep(JSON.parse(readFileSync(f, "utf8")), { v: before });
	log.close();
});

test("a crash between the rename and the truncate replays correctly, because records are upserts", () => {
	const f = join(DIR, "halfcompact.json");
	const log = new DeltaLog<{ v: Record<string, number> }, { k: string; n: number }>({ path: f });
	writeAtomic(f, jsonChunks({ v: { a: 1 } }));
	log.push({ k: "b", n: 2 });
	const fold = () => {
		const { snapshot, deltas } = log.read();
		const v = { ...(snapshot?.v ?? {}) };
		for (const d of deltas) v[d.k] = d.n;
		return v;
	};
	const want = fold();
	// the new snapshot lands, and then the process dies before the log is cleared
	writeAtomic(f, jsonChunks({ v: want }));
	deep(fold(), want, "re-applying a change already folded in is a no-op");
	log.close();
});

test("a hard SIGKILL cannot lose an appended line, and DOES lose a streamed one", () => {
	const held = join(DIR, "kill-held.jsonl");
	const streamed = join(DIR, "kill-stream.jsonl");
	const script = `
import { createWriteStream } from "node:fs";
import { appendLine } from "/Users/abhi/proj/rlm/packages/rlm-persist/src/durable.ts";
for (let i = 0; i < 5; i++) appendLine(${JSON.stringify(held)}, JSON.stringify({ i }));
const s = createWriteStream(${JSON.stringify(streamed)}, { flags: "a" });
for (let i = 0; i < 5; i++) s.write(JSON.stringify({ i }) + "\\n");
process.kill(process.pid, "SIGKILL");
`;
	const scriptPath = join(DIR, "killer.ts");
	writeFileSync(scriptPath, script, "utf8");
	const r = spawnSync(NODE, ["--experimental-strip-types", scriptPath], { encoding: "utf8" });
	eq(r.signal, "SIGKILL", "the child really was killed, not exited");
	eq(lines(held).length, 5, "every held-fd append survived the kill");
	eq(existsSync(streamed) ? lines(streamed).length : 0, 0, "the buffered stream lost all five");
});

test("a SIGKILL in the middle of writeAtomic leaves the old file complete and readable", () => {
	const f = join(DIR, "atomic-kill.json");
	const good = { state: "the version that must survive", rows: [1, 2, 3] };
	writeAtomic(f, jsonChunks(good));
	const script = `
import { writeAtomic } from "/Users/abhi/proj/rlm/packages/rlm-persist/src/durable.ts";
function* poison() {
  yield '{"state":"a replacement that never finished"';
  for (let i = 0; i < 40; i++) yield ',"pad' + i + '":"' + 'x'.repeat(4096) + '"';
  process.kill(process.pid, "SIGKILL");   // mid-write, after real bytes have gone out
  yield "}";
}
writeAtomic(${JSON.stringify(f)}, poison());
`;
	const scriptPath = join(DIR, "atomic-killer.ts");
	writeFileSync(scriptPath, script, "utf8");
	const r = spawnSync(NODE, ["--experimental-strip-types", scriptPath], { encoding: "utf8" });
	eq(r.signal, "SIGKILL", "the child really was killed mid-write");
	deep(JSON.parse(readFileSync(f, "utf8")), good, "the destination is still the old, complete document");
	// The scratch file carries the writer's pid, so two processes rewriting one
	// document cannot truncate each other's half-written bytes.
	const scraps = readdirSync(DIR).filter((n) => n.startsWith(`${basename(f)}.tmp.`));
	ok(scraps.length === 1, `the half-written bytes are in a per-process tmp file, where they harm nobody (found ${scraps.join(", ") || "none"})`);
});

test("closeAllAppends leaves nothing held", () => {
	appendLine(join(DIR, "z1.jsonl"), "a");
	appendLine(join(DIR, "z2.jsonl"), "b");
	ok(openAppends().length >= 2);
	closeAllAppends();
	eq(openAppends().length, 0);
});

process.on("exit", () => {
	closeAllAppends();
	rmSync(DIR, { recursive: true, force: true });
});

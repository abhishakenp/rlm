/**
 * The guard, checked against the shapes an agent actually writes.
 *
 * A test is not what proves this row works — the proof is a real cell going
 * through a real `tool_call` handler and a real file being put back on disk,
 * and both were run by hand before this file existed. What this file is for is
 * the next person: every case below is a spelling that walked through an
 * earlier version of `detect.ts`, so a regression says so instead of quietly
 * reopening the door.
 *
 * Run: node --experimental-strip-types packages/rlm-guard/index.test.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectCell } from "/Users/abhi/proj/rlm/packages/rlm-guard/src/detect.ts";
import { resolveProtected, spellingsFor } from "/Users/abhi/proj/rlm/packages/rlm-guard/src/protect.ts";
import { readBaseline, restoreFile, watchProtected } from "/Users/abhi/proj/rlm/packages/rlm-guard/src/restore.ts";
import { isDelegateChild, unlockState, writeUnlock } from "/Users/abhi/proj/rlm/packages/rlm-guard/src/unlock.ts";

let pass = 0;
let fail = 0;
const t = (name: string, fn: () => void | Promise<void>) => {
	const done = (error?: unknown) => {
		if (error) {
			fail++;
			console.log(`  FAIL ${name}\n       ${(error as Error).message}`);
		} else {
			pass++;
			console.log(`  ok  ${name}`);
		}
	};
	try {
		const out = fn();
		if (out instanceof Promise) return out.then(() => done()).catch(done);
		done();
	} catch (error) {
		done(error);
	}
	return undefined;
};
const ok = (v: unknown, m = "expected truthy") => {
	if (!v) throw new Error(m);
};
const eq = (a: unknown, b: unknown, m = "") => {
	if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ROOT = "/Users/abhi/proj/rlm";
const FILES = resolveProtected(ROOT, [
	{ pattern: "packages/rlm-delegate/src/capacity.ts", why: "the limiter" },
	{ pattern: "packages/rlm-guard/src/**", why: "the guard itself", inherent: true },
	{ pattern: "cordis.yml", why: "the composition", inherent: true },
]);
const blocked = (code: string) => inspectCell(code, ROOT, FILES) !== null;

console.log("\nthe door refuses every shape that reaches capacity.ts");
for (const [name, cell] of [
	["%%bash sed -i", "%%bash\nsed -i '' 's/floor ?? 0.3;/floor ?? 0.0;/' packages/rlm-delegate/src/capacity.ts"],
	["a ! line", "!sed -i '' 's/a/b/' packages/rlm-delegate/src/capacity.ts"],
	["a heredoc redirect", "%%bash\ncat > packages/rlm-delegate/src/capacity.ts <<'EOF'\nnope\nEOF"],
	["an append", "%%bash\necho x >> packages/rlm-delegate/src/capacity.ts"],
	["tee", "%%bash\necho x | tee packages/rlm-delegate/src/capacity.ts"],
	["cp over it", "%%bash\ncp /tmp/x.ts packages/rlm-delegate/src/capacity.ts"],
	["mv over a relative spelling", "%%bash\nmv /tmp/x.ts src/capacity.ts"],
	["rm", "%%bash\nrm packages/rlm-delegate/src/capacity.ts"],
	["git checkout at it", "%%bash\ngit checkout HEAD~5 -- packages/rlm-delegate/src/capacity.ts"],
	["patch", "%%bash\npatch packages/rlm-delegate/src/capacity.ts < /tmp/p.diff"],
	["perl -i", "%%bash\nperl -pi -e 's/a/b/' packages/rlm-delegate/src/capacity.ts"],
	["cd, then a two-segment spelling", "%%bash\ncd packages/rlm-delegate && sed -i '' 's/a/b/' src/capacity.ts"],
	["a shell variable holding the path", "%%bash\nF=packages/rlm-delegate/src/capacity.ts\nsed -i '' 's/a/b/' $F"],
	["a python heredoc", "%%bash\npython3 - <<'PY'\nopen('packages/rlm-delegate/src/capacity.ts','w').write('x')\nPY"],
	["fs.writeFileSync", "fs.writeFileSync('packages/rlm-delegate/src/capacity.ts','x')"],
	["a destructured writeFileSync", "const { writeFileSync } = require('fs'); writeFileSync('capacity.ts','x')"],
	["a JS variable holding the path", "const p = 'packages/rlm-delegate/src/capacity.ts';\nfs.writeFileSync(p,'x')"],
	["path.join", "fs.writeFileSync(path.join('packages/rlm-delegate/src','capacity.ts'),'x')"],
	["execSync with a shell command", "execSync(\"sed -i '' 's/a/b/' packages/rlm-delegate/src/capacity.ts\")"],
	["execFileSync with an argv array", "execFileSync('sed',['-i','','s/a/b/','packages/rlm-delegate/src/capacity.ts'])"],
	["unlinkSync", "fs.unlinkSync('packages/rlm-delegate/src/capacity.ts')"],
	["appendFile", "await fs.promises.appendFile('capacity.ts','x')"],
] as Array<[string, string]>)
	t(name, () => ok(blocked(cell), "should have been refused"));

console.log("\nand it refuses anything that reaches the guard's own footing");
t("a write to the guard's source", () => ok(blocked("fs.writeFileSync('packages/rlm-guard/src/detect.ts','')")));
t("deleting the guard's directory", () => ok(blocked("%%bash\nrm -rf packages/rlm-guard/src")));
t("editing the composition", () => ok(blocked("%%bash\nsed -i '' '/rlm-guard/d' cordis.yml")));
t("disabling the row through the overlay", () => {
	const cell = "%%bash\ncat >> ~/.rlm/cordis.patch.yml <<'EOF'\n- id: guard\n  disabled: true\nEOF";
	const overlay = path.join(process.env.RLM_HOME ?? path.join(os.homedir(), ".rlm"), "cordis.patch.yml");
	const withOverlay = [
		...FILES,
		{ abs: overlay, rel: overlay, spellings: ["cordis.patch.yml"], dirSpellings: [], why: "the overlay", inherent: true, watched: false },
	];
	ok(inspectCell(cell, ROOT, withOverlay) !== null, "an overlay write naming this row should be refused");
});

console.log("\nreading stays open, and so does everything else in the repo");
for (const [name, cell] of [
	["cat", "%%bash\ncat packages/rlm-delegate/src/capacity.ts"],
	["readFileSync", "const s = fs.readFileSync('packages/rlm-delegate/src/capacity.ts','utf8'); s.length"],
	["grep", "%%bash\ngrep -n MEMORY_SHARE packages/rlm-delegate/src/capacity.ts"],
	["an unrelated shell write", "%%bash\necho hi > /tmp/notes.md"],
	["an unrelated JS write", "fs.writeFileSync('/tmp/notes.md','hi')"],
	["an unrelated dynamic write", "const p='/tmp/'+Date.now()+'.md'; fs.writeFileSync(p,'hi')"],
	["a greater-than that is arithmetic, not a redirect", "const a=5,b=2; if (a > b) console.log('yes')"],
	["another package's index.ts", "fs.writeFileSync('packages/rlm-log/src/index.ts','x')"],
	["a file whose name merely ends in capacity.ts", "fs.writeFileSync('/tmp/mycapacity.ts','x')"],
	["a sibling of the protected file", "%%bash\nsed -i '' 's/a/b/' packages/rlm-delegate/src/scheduler.ts"],
] as Array<[string, string]>)
	t(name, () => ok(!blocked(cell), "should have been allowed"));

console.log("\na spelling is only recognised when it cannot mean another file");
t("capacity.ts is unique, so the bare name counts", () =>
	ok(spellingsFor("packages/rlm-delegate/src/capacity.ts", ["packages/rlm-delegate/src/capacity.ts", "a/b/index.ts"]).includes("capacity.ts")));
t("index.ts is not, so the bare name does not", () => {
	const tree = ["packages/rlm-guard/src/index.ts", "packages/rlm-log/src/index.ts"];
	ok(!spellingsFor("packages/rlm-guard/src/index.ts", tree).includes("index.ts"));
	ok(spellingsFor("packages/rlm-guard/src/index.ts", tree).includes("rlm-guard/src/index.ts"));
});

console.log("\nthe unlock is not something a delegated child can grant itself");
t("this test process is not a child", () => eq(isDelegateChild(), false));
t("an absent sentinel is locked", () =>
	eq(unlockState(path.join(os.tmpdir(), "rlm-guard-nope.json"), 60).open, false));
t("a lapsed sentinel is locked", () => {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rlm-guard-")), "u.json");
	fs.writeFileSync(f, JSON.stringify({ until: Date.now() - 1000 }));
	eq(unlockState(f, 60).open, false);
});
t("a sentinel claiming more than the maximum is locked", () => {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rlm-guard-")), "u.json");
	fs.writeFileSync(f, JSON.stringify({ until: Date.now() + 999 * 60_000 }));
	const state = unlockState(f, 60);
	eq(state.open, false);
	ok(state.why.includes("over the 60 allowed"));
});
t("an honest sentinel opens it", () => {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rlm-guard-")), "u.json");
	eq(writeUnlock(f, 5, 60).open, true);
	eq(unlockState(f, 60).open, true);
});

console.log("\nthe backstop puts a file back, and stands down when told to");
await t("an unauthorised change is restored, an authorised one is not", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-guard-repo-"));
	const rel = "limiter.ts";
	const abs = path.join(dir, rel);
	fs.writeFileSync(abs, "export const limit = 1;\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", rel], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: dir });

	const file = { abs, rel, spellings: [rel], dirSpellings: [], why: "test", inherent: false, watched: true };
	const baseline = readBaseline(dir, file);
	ok(baseline.matchesIndex, "the fixture should be clean at HEAD");

	let open = false;
	const incidents: string[] = [];
	const stop = watchProtected({
		root: dir,
		baselines: [baseline],
		debounceMs: 100,
		authorised: () => open,
		onIncident: (i) => incidents.push(i.action),
	});
	try {
		fs.writeFileSync(abs, "export const limit = 999;\n");
		await sleep(1200);
		eq(fs.readFileSync(abs, "utf8"), "export const limit = 1;\n", "should have been put back");
		eq(incidents[0], "restored-from-git");

		open = true;
		fs.writeFileSync(abs, "export const limit = 4;\n");
		await sleep(1200);
		eq(fs.readFileSync(abs, "utf8"), "export const limit = 4;\n", "an authorised change should stand");
		eq(incidents[1], "accepted-under-unlock");
	} finally {
		stop();
	}
});

await t("uncommitted work is restored from the boot snapshot, never from the index", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-guard-repo-"));
	const rel = "limiter.ts";
	const abs = path.join(dir, rel);
	fs.writeFileSync(abs, "committed\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", rel], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: dir });
	fs.writeFileSync(abs, "work in progress\n");

	const file = { abs, rel, spellings: [rel], dirSpellings: [], why: "test", inherent: false, watched: true };
	const baseline = readBaseline(dir, file);
	eq(baseline.matchesIndex, false, "the fixture should be dirty");
	fs.writeFileSync(abs, "an agent's idea\n");
	const incident = restoreFile(dir, baseline);
	eq(incident.action, "restored-from-snapshot");
	eq(fs.readFileSync(abs, "utf8"), "work in progress\n", "the uncommitted work is what comes back");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

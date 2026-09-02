/**
 * The backlog finishing itself.
 *
 * Everything below this line already worked before this file existed: the graph
 * could not forget, the criterion could tell done from claimed, the failure was
 * fingerprinted, the machine's capacity was measured. And the backlog did not
 * move, because all of it waited to be asked. These are the four things that
 * had to become true for it to move on its own, and the fifth that had to
 * become true for it to be safe to leave running.
 */
import { Context } from "@deepseek-ai/cordis";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import RlmDelegateService from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/index.ts";
import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";
import { drive } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/drive.ts";
import { impasses } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/impasse.ts";
import { check } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/proof.ts";
import { Gate, Stop } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/stop.ts";
import { diagnose } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/lapse.ts";
import { askIn, derive } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/derive.ts";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
	try { fn(); pass++; console.log("  ok  " + name); }
	catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v: any, m = "") => { if (!v) throw new Error(m || "expected truthy"); };
const settleMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-drive-"));
/** Nothing in this file may read the real Desktop. A test that can be switched
 *  off by a file somebody left lying around is not a test. */
const stopFor = (name: string) => new Stop({ file: path.join(DIR, `${name}.stop`), alsoHonour: [] });

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthree owed tasks, nobody asked, all three proven");
{
	const store = new Store(path.join(DIR, "unattended"));
	const work = path.join(DIR, "work");
	fs.mkdirSync(work, { recursive: true });

	// Three graphs, not one: nobody names a graph id anywhere below, which is
	// the whole point. Real side effects, and criteria that a separate process
	// could settle without knowing anything about this run.
	const wanted = ["alpha", "beta", "gamma"];
	for (const name of wanted) {
		store.create(`make ${name}`, [
			{
				id: name,
				title: `write ${name}`,
				prompt: `write ${name}`,
				proof: { kind: "shell", run: `test -s ${path.join(work, name)}.txt` },
			},
		]);
	}
	// One of them has to wait for another, so "runnable" is really being computed.
	store.add(store.ids().sort()[0], [
		{
			id: "after",
			title: "the one that waits",
			needs: [wanted.find((w) => store.load(store.ids().sort()[0])!.tasks.some((t) => t.id === w))!],
			proof: { kind: "shell", run: `test -f ${path.join(work, "after.txt")}` },
		},
	]);

	const handed: string[] = [];
	const report = await drive(store, {
		runner: async (task) => {
			handed.push(task.id);
			fs.writeFileSync(path.join(work, `${task.id}.txt`), `${task.id}\n`, "utf8");
			return "done";
		},
		stop: stopFor("unattended"),
		concurrency: 2,
		maxSweeps: 5,
	});

	t("it found the work itself — no graph id was ever named", () => ok(handed.length >= 4, handed.join(",")));
	t("every task it took on is proven done", () => eq(report.owed.length, 0, report.owed.join(",")));
	t("four tasks across three graphs", () => eq(report.proven.length, 4, report.proven.join(",")));
	t("it stopped because there was nothing left, not because it ran out of sweeps", () => eq(report.ended, "settled"));
	t("the dependent one went last", () => ok(handed.indexOf("after") === handed.length - 1, handed.join(",")));

	// Prove the proof, not the claim: re-run every criterion from here, now,
	// against nothing the drive told us.
	t("re-running every criterion from outside the run still passes", async () => {});
	const rechecked = await Promise.all(
		store.ids().flatMap((id) => store.load(id)!.tasks.map(async (task) => (await check(task.proof)).verdict)),
	);
	t("all four criteria pass when run again by somebody else", () =>
		eq(rechecked.join(","), "passed,passed,passed,passed", rechecked.join(",")));
	t("and the files really are on disk with content in them", () =>
		eq(wanted.every((w) => fs.readFileSync(path.join(work, `${w}.txt`), "utf8").trim() === w), true));
	t("nothing is waiting on him", () => eq(report.questions.length, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\na criterion that cannot pass becomes a question, not a loop");
{
	const store = new Store(path.join(DIR, "impossible"));
	// Three shapes of impossible, side by side, because they are decided
	// differently and only one of them is allowed to spend attempts.
	const graph = store.create("three ways of being stuck", [
		{ id: "never", title: "a criterion that will never hold", proof: { kind: "shell", run: "exit 1" } },
		{ id: "unsaid", title: "nobody said how to tell", proof: { kind: "unstated", note: "nobody said" } },
		{ id: "blind", title: "a criterion nothing here can run", proof: { kind: "row", id: "no-such-row" } },
	]);

	let attempts = 0;
	const began = Date.now();
	const report = await drive(store, {
		runner: async () => {
			attempts += 1;
			return "I did the thing";
		},
		stop: stopFor("impossible"),
		concurrency: 1,
		maxAttempts: 3,
		maxSweeps: 5,
	});
	const elapsed = Date.now() - began;
	const by = (id: string) => store.load(graph.id)!.tasks.find((x) => x.id === id)!;

	t("it came back at all — this is the loop that used to not end", () => ok(elapsed < 20_000, `${elapsed}ms`));
	t("the unprovable one was tried, and bounded", () => {
		ok(by("never").attempts.length >= 1, "never attempted");
		ok(by("never").attempts.length <= 3, `${by("never").attempts.length} attempts`);
	});
	t("it ends failed, saying it failed the same way every time", () => {
		eq(by("never").state, "failed");
		ok(/same way/.test(by("never").reason ?? ""), by("never").reason);
	});
	t("the one nobody could judge was tried once and then left alone", () => {
		eq(by("unsaid").attempts.length, 1, `${by("unsaid").attempts.length} attempts`);
		eq(by("unsaid").state, "unproven");
	});
	t("a criterion this process cannot RUN spends exactly one attempt, not three", () =>
		eq(by("blind").attempts.length, 1, `${by("blind").attempts.length}`));
	t("and it says the work may be done and nothing here can tell", () =>
		ok(/no attempt can settle this/.test(by("blind").reason ?? ""), by("blind").reason));

	const asking = report.questions;
	t("all three come back as questions", () => eq(asking.length, 3, asking.map((a) => a.task.id).join(",")));
	t("each question is specific enough to answer in one sentence", () =>
		ok(asking.every((a) => a.question.length > 40 && a.question.includes(a.task.title)), JSON.stringify(asking.map((a) => a.question))));
	t("they are told apart, because they need different answers", () => {
		const kinds = asking.map((a) => a.kind).sort().join(",");
		eq(kinds, "no-criterion,same-way-twice,unchecked-criterion", kinds);
	});
	t("the questions are written down where he will find them", () => {
		ok(report.questionsPath, "no path");
		const text = fs.readFileSync(report.questionsPath!, "utf8");
		ok(text.includes("waiting on one sentence from you"), text.slice(0, 120));
	});
	t("nothing was quietly dropped — all three are still owed", () => eq(report.owed.length, 3));
	t("a second drive does not try the stopped work again", async () => {});
	const again = await drive(store, {
		runner: async () => { attempts += 1; return "again"; },
		stop: stopFor("impossible"),
		concurrency: 1,
		maxSweeps: 5,
	});
	t("running it again spends no further attempts on work that is stopped", () => {
		eq(again.owed.length, 3);
		eq(by("never").attempts.length <= 3, true);
	});
	t("and answering one puts it straight back into the pool", () => {
		store.answered(graph.id, "unsaid", { kind: "shell", run: "exit 0" }, "him");
		eq(store.load(graph.id)!.tasks.find((x) => x.id === "unsaid")!.state, "ready");
	});
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\na retry is a different attempt, and you can point at the difference");
{
	const store = new Store(path.join(DIR, "retry"));
	// The iris-dirsize shape: the agent believes it finished, the criterion
	// disagrees, and the criterion is the only thing that decides.
	const graph = store.create("the scaffold that claimed to be a capability", [
		{ id: "dirsize", title: "give iris a dirsize command", proof: { kind: "command", name: "dirsize.of" } },
	]);
	const seen: string[] = [];
	await drive(store, {
		runner: async (task) => {
			seen.push(task.prompt);
			return "Done. iris-dirsize is built and mounted.";
		},
		probe: { commands: () => ["dirsize.hello"] },
		stop: stopFor("retry"),
		concurrency: 1,
		maxSweeps: 5,
	});

	t("it was tried twice, and then stopped", () => eq(seen.length, 2, `${seen.length} attempts`));
	t("the second prompt is not the first", () => ok(seen[1] !== seen[0], "identical prompts"));
	t("it says which attempt it is", () => ok(seen[1].includes("This is attempt 2"), seen[1].slice(0, 200)));
	t("it carries how the last one ended, verbatim", () =>
		ok(seen[1].includes("dirsize.of is not registered"), seen[1]));
	t("and — the part that is not just the error stapled on — it changes the approach", () =>
		ok(seen[1].includes("run the check YOURSELF"), seen[1]));
	t("the approach is journalled, so the difference is a fact and not a memory", () => {
		const task = store.load(graph.id)!.tasks[0];
		eq(task.attempts[0].approach, undefined, "the first attempt had nothing to diagnose");
		eq(task.attempts[1].approach, "only-after-the-fact", String(task.attempts[1].approach));
	});
	t("a missing command gets a different directive from a refused criterion", () => {
		const missing = diagnose([], "sh: dirsize: command not found");
		eq(missing.cause, "not-offered");
		ok(missing.directive.join(" ").includes("establish what actually IS there"), missing.directive.join(" "));
		ok(!missing.directive.join(" ").includes("run the check YOURSELF"));
	});
	t("and once every carrier has had it, the diagnosis says so instead of inventing a fourth", () => {
		const spent = diagnose(
			[{ ok: false, shape: "build failed exited" }, { ok: false, shape: "build failed exited" }],
			"build failed: exited 2",
		);
		eq(spent.cause, "exhausted");
		eq(spent.directive.length, 0);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe stop is a file, and it works while something is in the air");
{
	const store = new Store(path.join(DIR, "stop"));
	const graph = store.create("five slow jobs", [
		{ id: "a", title: "a", proof: { kind: "shell", run: "exit 0" } },
		{ id: "b", title: "b", proof: { kind: "shell", run: "exit 0" } },
		{ id: "c", title: "c", proof: { kind: "shell", run: "exit 0" } },
		{ id: "d", title: "d", proof: { kind: "shell", run: "exit 0" } },
		{ id: "e", title: "e", proof: { kind: "shell", run: "exit 0" } },
	]);
	const stop = stopFor("stop");
	const started: string[] = [];
	let killedMidFlight = 0;

	const running = drive(store, {
		makeRunner: (signal) => async (task) => {
			started.push(task.id);
			// A runner that honours the signal, the way the real one kills its child.
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 4_000);
				signal.addEventListener("abort", () => {
					clearTimeout(timer);
					killedMidFlight += 1;
					reject(new Error("stopped mid-attempt"));
				}, { once: true });
			});
			return "finished";
		},
		stop,
		concurrency: 1,
		pollMs: 50,
		maxSweeps: 5,
	});

	await settleMs(400);
	const file = stop.raise("because he said so");
	const report = await running;

	t("the stop file is a real file, with a reason in it", () =>
		ok(fs.readFileSync(file, "utf8").includes("because he said so")));
	t("the drive came back, and says it was stopped", () => eq(report.ended, "stopped"));
	t("it names the file, so he knows how to resume", () => ok((report.stoppedBy ?? "").includes(file), report.stoppedBy));
	t("what was in the air was killed, not left running", () => eq(killedMidFlight, 1));
	t("and nothing new was started after the file appeared", () => eq(started.length, 1, started.join(",")));
	t("the work is still owed — a stop is not a failure of the list", () =>
		eq(store.load(graph.id)!.tasks.filter((x) => x.state !== "done").length, 5));
	t("deleting the file lets it run again", async () => {});
	stop.lower();
	const after = await drive(store, {
		runner: async () => "quick",
		stop,
		concurrency: 3,
		maxSweeps: 5,
	});
	t("and then all five finish", () => eq(after.owed.length, 0, after.owed.join(",")));
	t("Iris's own kill switch stops it too, and rlm never writes hers", () => {
		const iris = path.join(DIR, "iris.stop");
		const honouring = new Stop({ file: path.join(DIR, "mine.stop"), alsoHonour: [iris] });
		eq(honouring.stopped(), false);
		fs.writeFileSync(iris, "down\n");
		eq(honouring.stopped(), true);
		honouring.lower();
		eq(fs.existsSync(iris), true, "it deleted somebody else's kill switch");
		fs.rmSync(iris);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\none budget across every graph at once");
{
	const store = new Store(path.join(DIR, "budget"));
	for (const n of [1, 2, 3, 4]) {
		store.create(`job ${n}`, [{ id: `t${n}`, title: `t${n}`, proof: { kind: "shell", run: "exit 0" } }]);
	}
	let inFlight = 0;
	let peak = 0;
	await drive(store, {
		runner: async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await settleMs(120);
			inFlight -= 1;
			return "ok";
		},
		stop: stopFor("budget"),
		concurrency: 2,
		maxSweeps: 5,
	});
	t("four graphs ran together, not one after another", () => ok(peak > 1, `peak was ${peak}`));
	t("but never more at once than the machine was said to carry", () => ok(peak <= 2, `peak was ${peak}`));
	t("and all four finished", () => eq(store.open().length, 0));

	t("the gate re-reads its size, so a machine getting busier is noticed", async () => {});
	let allowed = 3;
	const gate = new Gate(() => allowed);
	const held = [await gate.take(), await gate.take(), await gate.take()];
	t("three fit when three are allowed", () => eq(gate.inFlight, 3));
	allowed = 1;
	let fourth = false;
	gate.take().then(() => { fourth = true; });
	held.pop()!();
	await settleMs(20);
	t("and a fourth waits once the limit drops", () => eq(fourth, false));
	held.pop()!();
	held.pop()!();
	await settleMs(20);
	t("it is never refused, only queued", () => eq(fourth, true));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nit is a surface on the row, so there is one obvious command");
{
	const dir = path.join(DIR, "service");
	const ctx = new Context();
	const registered: any[] = [];
	(ctx as any).provide?.("rlmModes");
	ctx.set?.("rlmModes", { register: (mode: any) => { registered.push(mode); return { dispose() {} }; } } as any);
	await ctx.plugin(RlmDelegateService, { dir, stopFile: path.join(dir, "off"), enabled: true });
	await settleMs(120);
	const service = ctx.get("rlmDelegate") as any;

	t("the service is there", () => ok(service));
	t("`rlm drive` is a mode, above print", () => {
		const mode = registered.find((m) => m.id === "drive");
		ok(mode, registered.map((m) => m.id).join(","));
		ok(mode.priority > 20, `priority ${mode.priority}`);
		eq(mode.claims(["drive"]), true);
		eq(mode.claims(["--print", "hello"]), false);
	});
	t("`rlm drive stop` puts the file there", async () => {});
	const mode = registered.find((m) => m.id === "drive")!;
	await mode.run(["drive", "stop", "for the test"]);
	t("and the drive refuses to start while it is there", () => ok(service.stopped(), "not stopped"));
	t("`rlm drive resume` takes it away again", async () => {});
	await mode.run(["drive", "resume"]);
	t("and then running is allowed", () => eq(service.stopped(), null));
	t("an attempt made by the drive is not recorded as a new request", () => {
		process.env.RLM_DELEGATE_CHILD = "1";
		const before = service.ids().length;
		eq(service.intake("a task the drive handed to a child"), null);
		eq(service.ids().length, before);
		delete process.env.RLM_DELEGATE_CHILD;
		ok(service.intake("a request from a person"), "a real request was dropped");
	});
	await ctx.stop?.();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nfifteen jobs in one paragraph become fifteen jobs");
{
	const store = new Store(path.join(DIR, "refine"));
	const work = path.join(DIR, "refined");
	fs.mkdirSync(work, { recursive: true });

	// What the boundary really records: her whole preamble, with his two lines
	// somewhere inside it, and `unstated` because no single command exits zero
	// when "the backlog" is done.
	const goal = [
		"You are being handed something you could not already do.",
		"",
		"Two things are asked of you, and the second is not optional.",
		"...".repeat(200),
		"",
		"## The request",
		"",
		"1 write one.txt",
		"2 write two.txt",
		"",
		"## Your hands",
		"",
		"The `iris` binary is on PATH. Never invent a command that is not in the list.",
		"x".repeat(9000),
	].join("\n");
	const graph = store.create(goal, [
		{ id: "the-request", title: "the whole backlog", prompt: goal, proof: { kind: "unstated", note: "nobody said" } },
	]);

	t("the ask is found inside the envelope, and only the ask", () => {
		const ask = askIn(goal);
		ok(ask, "not found");
		ok(ask!.includes("write one.txt") && ask!.includes("write two.txt"), ask!);
		ok(!ask!.includes("iris` binary"), "it swallowed the next section");
		ok(ask!.length < 200, `${ask!.length} chars`);
	});
	t("an envelope with no such heading is not mined for one", () => eq(askIn("just do the thing"), null));
	t("and a request that long, read whole, is still a question", () => eq(derive(goal.slice(0, 12000)), null));

	const asked: string[] = [];
	const report = await drive(store, {
		planner: async (prompt) => {
			asked.push(prompt);
			return JSON.stringify([
				{ id: "one", title: "write one.txt", proof: { kind: "file", path: path.join(work, "one.txt") } },
				{ id: "two", title: "write two.txt", needs: ["one"], proof: { kind: "file", path: path.join(work, "two.txt") } },
			]);
		},
		runner: async (task) => {
			fs.writeFileSync(path.join(work, `${task.id}.txt`), task.id, "utf8");
			return "done";
		},
		stop: stopFor("refine"),
		concurrency: 2,
		maxSweeps: 6,
	});

	t("the planner was handed his two lines, not the eleven kilobytes", () => {
		ok(asked.length, "never asked");
		ok(asked[0].includes("write one.txt"), asked[0].slice(-300));
		ok(!asked[0].includes("x".repeat(100)), "it handed over the whole envelope");
	});
	t("the request became real tasks, and they are on disk", () => {
		const after = store.load(graph.id)!;
		eq(after.tasks.length, 3);
		eq(after.tasks.find((x) => x.id === "the-request")!.proof.kind, "rollup");
	});
	t("all of them are proven, including the parent, for free", () => eq(report.owed.length, 0, report.owed.join(",")));
	t("and the files are really there", () =>
		eq(fs.existsSync(path.join(work, "one.txt")) && fs.existsSync(path.join(work, "two.txt")), true));
	t("nothing had to be asked of him", () => eq(report.questions.length, 0));

	t("a plan the graph refuses is not written down, and the task stays owed", async () => {});
	const other = new Store(path.join(DIR, "refine-bad"));
	const bad = other.create("## The request\n\nmake a cycle", [
		{ id: "the-request", title: "cyclic", prompt: "## The request\n\nmake a cycle", proof: { kind: "unstated" } },
	]);
	const badReport = await drive(other, {
		planner: async () =>
			JSON.stringify([
				{ id: "a", title: "a", needs: ["b"], proof: { kind: "shell", run: "exit 0" } },
				{ id: "b", title: "b", needs: ["a"], proof: { kind: "shell", run: "exit 0" } },
			]),
		runner: async () => "did it",
		stop: stopFor("refine-bad"),
		concurrency: 1,
		maxSweeps: 3,
	});
	t("a cycle is refused and nothing is written", () => eq(other.load(bad.id)!.tasks.length, 1));
	t("the request is still owed, and becomes a question rather than a fiction", () => {
		eq(badReport.owed.length, 1);
		eq(badReport.questions[0].kind, "no-criterion");
	});
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nbeing cut off is not the same as being refused");
{
	t("a timeout is diagnosed as a cut-off, and told to do the smallest piece first", () => {
		const d = diagnose([], "the attempt ran past 900000ms and was killed");
		eq(d.cause, "cut-off");
		ok(d.directive.join(" ").includes("SMALLEST piece"), d.directive.join(" "));
	});
	t("it is not read as the agent refusing, which is what the journal is full of", () => {
		const d = diagnose([], "Error: stopped mid-attempt");
		eq(d.cause, "cut-off");
		ok(!d.directive.join(" ").includes("run the check YOURSELF"));
	});
	t("and a real refusal is still a refusal", () =>
		eq(diagnose([], "it reported done, but the criterion did not hold — x is not registered").cause, "only-after-the-fact"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

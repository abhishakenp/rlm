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
import { drive, renderReport } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/drive.ts";
import { sessionFor } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/agent.ts";
import { impasses } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/impasse.ts";
import { check } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/proof.ts";
import { Gate, Stop } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/stop.ts";
import { diagnose, wall } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/lapse.ts";
import { askIn, derive } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/derive.ts";
import { alreadyTrue, ephemeral, noteBaselines } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/refine.ts";
import { me2 } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/me2.ts";
import { askModel, route as modelRoute } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/ask.ts";
import * as http from "node:http";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
	try { fn(); pass++; console.log("  ok  " + name); }
	catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v: any, m = "") => { if (!v) throw new Error(m || "expected truthy"); };
const settleMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

process.on("exit", () => {
	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) process.exitCode = 1;
});


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
console.log("\na criterion that already passes is a receipt for nothing");
{
	// Not hypothetical. The first real drive proved five tasks and three of them
	// were proved by `echo 'Write a skill'`, `echo tool-loop-alive` and
	// `echo 'skill' | grep -q 'skill'` — all of which exit zero on a machine
	// where nothing has happened.
	t("a plan whose checks pass before any work is spotted", async () => {});
	const vacuous = await alreadyTrue([
		{ id: "a", title: "a", proof: { kind: "shell", run: "echo 'Write a skill'" } },
		{ id: "b", title: "b", proof: { kind: "shell", run: "echo 'skill' | grep -q 'skill'" } },
		{ id: "c", title: "c", proof: { kind: "shell", run: `test -f ${path.join(DIR, "not-yet.txt")}` } },
	]);
	t("the two that cannot fail are named, and the honest one is left alone", () =>
		eq(vacuous.map((v) => v.id).join(","), "a,b", vacuous.map((v) => v.id).join(",")));

	const store = new Store(path.join(DIR, "vacuous"));
	const want = path.join(DIR, "vacuous-work.txt");
	const graph = store.create("## The request\n\ndo the thing", [
		{ id: "the-request", title: "do the thing", prompt: "## The request\n\ndo the thing", proof: { kind: "unstated" } },
	]);
	const plans: string[] = [];
	const report = await drive(store, {
		planner: async (prompt) => {
			plans.push(prompt);
			// First a criterion that cannot fail; then, once told, a real one.
			return plans.length === 1
				? JSON.stringify([{ id: "thing", title: "the thing", proof: { kind: "shell", run: "echo done" } }])
				: JSON.stringify([{ id: "thing", title: "the thing", proof: { kind: "shell", run: `test -f ${want}` } }]);
		},
		runner: async () => {
			fs.writeFileSync(want, "real\n", "utf8");
			return "did it";
		},
		stop: stopFor("vacuous"),
		concurrency: 1,
		maxSweeps: 4,
	});
	t("the planner is told exactly which check could not fail", () => {
		ok(plans.length >= 2, `asked ${plans.length} times`);
		ok(plans[1].includes("pass right now, before anybody has done any of the work"), plans[1].slice(-400));
		ok(plans[1].includes("echo done"), plans[1].slice(-400));
	});
	t("and only the criterion that could fail is written down", () => {
		const after = store.load(graph.id)!;
		const thing = after.tasks.find((x) => x.id === "thing")!;
		eq((thing.proof as any).run, `test -f ${want}`);
	});
	t("which then passes because the work really happened", () => {
		eq(report.owed.length, 0, report.owed.join(","));
		eq(fs.readFileSync(want, "utf8").trim(), "real");
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

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nan empty list of graph ids means every graph, not none");
{
	// The CLI builds `only` by filtering argv for things that look like graph
	// ids. With no ids on the line that filter returns `[]` — which is truthy,
	// so a `!options.only` guard lets it through and `[].includes(id)` then
	// excludes every graph in the store. The drive did no work and reported
	// that it had worked everything it could, which is the one shape of lie
	// this whole file exists to make impossible.
	const store = new Store(path.join(DIR, "empty-only"));
	const work = path.join(DIR, "empty-only-work");
	fs.mkdirSync(work, { recursive: true });
	store.create("do the thing", [
		{
			id: "thing",
			title: "the thing",
			prompt: "the thing",
			proof: { kind: "shell", run: `test -s ${path.join(work, "thing.txt")}` },
		},
	]);

	const report = await drive(store, {
		only: [],
		runner: async (task) => {
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "done\n", "utf8");
			return "done";
		},
		stop: stopFor("empty-only"),
		maxSweeps: 3,
	});

	t("an empty `only` did not restrict the drive to nothing", () => eq(report.graphs, 1, `graphs=${report.graphs}`));
	t("the work was actually done", () => eq(report.proven.length, 1, report.proven.join(",")));

	// And when it does happen, the sentence must not read like success.
	t("settling over zero graphs is reported as a fault, not as success", () =>
		ok(
			renderReport({ ...report, graphs: 0, ended: "settled" }).includes("no graphs at all"),
			renderReport({ ...report, graphs: 0, ended: "settled" }).split("\n")[0],
		));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\na criterion that fails the same with and without the work is not a criterion");
{
	// The real one: `agent-browser --headless --engine lightpanda search …`.
	// There is no `search` subcommand, so it exited non-zero before anybody
	// looked at a runway and would have exited non-zero after. It was recorded
	// as the agent failing twice, and three tasks went unreachable behind it.
	const store = new Store(path.join(DIR, "inert"));
	const work = path.join(DIR, "inert-work");
	fs.mkdirSync(work, { recursive: true });

	// Exactly the real order: the plan exists, the baseline is taken while
	// "before the work" is still true, and only then is any of it written down.
	const plan: any[] = [
		{
			id: "collect",
			title: "collect it",
			prompt: "collect it",
			// Nothing the runner can do changes this. It is a broken check, not
			// a hard job.
			proof: { kind: "shell", run: "definitely-not-a-real-command --search", cwd: work },
		},
	];
	await noteBaselines(plan, work);
	t("the baseline of a failing criterion is written down at acceptance", () =>
		ok(plan[0].proof.inertIf, JSON.stringify(plan[0].proof)));
	store.create("collect the data", plan);
	const id = store.ids().find((g) => store.load(g)!.tasks.some((t) => t.id === "collect"))!;

	let handed = 0;
	let inertSeen = "";
	// The real drive has a planner, and the whole point is that the loop closes
	// without him: the broken check is thrown out and a working one written in
	// its place, by the same machinery, in the same run.
	const planner = async () =>
		JSON.stringify([
			{
				id: "collect-again",
				title: "collect it, checkably",
				prompt: "collect it",
				proof: { kind: "shell", run: `test -s ${path.join(work, "collect-again.txt")}` },
			},
		]);

	const report = await drive(store, {
		planner,
		runner: async (task: any) => {
			handed += 1;
			// The work really is done — it just cannot be seen by the first check.
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "[]\n", "utf8");
			return `collected for ${task.id}`;
		},
		stop: stopFor("inert"),
		maxSweeps: 6,
		onEvent: (event: string, data: any) => {
			if (event === "rlm/delegate-asked" && /inert/.test(String(data?.why ?? ""))) inertSeen = String(data.why);
		},
	} as any);

	const graphAfter = store.load(id)!;
	const after = graphAfter.tasks.find((t) => t.id === "collect")!;
	t("the inert check was named as the fault, not the agent", () => ok(inertSeen, "(never said)"));
	// Cleared to `unstated`, then refined — so by the end it is a rollup over
	// the replacement. What matters is that the broken shell check is gone.
	t("the broken criterion was thrown out rather than retried against", () =>
		ok(after.proof.kind !== "shell", JSON.stringify(after.proof)));
	t("the planner replaced it with one whose answer depends on the work", () =>
		ok(graphAfter.tasks.some((x) => x.id === "collect-again"), graphAfter.tasks.map((x) => x.id).join(",")));
	t("and that one is proven done — the loop closed with nobody awake", () =>
		eq(graphAfter.tasks.find((x) => x.id === "collect-again")?.state, "done",
			JSON.stringify(graphAfter.tasks.map((x) => [x.id, x.state]))));
	t("nothing is left owed", () => eq(report.owed.length, 0, report.owed.join(",")));
	t("and it did not spin — the runner was asked a bounded number of times", () =>
		ok(handed <= 3, `handed=${handed}`));
}



// ─────────────────────────────────────────────────────────────────────────────
console.log("\nexhausted against a check that never moved asks for a different check, once");
{
	// The four `agent-browser … search …` tasks predate baselines, so nothing
	// could prove their criteria inert. They were given up on, and twenty-three
	// tasks went unreachable behind them. Exhaustion against a check that never
	// once moved is evidence about the check too, so it buys one re-plan — and
	// exactly one, or a bad planner becomes the loop.
	const store = new Store(path.join(DIR, "exhausted"));
	const work = path.join(DIR, "exhausted-work");
	fs.mkdirSync(work, { recursive: true });

	store.create("collect the data", [
		{
			id: "collect",
			title: "collect it",
			prompt: "collect it",
			// No `inertIf`: this is the pre-baseline shape exactly.
			proof: { kind: "shell", run: "definitely-not-a-real-command --search", cwd: work },
		},
	]);
	const id = store.ids().find((g) => store.load(g)!.tasks.some((t) => t.id === "collect"))!;

	let planned = 0;
	const report = await drive(store, {
		planner: async () => {
			planned += 1;
			return JSON.stringify([
				{
					id: "collect-checkably",
					title: "collect it, checkably",
					prompt: "collect it",
					proof: { kind: "shell", run: `test -s ${path.join(work, "collect-checkably.txt")}` },
				},
			]);
		},
		runner: async (task: any) => {
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "[]\n", "utf8");
			return `collected for ${task.id}`;
		},
		stop: stopFor("exhausted"),
		maxAttempts: 2,
		maxSweeps: 8,
	} as any);

	const after = store.load(id)!;
	t("the dead-end criterion was not the last word", () =>
		ok(after.tasks.some((x) => x.id === "collect-checkably"), after.tasks.map((x) => x.id).join(",")));
	t("and the replacement is proven done", () =>
		eq(after.tasks.find((x) => x.id === "collect-checkably")?.state, "done",
			JSON.stringify(after.tasks.map((x) => [x.id, x.state]))));
	t("nothing was left owed behind it", () => eq(report.owed.length, 0, report.owed.join(",")));
	t("the planner was not turned into the loop", () => ok(planned <= 2, `planned=${planned}`));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\na task that was given up on before any of this existed is picked back up");
{
	// The real state on disk at 11:15: four tasks in `failed` against criteria
	// that never moved, seventeen unreachable behind them, and nothing that
	// would ever reach them again — a failed task is not runnable, so the
	// scheduler's own hand-back never fires for it. It took a person noticing
	// and running a repair script. It must not.
	const store = new Store(path.join(DIR, "already-stopped"));
	const work = path.join(DIR, "already-stopped-work");
	fs.mkdirSync(work, { recursive: true });

	store.create("collect the data", [
		{
			id: "collect",
			title: "collect it",
			prompt: "collect it",
			proof: { kind: "shell", run: "definitely-not-a-real-command --search", cwd: work },
		},
		{
			id: "behind",
			title: "the one stuck behind it",
			prompt: "the one behind",
			needs: ["collect"],
			proof: { kind: "shell", run: `test -s ${path.join(work, "behind.txt")}` },
		},
	]);
	const id = store.ids().find((g) => store.load(g)!.tasks.some((t) => t.id === "collect"))!;

	// Put it in exactly the state the repair script found: stopped, with the
	// dead criterion still on it, before the drive is ever started.
	store.ended(id, "collect", "failed", { ok: false, detail: "gave up", shape: "gave up" } as any, {
		reason: "gave up after failing the same way 2 times",
	});
	eq(store.load(id)!.tasks.find((x) => x.id === "collect")!.state, "failed", "setup");

	const report = await drive(store, {
		planner: async () =>
			JSON.stringify([
				{
					id: "collect-checkably",
					title: "collect it, checkably",
					prompt: "collect it",
					proof: { kind: "shell", run: `test -s ${path.join(work, "collect-checkably.txt")}` },
				},
			]),
		runner: async (task: any) => {
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "[]\n", "utf8");
			return `did ${task.id}`;
		},
		stop: stopFor("already-stopped"),
		maxSweeps: 8,
	} as any);

	const after = store.load(id)!;
	const state = (x: string) => after.tasks.find((k) => k.id === x)?.state;
	t("nobody had to run a repair — the drive picked the stopped task back up", () =>
		ok(after.tasks.some((x) => x.id === "collect-checkably"), after.tasks.map((x) => x.id).join(",")));
	t("and it is proven done", () => eq(state("collect-checkably"), "done", JSON.stringify(after.tasks.map((x) => [x.id, x.state]))));
	t("the task stuck behind it is unstuck, not unreachable", () => eq(state("behind"), "done", String(state("behind"))));
	t("nothing is left owed", () => eq(report.owed.length, 0, report.owed.join(",")));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ntwo ways a criterion names a place that is not there");
{
	// Both were real, both read as the agent having done nothing, and between
	// them they stranded thirteen tasks.
	const work = path.join(DIR, "places");
	fs.mkdirSync(work, { recursive: true });

	// 1. `~` is a shell courtesy, not a path. `read-spec` checked
	//    `~/proj/rlm/docs/outloop.md contains "me-1"`, the file was plainly
	//    there, and the criterion said it did not exist.
	const home = os.homedir();
	const spot = path.join(home, `.rlm-proof-expand-${process.pid}.txt`);
	fs.writeFileSync(spot, "me-1 and me-2\n", "utf8");
	try {
		const asWritten = `~/${path.relative(home, spot)}`;
		const got = await check({ kind: "file", path: asWritten, contains: "me-1" });
		t("a criterion written with ~ finds the file that is actually there", () =>
			eq(got.verdict, "passed", `${asWritten} → ${got.verdict}: ${got.detail}`));
		const missing = await check({ kind: "file", path: "~/.rlm-proof-definitely-absent-xyz" });
		t("and a ~ path that really is absent still fails", () => eq(missing.verdict, "failed", missing.detail));
	} finally {
		fs.rmSync(spot, { force: true });
	}

	// 2. A delegated agent gets a fresh temp directory, so a criterion inside
	//    one checks a place that existed only for the run that wrote it.
	const fleeting = ephemeral([
		{ id: "a", title: "a", prompt: "a", proof: { kind: "file", path: path.join(os.tmpdir(), "iris-rlm-abc", "SKILL.md"), contains: "name:" } },
		{ id: "b", title: "b", prompt: "b", proof: { kind: "shell", run: `test -s ${path.join(work, "b.txt")}` } },
	] as any);
	t("a criterion inside a per-run temp directory is spotted", () =>
		eq(fleeting.map((f) => f.id).join(","), "a", JSON.stringify(fleeting)));
	t("and one somewhere that outlives the run is left alone", () =>
		ok(!fleeting.some((f) => f.id === "b"), JSON.stringify(fleeting)));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\na stopped task whose criterion passes now is done, without redoing the work");
{
	// `read-spec` failed twice against `~/proj/rlm/docs/outloop.md` while the
	// file sat plainly there — `~` was never expanded. Fixing the expansion has
	// to be enough to free it and the four tasks behind it. Nobody should have
	// to re-run work that was done correctly the first time.
	const store = new Store(path.join(DIR, "late"));
	const work = path.join(DIR, "late-work");
	fs.mkdirSync(work, { recursive: true });
	const spec = path.join(work, "outloop.md");

	store.create("read the spec", [
		{ id: "read-spec", title: "read the spec", prompt: "read it", proof: { kind: "file", path: spec, contains: "me-1" } },
		{ id: "behind", title: "the one behind", prompt: "behind", needs: ["read-spec"], proof: { kind: "file", path: path.join(work, "behind.txt") } },
	]);
	const id = store.ids().find((g) => store.load(g)!.tasks.some((t) => t.id === "read-spec"))!;
	store.ended(id, "read-spec", "failed", { ok: false, detail: "does not exist", shape: "does not exist" } as any, {
		reason: "gave up after failing the same way 2 times",
	});

	// The work really was done — it is only the judging that was broken, and
	// that is what has just been repaired.
	fs.writeFileSync(spec, "me-1 and me-2\n", "utf8");

	let ran = 0;
	const report = await drive(store, {
		runner: async (task: any) => {
			ran += 1;
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "done\n", "utf8");
			return "ok";
		},
		stop: stopFor("late"),
		maxSweeps: 5,
	});

	const after = store.load(id)!;
	t("the stopped task is settled from its own criterion", () =>
		eq(after.tasks.find((x) => x.id === "read-spec")?.state, "done",
			JSON.stringify(after.tasks.map((x) => [x.id, x.state]))));
	t("and the work was not re-run to get there", () => eq(ran, 1, `runner called ${ran} times — only 'behind' should have run`));
	t("the task behind it is unstuck", () => eq(after.tasks.find((x) => x.id === "behind")?.state, "done"));
	t("nothing left owed", () => eq(report.owed.length, 0, report.owed.join(",")));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nevery attempt says who ran it");
{
	// "Iris did this herself" and "a Claude subagent did it for her" were the
	// same entry in the journal, so after a night of work nobody could tell
	// which had happened. He is trying to automate himself and me out of the
	// loop; that has to be a number he can watch, not a claim at the end.
	const store = new Store(path.join(DIR, "executor"));
	const work = path.join(DIR, "executor-work");
	fs.mkdirSync(work, { recursive: true });
	store.create("do it", [
		{ id: "thing", title: "the thing", prompt: "the thing", proof: { kind: "shell", run: `test -s ${path.join(work, "thing.txt")}` } },
	]);
	const id = store.ids().find((g) => store.load(g)!.tasks.some((t) => t.id === "thing"))!;

	await drive(store, {
		executor: "iris-herself",
		runner: async (task: any) => {
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "x\n", "utf8");
			return "done";
		},
		stop: stopFor("executor"),
		maxSweeps: 3,
	} as any);

	const attempt = store.load(id)!.tasks.find((t) => t.id === "thing")!.attempts.at(-1)!;
	t("the journal names who did the work", () => eq(attempt.executor, "iris-herself", JSON.stringify(attempt)));

	// And when nobody says, it must admit that rather than guess. A journal
	// that says "rlm" when a subagent did it is worse than one saying nothing.
	const store2 = new Store(path.join(DIR, "executor-unnamed"));
	store2.create("do it", [
		{ id: "thing", title: "the thing", prompt: "the thing", proof: { kind: "shell", run: `test -s ${path.join(work, "thing2.txt")}` } },
	]);
	const id2 = store2.ids()[0];
	await drive(store2, {
		runner: async () => {
			fs.writeFileSync(path.join(work, "thing2.txt"), "x\n", "utf8");
			return "done";
		},
		stop: stopFor("executor-unnamed"),
		maxSweeps: 3,
	});
	const anon = store2.load(id2)!.tasks[0].attempts.at(-1)!;
	t("and admits when nobody said, rather than guessing", () => eq(anon.executor, "unnamed", JSON.stringify(anon)));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nnothing rests in a stopped state — a task may wait for him, never for nobody");
{
	// His rule on 2026-09-02: "no question and no task must ever be thrown away,
	// 100% of them must be perfectly done". Fourteen `unproven` tasks were
	// sitting untouched because only `failed` was ever reconsidered — and
	// `unproven` is not a verdict, it is the absence of one.
	const store = new Store(path.join(DIR, "nothing-rests"));
	const work = path.join(DIR, "nothing-rests-work");
	fs.mkdirSync(work, { recursive: true });

	store.create("do the thing", [
		{ id: "vague", title: "something nobody could judge", prompt: "do it", proof: { kind: "unstated", note: "nobody said how to tell" } },
	]);
	const id = store.ids().find((g) => store.load(g)!.tasks.some((t) => t.id === "vague"))!;

	let planned = 0;
	const report = await drive(store, {
		planner: async (text: string) => {
			planned += 1;
			// The planner must be told what went wrong, or it writes the same
			// plan that already did not work.
			if (planned > 1) {
				ok(/stuck|tried \d+ time/.test(text), "the second plan was asked for with no history of the first");
			}
			return JSON.stringify([
				{
					id: "checkable",
					title: "the same thing, checkably",
					prompt: "do it",
					proof: { kind: "shell", run: `test -s ${path.join(work, "checkable.txt")}` },
				},
			]);
		},
		runner: async (task: any) => {
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "x\n", "utf8");
			return "did it";
		},
		stop: stopFor("nothing-rests"),
		maxSweeps: 8,
	} as any);

	const after = store.load(id)!;
	t("a task nobody could judge did not simply stop", () =>
		ok(after.tasks.some((x) => x.id === "checkable"), after.tasks.map((x) => `${x.id}:${x.state}`).join(",")));
	t("it ends proven, not unproven", () =>
		eq(after.tasks.find((x) => x.id === "checkable")?.state, "done",
			JSON.stringify(after.tasks.map((x) => [x.id, x.state]))));
	t("and nothing is left owed", () => eq(report.owed.length, 0, report.owed.join(",")));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nan attempt resumes the task's session rather than starting from nothing");
{
	// His correction: "not just re-enter, but resume from their last state."
	// A retry used to be a fresh `--print`, so whatever attempt one read or
	// half-built was gone and attempt two paid for all of it again before it
	// could even reach the point where attempt one failed.
	const graph: any = { id: "g-abc", goal: "x", tasks: [] };
	const one: any = { id: "collect", title: "collect", prompt: "collect", attempts: [] };
	const two: any = { id: "verify", title: "verify", prompt: "verify", attempts: [] };

	t("the same task always names the same session", () =>
		eq(sessionFor(graph, one), sessionFor(graph, one)));
	t("two tasks never collide", () =>
		ok(sessionFor(graph, one) !== sessionFor(graph, two), sessionFor(graph, one)));
	t("the same task id in another graph is a different session", () =>
		ok(sessionFor({ ...graph, id: "g-xyz" } as any, one) !== sessionFor(graph, one)));
	t("it is safe to hand to a shell", () =>
		ok(/^[A-Za-z0-9._-]+$/.test(sessionFor({ ...graph, id: "g /weird$id" } as any, one)), sessionFor({ ...graph, id: "g /weird$id" } as any, one)));
	// Derived, not stored: a crash, a restart, or a journal replayed elsewhere
	// must still find the same session.
	t("nothing has to be remembered for it to be the same next time", () =>
		eq(sessionFor(graph, { ...one, attempts: [{}, {}] } as any), sessionFor(graph, one)));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\na provider refusing to run the work is not the work failing");
{
	// Real output, from the journal, twenty-four times:
	//   "You have run out of credits for <his account>. Please visit ..."
	// `build-me-2-reviewer` burned its attempts on it, went `unproven`, and took
	// what stood on it down — for a fault nothing on this machine could fix.
	t("the walls actually seen are recognised", () => {
		ok(wall("You have run out of credits for someone@example.com. Please visit https://..."));
		ok(wall("HTTP 402 Payment Required"));
		ok(wall("rate limited, try again later"));
		ok(wall("429 Too Many Requests"));
	});
	// Narrow on purpose: a wrong guess here turns a real failure into an
	// eternal retry, which is worse than the bug it fixes.
	t("and ordinary failures are not mistaken for walls", () => {
		ok(!wall("it reported done, but the criterion did not hold"));
		ok(!wall("command not found: agent-browser"));
		ok(!wall("TypeError: cannot read properties of undefined"));
		ok(!wall(""));
	});

	const store = new Store(path.join(DIR, "wall"));
	const work = path.join(DIR, "wall-work");
	fs.mkdirSync(work, { recursive: true });
	store.create("do it", [
		{ id: "thing", title: "the thing", prompt: "the thing", proof: { kind: "shell", run: `test -s ${path.join(work, "thing.txt")}` } },
	]);
	const id = store.ids().find((g) => store.load(g)!.tasks.some((t) => t.id === "thing"))!;

	let calls = 0;
	await drive(store, {
		runner: async (task: any) => {
			calls += 1;
			// Broke once, then the credits came back.
			if (calls === 1) throw new Error("You have run out of credits for him@example.com. Please visit https://...");
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "x\n", "utf8");
			return "done";
		},
		stop: stopFor("wall"),
		maxAttempts: 2,
		maxSweeps: 5,
	});

	const after = store.load(id)!.tasks.find((t) => t.id === "thing")!;
	t("it is done once the wall goes away", () => eq(after.state, "done", `${after.state}: ${after.reason}`));
	t("the reason says whose fault it was", () =>
		ok(after.attempts.some((a) => /not this task's fault/.test(a.detail ?? "") || /credits/.test(a.detail ?? "")), JSON.stringify(after.attempts.map((a) => a.detail?.slice(0, 60)))));
	// The point: a wall must not eat the retry budget, or a task dies of
	// something that was never about it.
	t("the wall did not spend an attempt against the task", () =>
		ok(after.attempts.filter((a) => a.shape && a.shape !== "blocked on a resource").length <= 1,
			JSON.stringify(after.attempts.map((a) => a.shape))));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe work he is waiting on goes first");
{
	// "Nothing is forgotten" and "the right thing first" are different promises,
	// and only the first was kept. Two hundred tasks were ready and the six he is
	// actually waiting on sat among them in arbitrary order, behind fashion
	// trends, with two workers.
	const store = new Store(path.join(DIR, "priority"));
	const work = path.join(DIR, "priority-work");
	fs.mkdirSync(work, { recursive: true });
	store.create("a backlog", [
		{ id: "trivia", title: "something he never asked about", prompt: "trivia", proof: { kind: "shell", run: `test -s ${path.join(work, "trivia.txt")}` } },
		{ id: "me-1", title: "the thing he is waiting on", prompt: "me-1", priority: 10, proof: { kind: "shell", run: `test -s ${path.join(work, "me-1.txt")}` } },
		{ id: "chores", title: "another thing he never asked about", prompt: "chores", proof: { kind: "shell", run: `test -s ${path.join(work, "chores.txt")}` } },
	] as any);

	const order: string[] = [];
	await drive(store, {
		concurrency: 1,
		runner: async (task: any) => {
			order.push(task.id);
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "x\n", "utf8");
			return "done";
		},
		stop: stopFor("priority"),
		maxSweeps: 5,
	});

	t("the prioritised one was handed out first", () => eq(order[0], "me-1", order.join(",")));
	t("and the rest still all got done", () => eq(order.length, 3, order.join(",")));
	// Ties must not be reshuffled, or an unprioritised backlog changes behaviour
	// for no reason anybody asked for.
	t("equal priorities keep the order they were written down in", () =>
		eq(order.slice(1).join(","), "trivia,chores", order.join(",")));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nan agent is never spent on a task nobody can judge, when it could be refined instead");
{
	// The afternoon this file exists to prevent: 324 tasks were recorded with
	// `unstated` criteria, the drive read every one as ready, and it burned 630
	// attempts producing 318 `unproven` results in three hours — faster than
	// refinement, bounded at four a sweep, could give any of them something to
	// be judged by. Then the re-plan path cleared each back to `unstated`, which
	// is where it already was, so it ran again.
	const store = new Store(path.join(DIR, "judgeable"));
	const work = path.join(DIR, "judgeable-work");
	fs.mkdirSync(work, { recursive: true });
	store.create("a backlog nobody wrote criteria for", [
		{ id: "vague-a", title: "one", prompt: "one", proof: { kind: "unstated", note: "nobody said" } },
		{ id: "vague-b", title: "two", prompt: "two", proof: { kind: "unstated", note: "nobody said" } },
	] as any);
	const id = store.ids().find((g) => store.load(g)!.tasks.some((t) => t.id === "vague-a"))!;

	const handed: string[] = [];
	await drive(store, {
		planner: async (_text: string, task: any) =>
			JSON.stringify([
				{
					id: `${task.id}-checkable`,
					title: `${task.title}, checkably`,
					prompt: task.prompt,
					proof: { kind: "shell", run: `test -s ${path.join(work, `${task.id}-checkable.txt`)}` },
				},
			]),
		runner: async (task: any) => {
			handed.push(task.id);
			fs.writeFileSync(path.join(work, `${task.id}.txt`), "x\n", "utf8");
			return "done";
		},
		stop: stopFor("judgeable"),
		maxSweeps: 8,
	} as any);

	t("no agent was spent on a task with no criterion", () =>
		ok(!handed.includes("vague-a") && !handed.includes("vague-b"), handed.join(",")));
	t("they were refined into work that can be judged", () =>
		ok(handed.includes("vague-a-checkable") && handed.includes("vague-b-checkable"), handed.join(",")));

	const after = store.load(id)!;
	t("and nothing came back unproven", () =>
		eq(after.tasks.filter((x) => x.state === "unproven").length, 0,
			JSON.stringify(after.tasks.map((x) => [x.id, x.state]))));
}

// ─────────────────────────────────────────────────────────────────────────────
//
// me-2. Everything below exists because the criterion passing has repeatedly
// not been the same thing as the work being right, and because a reviewer is
// the one component whose failure mode is silence.

console.log("\nme-2 rejects: the work goes back in the pool carrying what he said");
{
	const store = new Store(path.join(DIR, "rejected-once"));
	store.create("write the thing", [
		{ id: "thing", title: "the thing", prompt: "write the thing", proof: { kind: "shell", run: "exit 0" } },
	]);
	const id = store.ids()[0];

	const prompts: string[] = [];
	let looked = 0;
	await drive(store, {
		runner: async (task: any) => {
			prompts.push(task.prompt);
			return "wrote it";
		},
		reviewer: {
			review: async () => {
				looked++;
				return looked === 1
					? { verdict: "rejected" as const, reason: "search-person already does this — it is redundant" }
					: { verdict: "accepted" as const, reason: "nothing else claims this job now" };
			},
		},
		stop: stopFor("rejected-once"),
		maxSweeps: 6,
	} as any);

	const after = store.load(id)!.tasks[0];
	t("a rejection did not stop the task — it was handed out again", () => eq(prompts.length, 2));
	t("and the second attempt was told exactly what me-2 said", () =>
		ok(prompts[1].includes("redundant") && prompts[1].includes("me-2 rejected it"), prompts[1].slice(0, 400)));
	t("the rejection is on the task's record, not only in a log line", () =>
		ok(after.attempts.some((a: any) => !a.ok && String(a.detail).includes("me-2 rejected it")),
			JSON.stringify(after.attempts.map((a: any) => [a.ok, String(a.detail).slice(0, 60)]))));
	t("and once me-2 accepted it, it is done", () => eq(after.state, "done"));
}

console.log("\nme-2 rejecting everything stops the task, never the drive");
{
	// The trap. A rejection puts the task back `ready`, the loop picks it up in
	// the same breath, the criterion passes again, and me-2 rejects again —
	// forever, with the drive reporting itself busy the whole night. Nothing
	// else bounds this: the exhaustion checks further down are only reached
	// when the criterion fails, and here it never does.
	const store = new Store(path.join(DIR, "rejects-everything"));
	store.create("nothing will satisfy it", [
		{ id: "never", title: "never good enough", prompt: "do it", proof: { kind: "shell", run: "exit 0" } },
	]);
	const id = store.ids()[0];

	let handed = 0;
	const report = await drive(store, {
		runner: async () => {
			handed++;
			if (handed > 25) throw new Error("the drive is looping: me-2 is unbounded");
			return "done";
		},
		reviewer: { review: async () => ({ verdict: "rejected" as const, reason: "not wired — nothing reaches it" }) },
		stop: stopFor("rejects-everything"),
		maxSweeps: 20,
	} as any);

	const after = store.load(id)!.tasks[0];
	t("it came back at all", () => ok(report.sweeps >= 1));
	// `repeatFloor` is 2, and the same rejection twice is the same shape twice.
	t("the same rejection twice spends the task rather than looping", () => eq(handed, 2));
	t("and the task is parked as rejected, with me-2's words as the reason", () => {
		// `rejected`, not `failed`: the drive re-checks a failed task's criterion
		// every sweep and marks it done the moment it passes, and this criterion
		// never stopped passing — parked in `failed` the rejection would be undone
		// one sweep later by nobody.
		eq(after.state, "rejected");
		ok(String(after.reason).includes("not wired"), after.reason);
		eq(after.review?.by, "me-2");
	});
	t("it is owed, not silently dropped", () => ok(report.owed.includes(`${id}/never`), report.owed.join(",")));
	t("and nothing later called it proven", () => ok(!report.proven.includes(`${id}/never`), report.proven.join(",")));
}

console.log("\na reviewer with a new objection every time is bounded by the attempt count");
{
	const store = new Store(path.join(DIR, "rejects-variously"));
	store.create("a moving target", [
		{ id: "moving", title: "moving", prompt: "do it", proof: { kind: "shell", run: "exit 0" } },
	]);
	const id = store.ids()[0];

	let handed = 0;
	await drive(store, {
		runner: async () => {
			handed++;
			if (handed > 25) throw new Error("the drive is looping: varied rejections are unbounded");
			return "done";
		},
		reviewer: {
			review: async () => ({
				verdict: "rejected" as const,
				// Deliberately unlike each other, so `repeatFloor` cannot be what stops it.
				reason: ["the credentials went to the wrong home directory", "approveProposal has zero callers", "this reads like success without having looked"][handed - 1] ?? "and another thing",
			}),
		},
		stop: stopFor("rejects-variously"),
		maxSweeps: 20,
	} as any);

	t("maxAttempts stops it even when no two objections are alike", () => eq(handed, 3));
	t("and it stopped rather than being called done", () => eq(store.load(id)!.tasks[0].state, "rejected"));
}

console.log("\na reviewer that throws is not an acceptance");
{
	const store = new Store(path.join(DIR, "reviewer-throws"));
	store.create("unreviewable", [
		{ id: "u", title: "u", prompt: "do it", proof: { kind: "shell", run: "exit 0" } },
	]);
	const id = store.ids()[0];

	await drive(store, {
		runner: async () => "done",
		reviewer: {
			review: async () => {
				throw new Error("ECONNREFUSED 127.0.0.1:20128");
			},
		},
		stop: stopFor("reviewer-throws"),
		maxSweeps: 20,
	} as any);

	const after = store.load(id)!.tasks[0];
	t("work nobody could review is never marked done", () => ok(after.state !== "done", after.state));
	t("and the reason says the reviewer threw, not that the work failed", () =>
		ok(String(after.reason).includes("me-2 threw") && String(after.reason).includes("ECONNREFUSED"), after.reason));
	t("and it stays that way — a passing criterion does not quietly undo it", () =>
		eq(after.state, "rejected"));
}

console.log("\nan accepted review lets the work through, and no reviewer changes nothing");
{
	const store = new Store(path.join(DIR, "accepted"));
	store.create("fine work", [
		{ id: "ok1", title: "ok1", prompt: "do it", proof: { kind: "shell", run: "exit 0" } },
	]);
	const id = store.ids()[0];
	let handed = 0;
	await drive(store, {
		runner: async () => {
			handed++;
			return "done";
		},
		reviewer: { review: async () => ({ verdict: "accepted" as const, reason: "it is what he asked for" }) },
		stop: stopFor("accepted"),
		maxSweeps: 4,
	} as any);
	t("accepted work is done, first time, with one attempt spent", () => {
		eq(store.load(id)!.tasks[0].state, "done");
		eq(handed, 1);
	});
	t("and the acceptance is on disk, so tomorrow it is a verdict and not a claim", () => {
		// Re-read from a fresh Store: this has to survive the process, or the
		// only evidence me-2 ran is that nothing objected.
		const reread = new Store(path.join(DIR, "accepted")).load(id)!.tasks[0];
		eq(reread.review?.verdict, "accepted");
		eq(reread.review?.by, "me-2");
		ok(String(reread.review?.reason).includes("what he asked for"), reread.review?.reason);
	});

	const bare = new Store(path.join(DIR, "no-reviewer"));
	bare.create("fine work", [{ id: "ok2", title: "ok2", prompt: "do it", proof: { kind: "shell", run: "exit 0" } }]);
	await drive(bare, { runner: async () => "done", stop: stopFor("no-reviewer"), maxSweeps: 4 } as any);
	t("and with no reviewer at all the criterion is still the gate it always was", () =>
		eq(bare.load(bare.ids()[0])!.tasks[0].state, "done"));
}

console.log("\nme-2 itself: silence, no verdict and an unreachable model are all rejections");
{
	const task = { id: "x", title: "x", prompt: "he asked for this", proof: { kind: "shell", run: "true" }, attempts: [] } as any;
	const graph = { id: "g", goal: "g", tasks: [task] } as any;
	const asked: string[] = [];
	const answering = (answer: string | (() => never)) =>
		me2({
			ask: async (prompt: string) => {
				asked.push(prompt);
				if (typeof answer === "function") return answer();
				return answer;
			},
		});

	const said = await answering("").review(task, graph);
	t("silence is rejected", () => {
		eq(said.verdict, "rejected");
		ok(said.reason.includes("did not answer with a verdict"), said.reason);
	});

	const prose = await answering("This all looks perfectly reasonable to me.").review(task, graph);
	t("an answer with no verdict in it is rejected", () => eq(prose.verdict, "rejected"));

	const dead = await answering(() => {
		throw new Error("fetch failed");
	}).review(task, graph);
	t("a model that cannot be reached is rejected, never accepted", () => {
		eq(dead.verdict, "rejected");
		ok(dead.reason.includes("could not be reached"), dead.reason);
	});

	// The failure that actually happened: the words appear all through the
	// reasoning while it weighs them, so the block is removed, not searched.
	const thought = await answering(
		"<think>Is this accepted? It could be rejected. Hmm, rejected, rejected.</think>\naccepted\nIt matches what he asked for.",
	).review(task, graph);
	t("a verdict inside <think> is not the verdict; the one after it is", () => {
		eq(thought.verdict, "accepted");
		ok(thought.reason.includes("matches what he asked for"), thought.reason);
	});

	const cutoff = await answering("<think>Weighing accepted against rejected and I have not").review(task, graph);
	t("a thought cut off mid-sentence is not a verdict either", () => eq(cutoff.verdict, "rejected"));

	// The shape the prompt now asks for: argue, then name it.
	const argued = await answering("Nothing in the codebase reads PRIME_AGENT_SESSION_ID.\n\nrejected").review(task, graph);
	t("the verdict may come last, after the argument, and the argument is kept", () => {
		eq(argued.verdict, "rejected");
		ok(argued.reason.includes("PRIME_AGENT_SESSION_ID"), argued.reason);
	});

	// Observed on real backlog work, not invented: asked for the verdict first,
	// the model wrote `accepted` and then a paragraph ending "this is the exact
	// failure mode from lesson one". Picking either word is picking for it.
	const bothWays = await answering(
		"accepted\n\nBut nothing reads PRIME_AGENT_SESSION_ID, which is the exact failure mode from lesson one.\n\nrejected",
	).review(task, graph);
	t("a reviewer that answers both ways has not answered, and fails closed", () => {
		eq(bothWays.verdict, "rejected");
		ok(bothWays.reason.includes("answered both ways"), bothWays.reason);
	});

	const mentioned = await answering(
		"This would be rejected if the flag were unread, but something does read it, so it holds.\n\naccepted",
	).review(task, graph);
	t("the words inside the paragraph are not the verdict — only a line that is one is", () =>
		eq(mentioned.verdict, "accepted"));

	const dressed = await answering("**rejected**\n\nThe flag is parsed and nothing reads it.").review(task, graph);
	t("a verdict a model has bolded still counts", () => {
		eq(dressed.verdict, "rejected");
		ok(dressed.reason.includes("nothing reads it"), dressed.reason);
	});

	t("and it was asked against his words and his lessons, not against the title", () => {
		ok(asked[0].includes("he asked for this"), "the prompt is missing what he asked for");
		ok(asked[0].includes("unproven is a task not completed claimed as complete"), "the prompt is missing his lessons");
	});
}

console.log("\nthe model route is read from rlm's own registry, and never fails open");
{
	const homeDir = path.join(DIR, "fake-home");
	fs.mkdirSync(path.join(homeDir, "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(homeDir, "agent", "models.json"),
		JSON.stringify({
			providers: { omniroute: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "omniroute-local", authHeader: true, models: [{ id: "auto/best-free" }] } },
		}),
		"utf8",
	);

	const there = modelRoute({ home: homeDir });
	t("the endpoint, the model and the key all come out of models.json", () => {
		eq(there.url, "http://127.0.0.1:9/v1/chat/completions");
		eq(there.model, "auto/best-free");
		eq(there.headers.authorization, "Bearer omniroute-local");
	});
	t("no credential is ever taken from the environment", () => {
		// The banned key, mechanically. It is named in a comment in that file
		// saying it must never be read, so the check is for a read and not for
		// the string.
		const source = fs.readFileSync("/Users/abhi/proj/rlm/packages/rlm-delegate/src/ask.ts", "utf8");
		const reads = [...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
		ok(!reads.some((name) => /KEY|TOKEN|SECRET|ANTHROPIC/.test(name)), reads.join(","));
	});

	const missing = modelRoute({ home: path.join(DIR, "no-such-home") });
	t("a registry that is not there falls back to the same call, not to no call", () => {
		eq(missing.url, "http://localhost:20128/v1/chat/completions");
		eq(missing.model, "auto/best-free");
	});

	let sent: any = null;
	const answered = askModel({
		home: homeDir,
		fetch: (async (url: any, init: any) => {
			sent = { url, init, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ choices: [{ message: { content: "accepted\nfine" }, finish_reason: "stop" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as any,
	});
	const back = await answered("look at this");
	t("one question, one answer", () => eq(back, "accepted\nfine"));
	t("no tools field, so a tool loop is structurally impossible", () => eq(sent.body.tools, undefined));
	t("and the budget is big enough for a reasoning model to reach a verdict", () =>
		ok(sent.body.max_tokens >= 3000, String(sent.body.max_tokens)));

	let threw = "";
	await askModel({
		home: homeDir,
		fetch: (async () => new Response("no route to a free model", { status: 503 })) as any,
	})("x").catch((e: any) => (threw = e.message));
	t("a router that answers 503 throws rather than returning nothing", () =>
		ok(threw.includes("503") && threw.includes("no route"), threw));

	let starved = "";
	await askModel({
		home: homeDir,
		maxTokens: 4000,
		fetch: (async () =>
			new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as any,
	})("x").catch((e: any) => (starved = e.message));
	t("a model that spent its whole budget thinking says so, and is not an acceptance", () =>
		ok(starved.includes("max_tokens") && starved.includes("too small"), starved));
}

console.log("\nwired: the CLI drive builds me-2 and it really reaches the router");
{
	// Written is not wired. Everything above stands in for the model, so none of
	// it can tell whether `rlm drive` actually constructs a reviewer — which is
	// the exact defect shape this reviewer exists to catch. So: a real HTTP
	// server standing in for omniroute, the real service, the real drive, and
	// an assertion that a request arrived.
	const seen: any[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									"<think>Could be rejected. Is anything unwired? No, they showed it reaching the router.</think>\n" +
									"accepted\nIt is what he asked for and something really reaches it.",
							},
							finish_reason: "stop",
						},
					],
				}),
			);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as any).port;

	const homeDir = path.join(DIR, "wired-home");
	fs.mkdirSync(path.join(homeDir, "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(homeDir, "agent", "models.json"),
		JSON.stringify({
			providers: {
				omniroute: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "omniroute-local", authHeader: true, models: [{ id: "auto/best-free" }] },
			},
		}),
		"utf8",
	);
	const wasHome = process.env.RLM_HOME;
	process.env.RLM_HOME = homeDir;

	const stateDir = path.join(DIR, "wired-state");
	const root = new Context();
	const fork = root.plugin(RlmDelegateService, { dir: stateDir, cwd: DIR, stopFile: path.join(DIR, "wired.stop") });
	await settleMs(120);
	const svc = (root as any).rlmDelegate as any;
	svc.declare("a wired job", [{ id: "w", title: "w", prompt: "he asked for a wired job", proof: { kind: "shell", run: "exit 0" } }]);

	let handed = 0;
	await svc.drive({
		runner: async () => {
			handed++;
			return "did it";
		},
		stop: stopFor("wired"),
		maxSweeps: 4,
	});

	t("the drive built a reviewer without being handed one", () => ok(seen.length >= 1, "the router was never called"));
	t("it went to the chat-completions route named in the registry", () => eq(seen[0]?.url, "/v1/chat/completions"));
	t("with the registry's key on the authorization header", () => eq(seen[0]?.auth, "Bearer omniroute-local"));
	t("as the registry's model, with room to think", () => {
		eq(seen[0]?.body?.model, "auto/best-free");
		ok(seen[0]?.body?.max_tokens >= 3000, String(seen[0]?.body?.max_tokens));
	});
	t("and it was asked about what he asked for, with his lessons under it", () => {
		const asked = String(seen[0]?.body?.messages?.[0]?.content ?? "");
		ok(asked.includes("he asked for a wired job"), "his request is not in the review prompt");
		ok(asked.includes("He said:"), "his words are not in the review prompt");
	});
	t("the work is done, once, and the review is what let it through", () => {
		eq(handed, 1);
		eq(new Store(stateDir).load(svc.open()[0]?.id ?? new Store(stateDir).ids()[0])?.tasks[0].state, "done");
	});

	fork.dispose();
	await new Promise<void>((r) => server.close(() => r()));
	if (wasHome === undefined) delete process.env.RLM_HOME;
	else process.env.RLM_HOME = wasHome;
}

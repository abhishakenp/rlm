/**
 * The four things a pool has to be able to say about itself, against real
 * child processes and a real IPC channel.
 *
 *   1. Different sessions run at the same time. That is the whole point.
 *   2. The same session does not. A session is a transcript on disk, and two
 *      tasks appending to it at once do not make two conversations — they make
 *      one file with both halves of two arguments in it.
 *   3. A worker that stops speaking is noticed. A pid is not a worker: wedged in
 *      a native call or spinning in a tool that never returns, it holds its
 *      tasks and answers nothing, and the only bound on that used to be the
 *      forty-five-minute per-attempt timeout.
 *   4. `drain()` finishes what is in flight before the workers go, and says
 *      which of the two things happened.
 *
 * The worker is `pool-worker-echo.fixture.mjs` — the same wire, none of the
 * boot. Everything under test is a property of the conversation between the two
 * processes, not of what the far end does with a prompt, so a fixture that
 * answers in milliseconds tests exactly the same code and needs no model.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPool, type PoolOptions } from "./src/pool.ts";

const ECHO = join(import.meta.dirname, "pool-worker-echo.fixture.mjs");

let pass = 0,
	fail = 0;
const ok = (v: any, m: string) => {
	if (v) {
		pass++;
		console.log("  ok  " + m);
	} else {
		fail++;
		console.log("  FAIL " + m);
	}
};

const task = (id: string) => ({ id, title: id, prompt: id, state: "ready", proof: { kind: "unstated" as const } }) as any;
const graph = (id: string) => ({ id, goal: id, tasks: [] }) as any;

const dir = mkdtempSync(join(tmpdir(), "rlm-pool-"));
const logFor = (name: string) => {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, "");
	return file;
};
const rowsOf = (file: string) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { event: string; at: number; id?: string; session?: string; pid: number });

const build = (options: Partial<PoolOptions>, env: Record<string, string>) =>
	new AgentPool({
		entry: ECHO,
		node: process.execPath,
		runtime: "node",
		// No tsx loader and no re-exec: the fixture is plain ESM JavaScript and is
		// handed straight to the interpreter, which is what `launcher` means here.
		launcher: true,
		env,
		freeFraction: () => 0.9,
		log: () => {},
		...options,
	} as PoolOptions);

const cases: Array<[string, () => Promise<void>]> = [
	[
		"three tasks on three sessions run at the same time",
		async () => {
			const file = logFor("concurrent");
			const pool = build({ slots: 3, heartbeatMs: 500, heartbeatTimeoutMs: 5_000 }, { ECHO_LOG: file, ECHO_DELAY_MS: "400" });
			const started = Date.now();
			const answers = await Promise.all([
				pool.run(task("a"), graph("g1")),
				pool.run(task("b"), graph("g2")),
				pool.run(task("c"), graph("g3")),
			]);
			const elapsed = Date.now() - started;
			await pool.close();
			const rows = rowsOf(file);
			const pids = new Set(rows.map((r) => r.pid));
			ok(answers.every((a) => a.startsWith("echo:")), `all three answered (${JSON.stringify(answers)})`);
			ok(pids.size === 1, `one warm worker took all three, not three processes (pids: ${[...pids].join(", ")})`);
			// Serialised they would be 1200ms; overlapped they are ~400ms.
			ok(elapsed < 900, `they overlapped — ${elapsed}ms for 3x400ms of work`);
			const starts = rows.filter((r) => r.event === "start").map((r) => r.at);
			const ends = rows.filter((r) => r.event === "end").map((r) => r.at);
			ok(Math.max(...starts) < Math.min(...ends), "every task had started before the first one finished");
		},
	],
	[
		"two tasks on the same session are serialised",
		async () => {
			const file = logFor("serialised");
			const pool = build({ slots: 3, heartbeatMs: 500, heartbeatTimeoutMs: 5_000 }, { ECHO_LOG: file, ECHO_DELAY_MS: "300" });
			// `sessionFor(graph, task)` is derived from both ids, so the same pair
			// twice is the same session — which is exactly how a retry, a planner
			// call and a runner call collide in real traffic.
			const [one, two] = await Promise.all([pool.run(task("a"), graph("g")), pool.run(task("a"), graph("g"))]);
			await pool.close();
			const rows = rowsOf(file);
			const sessions = new Set(rows.filter((r) => r.session).map((r) => r.session));
			ok(sessions.size === 1, `both really did name one session (${[...sessions].join(", ")})`);
			ok(Boolean(one) && Boolean(two), "both came back");
			const firstEnd = rows.find((r) => r.event === "end")?.at ?? 0;
			const secondStart = rows.filter((r) => r.event === "start")[1]?.at ?? 0;
			ok(
				rows.filter((r) => r.event === "start").length === 2 && secondStart >= firstEnd,
				`the second started only after the first ended (start2=${secondStart}, end1=${firstEnd}, delta=${secondStart - firstEnd}ms)`,
			);
		},
	],
	[
		"a worker that stops heartbeating is noticed and its task handed on",
		async () => {
			const file = logFor("silent");
			const said: string[] = [];
			const pool = build(
				{
					slots: 1,
					heartbeatMs: 200,
					heartbeatTimeoutMs: 600,
					// Forty-five minutes is the real default. If the heartbeat were
					// not doing the work, this test would take forty-five minutes.
					timeoutMs: 600_000,
					log: (line) => said.push(line),
				},
				// Exactly one worker goes silent — the first to claim it — so the
				// replacement answers and this measures the heartbeat rather than a
				// task that happens to kill every worker it touches.
				{ ECHO_LOG: file, ECHO_DELAY_MS: "50", ECHO_SILENT_AFTER: "1", ECHO_SILENT_CLAIM: `${file}.claim` },
			);
			const answer = await pool.run(task("a"), graph("g"));
			await pool.close();
			const rows = rowsOf(file);
			const pids = [...new Set(rows.map((r) => r.pid))];
			ok(answer.startsWith("echo:"), `the task came back anyway (${answer})`);
			ok(rows.some((r) => r.event === "went-silent"), "the first worker really did go silent while holding it");
			ok(pids.length === 2, `it was finished by a different process (pids: ${pids.join(", ")})`);
			ok(
				said.some((l) => l.includes("has said nothing for")),
				`the pool named the reason — saw: ${said.filter((l) => l.includes("worker")).slice(0, 4).join(" | ")}`,
			);
		},
	],
	[
		"drain finishes work in flight, and says so by name",
		async () => {
			const file = logFor("drain");
			const said: string[] = [];
			const pool = build(
				{ slots: 2, heartbeatMs: 500, heartbeatTimeoutMs: 5_000, log: (line) => said.push(line) },
				{ ECHO_LOG: file, ECHO_DELAY_MS: "600" },
			);
			const running = pool.run(task("a"), graph("g1"));
			// Long enough that the worker is up and holding it, short enough that it
			// is nowhere near finished.
			await new Promise((r) => setTimeout(r, 300));
			const how = await pool.drain(10_000);
			const answer = await running;
			ok(how === "drained", `drain reported the case by name (${how})`);
			ok(answer.startsWith("echo:"), `the task in flight finished rather than being killed (${answer})`);
			ok(rowsOf(file).some((r) => r.event === "end"), "the worker got to the end of its task");
			ok(pool.isClosed(), "and the pool is closed afterwards");
			ok(
				said.some((l) => l.includes("drained — everything in flight finished")),
				`it said which case happened — saw: ${said.filter((l) => l.includes("drain")).join(" | ")}`,
			);
		},
	],
	[
		"a drain that runs out of time says that instead, and still lets go",
		async () => {
			const file = logFor("drain-timeout");
			const said: string[] = [];
			const pool = build(
				{ slots: 2, heartbeatMs: 5_000, heartbeatTimeoutMs: 60_000, timeoutMs: 60_000, log: (line) => said.push(line) },
				{ ECHO_LOG: file, ECHO_DELAY_MS: "30000" },
			);
			const running = pool.run(task("a"), graph("g1")).then(
				() => "answered",
				(e: Error) => `stopped: ${e.message}`,
			);
			await new Promise((r) => setTimeout(r, 400));
			const how = await pool.drain(500);
			const outcome = await running;
			ok(how === "timed-out", `drain reported the other case by name (${how})`);
			ok(outcome.startsWith("stopped:"), `the task was not silently reported as an answer (${outcome})`);
			ok(
				said.some((l) => l.includes("drain timed out")),
				`it said so — saw: ${said.filter((l) => l.includes("drain")).join(" | ")}`,
			);
		},
	],
];

const main = async () => {
	console.log(`pool lifecycle (logs in ${dir})`);
	for (const [name, fn] of cases) {
		console.log(`\n${name}`);
		try {
			await fn();
		} catch (e: any) {
			fail++;
			console.log("  FAIL " + name + "\n       " + (e?.stack ?? e));
		}
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exitCode = fail ? 1 : 0;
	// Nothing here should be holding the loop open. If something is, that is
	// itself a finding — a pool that will not let go of a timer is how an
	// unloaded row keeps a process alive.
	setTimeout(() => process.exit(fail ? 1 : 0), 2000).unref?.();
};

void main();

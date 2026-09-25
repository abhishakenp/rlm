/**
 * The pool worker's agent is the agent, not a spawner.
 *
 * `PoolWorkerOptions.agent` was declared `Runner` — `(task, graph) =>
 * Promise<string>` — while `runOne` called `agent.createRuntime({
 * sessionManager })`. No `Runner` has that method, and `index.ts` was passing
 * the `rlmAgent` factory from `agent.ts`, so every pooled task would have died
 * on `agent.createRuntime is not a function` with the compiler content.
 *
 * This runs a real worker in a real child with a real IPC channel and a stub
 * agent, and asserts the `done` reply carries the stub's sentinel — which it
 * can only do if the parent's `task` message reached `agent.createRuntime`.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const HERE = join(import.meta.dirname, "pool-worker-agent.fixture.ts");
const SENTINEL = "STUB-CREATE-RUNTIME-REACHED";

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

const runWorker = () =>
	new Promise<{ ready: any; done: any; tail: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [HERE], {
			cwd: join(import.meta.dirname, "..", ".."),
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: { ...process.env, RLM_DELEGATE_CHILD: "1" },
		});
		let ready: any = null;
		let tail = "";
		const done = (chunk: unknown) => {
			tail += String(chunk);
		};
		child.stdout?.on("data", done);
		child.stderr?.on("data", done);
		const bail = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`worker never answered\n${tail}`));
		}, 120_000);
		bail.unref?.();
		child.on("error", (e) => {
			clearTimeout(bail);
			reject(e);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(bail);
			if (!ready) reject(new Error(`worker exited ${signal ?? code} before ready\n${tail}`));
		});
		child.on("message", (raw: any) => {
			if (raw?.type === "ready") {
				ready = raw;
				child.send({ type: "task", id: "t1", prompt: "say hello", sessionId: "rlm-pool-worker-agent-test" });
				return;
			}
			if (raw?.type === "done") {
				clearTimeout(bail);
				const reply = raw;
				child.send({ type: "retire" });
				setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
				resolve({ ready, done: reply, tail });
			}
		});
	});

const main = async () => {
	console.log("pool worker → agent.createRuntime");
	const { ready, done, tail } = await runWorker();
	ok(ready?.type === "ready" && ready.slots === 2, `worker announced ready with the slots it was given (got ${ready?.slots})`);
	ok(done?.id === "t1", `the answer is addressed to the task that asked (got ${done?.id})`);
	const error = String(done?.error ?? "");
	ok(
		!error.includes("is not a function"),
		`the call path is coherent — no "is not a function" (error was: ${error.split("\n")[0]})`,
	);
	ok(error.includes(SENTINEL), `runOne reached agent.createRuntime (error was: ${error.split("\n")[0]})`);
	ok(error.includes("sessionManager=yes"), "createRuntime was handed a SessionManager of the task's own");
	if (fail) console.log(`\nworker output tail:\n${tail.split("\n").slice(-15).join("\n")}`);
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exitCode = fail ? 1 : 0;
};

void main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});

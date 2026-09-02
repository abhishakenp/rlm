/**
 * The thing that actually does the work.
 *
 * The graph does not care what does it — a runner is a function from a task to
 * a string, and the tests use closures. But a drive left with no runner has to
 * default to something real, and "no runner given and rlm-sdk is not mounted"
 * is not a default, it is a way of not having one. So this is the honest
 * default: rlm, in print mode, in its own process.
 *
 * Its own process rather than in-process on purpose. A task hands the machine
 * to an agent that spawns things and writes files; when that goes wrong it
 * should take a child down and not the drive that is keeping the list. The
 * drive surviving its workers is the entire difference between a backlog and a
 * string.
 *
 * Two details that are not incidental:
 *
 *   - **`RLM_DELEGATE_CHILD` is set in the child.** Every `--print` invocation
 *     is recorded at the door by `intake()`. Without this the drive's own
 *     attempts would be recorded as fresh top-level requests, so working the
 *     backlog would lengthen it, once per attempt, forever. The attempt is
 *     already journalled against the task it belongs to; recording it twice is
 *     not more memory, it is a loop.
 *   - **The signal really kills it.** A stop that leaves the agent running is
 *     not a stop, and `SIGKILL` follows `SIGTERM` because the whole reason for
 *     stopping may be that the child is wedged.
 */
import { spawn } from "node:child_process";
import { describeProof, type Graph, type Task } from "./graph.ts";
import type { Runner } from "./scheduler.ts";

export interface AgentOptions {
	/** Where rlm's entry point is. */
	entry: string;
	/** Node to run it with. Defaults to the one running this. */
	node?: string;
	cwd?: string;
	/**
	 * Give up on one attempt after this long, and kill the group.
	 *
	 * Forty-five minutes by default. The fifteen that was here before killed
	 * every multi-task delegation partway through; the report came back as a
	 * failure and read as incapacity, which is a lie a bound told about an
	 * agent.
	 */
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: Record<string, string>;
	/**
	 * Wrap the command before it runs — the seam a fence plugs into.
	 *
	 * `@iris/bounds` hands out exactly this: `guard.argv(command, args)`
	 * returns the confined form of the same call. rlm cannot import that
	 * package, so it takes the shape instead of the dependency.
	 */
	confine?: (command: string, args: string[]) => string[];
	onOutput?: (task: Task, chunk: string) => void;
}

/**
 * One session per task, stable across every attempt on it.
 *
 * A retry used to be a fresh `--print`, which meant starting from nothing:
 * whatever the first attempt read, worked out, or half-built was gone, and
 * attempt two paid for all of it again before it could even reach the point
 * where attempt one failed. His words: "not just re-enter, but resume from
 * their last state."
 *
 * Derived rather than stored so it survives anything — a crash, a restart, a
 * journal replayed on another machine. The same task always names the same
 * session, and a different task never collides with it.
 */
export const sessionFor = (graph: Graph, task: Task): string =>
	`rlm-delegate-${graph.id}-${task.id}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);

/**
 * The task, plus how anyone will tell it is finished.
 *
 * `describeProof` already renders a criterion in a sentence a person can read,
 * and it is what the graph shows him — so the doer gets exactly the same words
 * the reviewer will use, rather than a paraphrase that could drift from it.
 */
const withCriterion = (task: Task): string => {
	const prompt = task.prompt ?? task.title;
	if (!task.proof || task.proof.kind === "unstated" || task.proof.kind === "rollup") return prompt;
	return (
		`${prompt}\n\n---\n\nHow this will be judged, by something that did not watch you work:\n\n` +
		`  ${describeProof(task.proof)}\n\n` +
		`Make that true. If it names a file, write that file; if it names a string, the string has to be in ` +
		`there. Saying you are done does not count for anything — the check is run against the machine ` +
		`afterwards, and only the check decides.\n\n` +
		`If the check cannot be made true because it is checking the wrong thing, say so plainly in your ` +
		`answer and say what it should have checked. That is a useful result and it is not a failure.`
	);
};

export const rlmAgent = (options: AgentOptions): Runner => {
	return async (task: Task, graph: Graph): Promise<string> => {
		const command = options.node ?? process.execPath;
		// `--` before the prompt, always. Without it the prompt is just another
		// token on a command line, and the moment a flag was added between
		// `--print` and it, the reader took the flag instead and every child in
		// the fleet was asked to do the word "--session-id" for eight hours. The
		// end-of-options marker is the one spelling that cannot be re-read as an
		// option, whatever the prompt happens to start with.
		// The agent is told how it will be judged.
		//
		// It was not, and that is why work that was actually done kept failing.
		// `check-omniroute-selection-logic` is the clean example: the prompt said
		// "inspect the connection selection logic", the criterion said the file
		// /tmp/omniroute-selection-analysis.md must contain the literal string
		// "selection logic analysis complete", and the agent was handed only the
		// prompt. It did the analysis. It wrote the file. It failed, twice, for
		// not producing a sentinel nobody had mentioned to it.
		//
		// A criterion the doer cannot see is not a specification, it is a riddle.
		// Describing it costs a sentence and removes an entire class of failure —
		// and it cannot be gamed, because the criterion is still checked
		// independently afterwards by something that did not do the work.
		const args = [options.entry, "--print", "--session-id", sessionFor(graph, task), "--", withCriterion(task)];
		const [bin, ...rest] = options.confine ? options.confine(command, args) : [command, ...args];

		return await new Promise<string>((resolve, reject) => {
			// Its own process group. rlm's entry point re-executes itself under
			// tsx, so the process this spawns is the parent of the one doing the
			// work — killing the child alone leaves the grandchild running, still
			// holding the machine, after a stop that reported success. Observed,
			// not theorised: `ps` showed two live tsx processes under a drive that
			// had already come back.
			const child = spawn(bin, rest, {
				cwd: options.cwd,
				env: { ...process.env, ...options.env, RLM_DELEGATE_CHILD: "1" },
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});

			let out = "";
			let err = "";
			let done = false;
			const finish = (fn: () => void) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				fn();
			};

			/** The whole group, so nothing it started outlives it. */
			const signalGroup = (sig: NodeJS.Signals) => {
				try {
					if (child.pid) process.kill(-child.pid, sig);
				} catch {
					try {
						child.kill(sig);
					} catch {
						/* already gone */
					}
				}
			};
			const kill = () => {
				signalGroup("SIGTERM");
				setTimeout(() => signalGroup("SIGKILL"), 2_000).unref?.();
			};

			const timer = setTimeout(() => {
				kill();
				finish(() => reject(new Error(`the attempt ran past ${options.timeoutMs ?? 2_700_000}ms and was killed`)));
			}, options.timeoutMs ?? 2_700_000);
			timer.unref?.();

			const onAbort = () => {
				kill();
				finish(() => reject(new Error("stopped mid-attempt")));
			};
			if (options.signal?.aborted) return finish(() => reject(new Error("stopped before this attempt started")));
			options.signal?.addEventListener("abort", onAbort, { once: true });

			child.stdout?.on("data", (b) => {
				const chunk = String(b);
				out += chunk;
				options.onOutput?.(task, chunk);
			});
			child.stderr?.on("data", (b) => {
				err += String(b);
			});

			child.on("error", (error) => finish(() => reject(error)));
			child.on("close", (code) => {
				finish(() => {
					if (code === 0) return resolve(out.trim() || "(the agent said nothing)");
					// The tail of stderr, because the first line of a Node crash is
					// the shape and the rest is a stack that differs every run.
					const tail = `${out}\n${err}`.trim().split("\n").slice(-25).join("\n");
					reject(new Error(`the agent exited ${code}\n${tail}`));
				});
			});
		});
	};
};

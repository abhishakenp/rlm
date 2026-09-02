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
import type { Graph, Task } from "./graph.ts";
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

export const rlmAgent = (options: AgentOptions): Runner => {
	return async (task: Task, _graph: Graph): Promise<string> => {
		const command = options.node ?? process.execPath;
		const args = [options.entry, "--print", task.prompt];
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

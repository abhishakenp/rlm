/**
 * A pool worker whose agent is a stub, run as a real child with a real IPC
 * channel — which is the only way to exercise `runPoolWorker` honestly.
 *
 * The stub records that `createRuntime` was reached and with what, then throws a
 * sentinel. A `done` reply carrying that sentinel proves the call path from the
 * parent's `{type:"task"}` message all the way to `agent.createRuntime` is
 * coherent. Before the type fix this path ended in
 * `agent.createRuntime is not a function`, because `index.ts` handed the mode
 * the `rlmAgent` factory and `PoolWorkerOptions.agent` was declared `Runner`.
 */
import { runPoolWorker, type PoolWorkerAgent } from "./src/pool-worker.ts";

const SENTINEL = "STUB-CREATE-RUNTIME-REACHED";

const agent: PoolWorkerAgent = {
	createRuntime: async (options) => {
		const named = (options?.sessionManager as any)?.getSessionFile?.() ?? "(no session file)";
		throw new Error(`${SENTINEL} sessionManager=${options?.sessionManager ? "yes" : "no"} file=${named}`);
	},
};

const ctx = { get: () => undefined } as any;

runPoolWorker(ctx, { agent, slots: 2, cwd: process.cwd() }).then(
	(code) => process.exit(code),
	(error) => {
		console.error(`fixture failed: ${error?.stack ?? error}`);
		process.exit(3);
	},
);

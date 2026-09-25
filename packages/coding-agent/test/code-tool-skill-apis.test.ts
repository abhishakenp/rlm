import { describe, expect, it } from "vitest";
import { CodeKernelProvisioner, KERNEL_HOST_APIS, kernelGlobalNames } from "../src/core/tools/code.js";

/**
 * The bundled skills (agent-message, agent-observe, goal, compact,
 * rlm-heartbeat) document `await agent_message.send(...)` and friends. The
 * session built their host handlers, but the JS kernel never bound the
 * globals, so every call was a ReferenceError — which auto-refine then learned
 * globally as "harness APIs are not available in the code tool".
 */

type Call = [string, Record<string, unknown>];

const kernelWith = (calls: Call[], types: string[]) => {
	const hostHandlers: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {};
	for (const type of types) {
		hostHandlers[type] = async (payload) => {
			calls.push([type, payload]);
			return { ok: type };
		};
	}
	return new CodeKernelProvisioner(process.cwd(), { timeout: 30000, hostHandlers } as never);
};

describe("code tool — the skills' kernel APIs are bound", () => {
	it("binds every skill global, and the capability list names them", () => {
		const names = kernelGlobalNames();
		for (const name of ["rlm", "refine", "context", "agent_message", "agent_observe", "goal", "compact", "rlm_heartbeat"]) {
			expect(names).toContain(name);
		}
		for (const name of KERNEL_HOST_APIS) expect(names).toContain(name);
	});

	it.each([
		[`await agent_message.send("hi", { receiver_role: "parent" })`, "agent_message.send", { message: "hi", receiver_role: "parent" }],
		[
			`await agent_message.send({ message: "x", receiver_role: "child", receiver_name: "a" })`,
			"agent_message.send",
			{ message: "x", receiver_role: "child", receiver_name: "a" },
		],
		[`await agent_message.list_agents()`, "agent_message.list_agents", {}],
		[`await agent_observe.recent_messages("kid", 6)`, "agent_observe.recent", { target: "kid", limit: 6 }],
		[`await goal.create("ship", { token_budget: 5 })`, "goal.create", { objective: "ship", token_budget: 5 }],
		[`await compact.run("keep tests")`, "compact.run", { instructions: "keep tests" }],
		[
			`await rlm_heartbeat.create("check", { interval: "5m", label: "t" })`,
			"rlm_heartbeat.create",
			{ instruction: "check", interval: "5m", label: "t" },
		],
		[`await rlm_heartbeat.list({ include_inactive: true })`, "rlm_heartbeat.list", { include_inactive: true }],
		[`await rlm_heartbeat.delete("job-1")`, "rlm_heartbeat.delete", { id: "job-1" }],
	])("%s reaches %s with the skill's payload", async (code, type, payload) => {
		const calls: Call[] = [];
		const result = await kernelWith(calls, [type]).execute(`${code}; 'done'`);
		expect(result.status).toBe("ok");
		expect(calls).toEqual([[type, payload]]);
	});

	it("an API this session lacks says so, instead of a ReferenceError", async () => {
		const result = await kernelWith([], []).execute(`await agent_message.send("hi", { receiver_role: "parent" })`);
		expect(result.status).toBe("error");
		const text = JSON.stringify(result);
		expect(text).toContain("exists in the code tool, but this session does not provide it");
		expect(text).not.toContain("is not defined");
	});
});

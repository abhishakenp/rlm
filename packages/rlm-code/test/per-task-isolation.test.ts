/**
 * Fix A: Per-task VM context isolation.
 *
 * Before Fix A: RlmCodeService had a single shared vm.Context. Concurrent
 * tasks calling execute() could observe each other's variables.
 *
 * After Fix A: execute(code, taskId) uses a Map<taskId, vm.Context>. Each
 * task gets its own VM context. Variables persist within a task but are
 * invisible to other tasks.
 */
import { describe, it, expect } from "vitest";

// Minimal Cordis context mock.
const createMockCtx = () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
	emit: () => {},
	on: () => () => {},
	get: () => null,
	reflect: { provide: () => {} },
});

describe("Fix A: per-task VM context isolation", () => {
	it("execute without taskId uses shared context (backward compat)", async () => {
		const { RlmCodeService } = await import("../src/index.ts");
		const svc = new RlmCodeService(createMockCtx() as any, {});
		await svc[Symbol.asyncDispose as any] ?? null;

		// Set a variable
		const r1 = await svc.execute("var x = 42; x");
		expect(r1.status).toBe("ok");
		expect(r1.result).toBe("42");

		// Variable persists across calls
		const r2 = await svc.execute("x");
		expect(r2.status).toBe("ok");
		expect(r2.result).toBe("42");
	});

	it("execute with taskId uses task-scoped context", async () => {
		const { RlmCodeService } = await import("../src/index.ts");
		const svc = new RlmCodeService(createMockCtx() as any, {});

		// Task A sets a variable
		const rA1 = await svc.execute("var x = 100; x", "task-a");
		expect(rA1.status).toBe("ok");
		expect(rA1.result).toBe("100");

		// Task A's variable persists within task A
		const rA2 = await svc.execute("x", "task-a");
		expect(rA2.status).toBe("ok");
		expect(rA2.result).toBe("100");
	});

	it("concurrent tasks cannot observe each other's variables", async () => {
		const { RlmCodeService } = await import("../src/index.ts");
		const svc = new RlmCodeService(createMockCtx() as any, {});

		// Task A sets x = 1
		await svc.execute("var x = 1; x", "task-a");

		// Task B sets x = 2
		await svc.execute("var x = 2; x", "task-b");

		// Task A sees its own x = 1, not task B's x = 2
		const rA = await svc.execute("x", "task-a");
		expect(rA.status).toBe("ok");
		expect(rA.result).toBe("1");

		// Task B sees its own x = 2, not task A's x = 1
		const rB = await svc.execute("x", "task-b");
		expect(rB.status).toBe("ok");
		expect(rB.result).toBe("2");
	});

	it("task context is isolated from default context", async () => {
		const { RlmCodeService } = await import("../src/index.ts");
		const svc = new RlmCodeService(createMockCtx() as any, {});

		// Set x in default context
		await svc.execute("var x = 'default'; x");

		// Set x in task context
		await svc.execute("var x = 'task'; x", "task-1");

		// Default context sees its own x
		const rDefault = await svc.execute("x");
		expect(rDefault.result).toBe("default");

		// Task context sees its own x
		const rTask = await svc.execute("x", "task-1");
		expect(rTask.result).toBe("task");
	});

	it("disposeTaskContext removes the task's context", async () => {
		const { RlmCodeService } = await import("../src/index.ts");
		const svc = new RlmCodeService(createMockCtx() as any, {});

		// Set a variable in task context
		await svc.execute("var x = 42; x", "task-dispose");

		// Dispose the task context
		svc.disposeTaskContext("task-dispose");

		// After disposal, task gets a fresh context — x is undefined
		const r = await svc.execute("typeof x === 'undefined' ? 'gone' : x", "task-dispose");
		expect(r.result).toBe("gone");
	});

	it("get/set/vars support task-scoped contexts", async () => {
		const { RlmCodeService } = await import("../src/index.ts");
		const svc = new RlmCodeService(createMockCtx() as any, {});

		// Set via execute (var declarations must be on separate lines for transformVarToGlobal)
		await svc.execute("var alpha = 1\nvar beta = 2", "task-vars");

		// get() with taskId
		expect(svc.get("alpha", "task-vars")).toBe(1);
		expect(svc.get("beta", "task-vars")).toBe(2);

		// set() with taskId
		svc.set("gamma", 3, "task-vars");
		const r = await svc.execute("gamma", "task-vars");
		expect(r.result).toBe("3");

		// vars() with taskId lists user-defined vars
		const vars = svc.vars("task-vars");
		expect(vars).toContain("alpha");
		expect(vars).toContain("beta");
		expect(vars).toContain("gamma");

		// Default context doesn't see task vars
		expect(svc.get("alpha")).toBeUndefined();
		expect(svc.vars()).not.toContain("alpha");
	});

	it("two concurrent tasks run truly concurrently without cross-contamination", async () => {
		const { RlmCodeService } = await import("../src/index.ts");
		const svc = new RlmCodeService(createMockCtx() as any, {});

		// Launch two tasks concurrently that set variables and read them
		const [rA, rB] = await Promise.all([
			svc.execute("var shared = 'A'; shared", "concurrent-a"),
			svc.execute("var shared = 'B'; shared", "concurrent-b"),
		]);

		expect(rA.result).toBe("A");
		expect(rB.result).toBe("B");

		// Verify isolation persists after concurrent execution
		const [rA2, rB2] = await Promise.all([
			svc.execute("shared", "concurrent-a"),
			svc.execute("shared", "concurrent-b"),
		]);

		expect(rA2.result).toBe("A");
		expect(rB2.result).toBe("B");
	});
});

import { describe, expect, it } from "vitest";
import { asyncifyExecSync } from "../src/core/tools/code-async-shell.js";
import { CodeKernelProvisioner } from "../src/core/tools/code.js";

/**
 * In-process subagents run their code cells on the thread the TUI renders
 * and reads keys on. A subagent's `execSync("sleep 90")` froze the whole
 * terminal — no input, no spinner — until the command exited.
 */

const kernel = () => new CodeKernelProvisioner(process.cwd(), { timeout: 30000 } as never);

describe("asyncifyExecSync", () => {
	it("rewrites bare calls, including nested and chained ones", () => {
		expect(asyncifyExecSync(`execSync("ls").toString()`)).toBe(`(await __execSyncAsync("ls")).toString()`);
		expect(asyncifyExecSync(`const a = execSync(\`echo \${execSync("pwd")}\`, { cwd: "/" })`)).toBe(
			`const a = (await __execSyncAsync(\`echo \${(await __execSyncAsync("pwd"))}\`, { cwd: "/" }))`,
		);
	});

	it("leaves strings, comments, members and definitions alone", () => {
		for (const code of [
			`"execSync('x')"`,
			`// execSync("x")`,
			`/* execSync("x") */`,
			`cp.execSync("x")`,
			`function execSync(c) { return c }`,
			`const o = { execSync(c) { return c } }`,
			`myexecSync("x")`,
		]) {
			expect(asyncifyExecSync(code)).toBe(code);
		}
	});
});

describe("code tool — execSync does not block the event loop", () => {
	it("keeps timers firing while a cell's execSync runs", async () => {
		let ticks = 0;
		const interval = setInterval(() => ticks++, 50);
		try {
			const result = await kernel().execute(`execSync("sleep 1 && echo hi").toString().trim()`);
			expect(result.status).toBe("ok");
			expect(result.result).toContain("hi");
			// Blocking execSync allowed zero ticks during the second.
			expect(ticks).toBeGreaterThanOrEqual(10);
		} finally {
			clearInterval(interval);
		}
	});

	it("keeps execSync's contract: Buffer by default, string with encoding, throws with status", async () => {
		const k = kernel();
		const buf = await k.execute(`Buffer.isBuffer(execSync("printf a"))`);
		expect(buf.result).toContain("true");
		const str = await k.execute(`typeof execSync("printf a", { encoding: "utf8" })`);
		expect(str.result).toContain("string");
		const failed = await k.execute(`let s = 0\ntry { execSync("exit 3") } catch (e) { s = e.status }\ns`);
		expect(failed.result).toContain("3");
		const input = await k.execute(`execSync("cat", { input: "piped", encoding: "utf8" })`);
		expect(input.result).toContain("piped");
	});

	it("still runs execSync inside a non-async callback (blocking fallback)", async () => {
		const result = await kernel().execute(`["a","b"].map((x) => execSync("printf " + x, { encoding: "utf8" })).join("")`);
		expect(result.status).toBe("ok");
		expect(result.result).toContain("ab");
	});

	it("runs !shell lines without blocking", async () => {
		let ticks = 0;
		const interval = setInterval(() => ticks++, 50);
		try {
			const result = await kernel().execute(`!sleep 1 && echo done`);
			expect(result.status).toBe("ok");
			expect(result.result).toContain("done");
			expect(ticks).toBeGreaterThanOrEqual(10);
		} finally {
			clearInterval(interval);
		}
	});
});

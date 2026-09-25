import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transformCellSource } from "../src/core/tools/cell-transform.js";
import { CodeKernelProvisioner } from "../src/core/tools/code.js";

// Top-level declarations in a code cell survive into later cells (REPL rules).
describe("code cells keep what they declare", () => {
	let kernel: CodeKernelProvisioner;
	const run = async (code: string) => kernel.execute(code);
	const value = async (code: string) => {
		const result = await run(code);
		expect(result.status, `${code}\n${result.error?.evalue ?? ""}`).toBe("ok");
		return result.result;
	};

	beforeEach(async () => {
		kernel = new CodeKernelProvisioner(process.cwd(), {});
		await kernel.ensure();
	});
	afterEach(async () => {
		await kernel.dispose();
	});

	it("let and const persist and can be modified in the next cell", async () => {
		expect(await value("let count = 41\ncount + 1")).toBe("42");
		expect(await value("count = count + 1; count")).toBe("42");
		await value("const name = 'rlm'");
		expect(await value("name.toUpperCase()")).toBe("RLM");
	});

	it("destructuring declarations persist", async () => {
		await value("const { a, b: [c, ...rest] } = { a: 1, b: [2, 3, 4] }");
		expect(JSON.parse((await value("[a, c, rest]"))!)).toEqual([1, 2, [3, 4]]);
	});

	it("function and class declarations persist", async () => {
		await value("function double(n) { return n * 2 }\nclass Box { constructor(v) { this.v = v } }");
		expect(await value("double(21)")).toBe("42");
		expect(await value("new Box(7).v")).toBe("7");
	});

	it("a later cell may declare the same name again", async () => {
		await value("const item = 1");
		expect(await value("const item = 'two'\nitem")).toBe("two");
	});

	it("declarations inside blocks and loops stay local", async () => {
		await value("{ let inner = 1 }\nfor (let i = 0; i < 2; i++) {}");
		expect(await value("[typeof inner, typeof i].join()")).toBe("undefined,undefined");
	});

	it("awaits at the top level still work", async () => {
		await value("const later = await Promise.resolve(9)");
		expect(await value("later")).toBe("9");
	});

	it("a failing cell leaves nothing half-defined and restores what it replaced", async () => {
		await value("let kept = 'before'");
		const failed = await run("let kept = 'during'\nconst partial = 1\nthrow new Error('boom')");
		expect(failed.status).toBe("error");
		expect(await value("[kept, typeof partial].join()")).toBe("before,undefined");
	});

	it("host bindings stay cell-local, so a cell cannot replace them for later cells", async () => {
		expect(await value("const fs = 'mine'\nfs")).toBe("mine");
		expect(await value("typeof fs.readFileSync")).toBe("function");
	});

	it("a ; inside a string does not split the last expression", async () => {
		expect(await value('const echo = (s) => "said:" + s;\necho("sleep 1; echo hi")')).toBe("said:sleep 1; echo hi");
	});
});

describe("transformCellSource", () => {
	const none = new Set<string>();

	it("leaves strings, comments, regexes and templates alone", () => {
		const source = 'const s = "let x = 1"; // const y = 2\nconst r = /let z/;\nconst t = `const w = ${1}`;\ns';
		const plan = transformCellSource(source, none)!;
		expect(plan.names.sort()).toEqual(["r", "s", "t"]);
		expect(plan.body).toContain('"let x = 1"');
		expect(plan.body).toContain("// const y = 2");
		expect(plan.body).toContain("/let z/");
		expect(plan.body).toContain("`const w = ${1}`");
		expect(plan.body.trimEnd().endsWith("return (s);")).toBe(true);
	});

	it("returns undefined for a cell that does not parse", () => {
		expect(transformCellSource("let = = 1", none)).toBeUndefined();
	});
});

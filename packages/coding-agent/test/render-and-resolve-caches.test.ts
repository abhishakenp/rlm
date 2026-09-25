import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveConfigValueThisTask } from "../src/core/resolve-config-value.js";
import { findSessionFileByExactId } from "../src/core/session-manager.js";
import { resolveSessionPath } from "../src/core/session-resolver.js";
import { BrandSplashHeader } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "rlm-cache-test-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const executions = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).length;

describe("resolveConfigValueThisTask", () => {
	it("runs a !command once per synchronous pass and again after the task ends", async () => {
		const count = join(scratch(), "count");
		writeFileSync(count, "");
		const command = `!echo x >> ${count}; echo secret`;
		for (let i = 0; i < 14; i++) expect(resolveConfigValueThisTask(command)).toBe("secret");
		expect(executions(count)).toBe(1);
		await Promise.resolve();
		expect(resolveConfigValueThisTask(command)).toBe("secret");
		expect(executions(count)).toBe(2);
	});

	it("resolves env vars and literals without caching", () => {
		process.env.RLM_RECENT_TEST_VAR = "one";
		expect(resolveConfigValueThisTask("RLM_RECENT_TEST_VAR")).toBe("one");
		process.env.RLM_RECENT_TEST_VAR = "two";
		expect(resolveConfigValueThisTask("RLM_RECENT_TEST_VAR")).toBe("two");
		delete process.env.RLM_RECENT_TEST_VAR;
	});
});

describe("resume by full id reads one header", () => {
	const id = "01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
	const writeSession = (dir: string, cwd: string, headerId = id) =>
		writeFileSync(
			join(dir, `${id}.jsonl`),
			`${JSON.stringify({ type: "session", id: headerId, cwd, timestamp: new Date().toISOString() })}\n`,
		);

	it("finds the file and says whether it belongs to cwd", () => {
		const dir = scratch();
		writeSession(dir, "/work/a");
		expect(findSessionFileByExactId(dir, id, "/work/a")).toMatchObject({ matchesCwd: true, cwd: "/work/a" });
		expect(findSessionFileByExactId(dir, id, "/work/b")).toMatchObject({ matchesCwd: false, cwd: "/work/a" });
	});

	it("declines when the header does not carry that id, so the full scan decides", () => {
		const dir = scratch();
		writeSession(dir, "/work/a", "01a0ffff-0000-7000-8000-000000000000");
		expect(findSessionFileByExactId(dir, id, "/work/a")).toBeUndefined();
		expect(findSessionFileByExactId(dir, "01a0-missing", "/work/a")).toBeUndefined();
	});

	it("resolveSessionPath answers local vs global the same way the scan does", async () => {
		const dir = scratch();
		writeSession(dir, "/work/a");
		await expect(resolveSessionPath(id, "/work/a", dir)).resolves.toEqual({
			type: "local",
			path: join(dir, `${id}.jsonl`),
		});
		await expect(resolveSessionPath(id, "/work/b", dir)).resolves.toEqual({
			type: "global",
			path: join(dir, `${id}.jsonl`),
			cwd: "/work/a",
		});
	});
});

describe("BrandSplashHeader render cache", () => {
	beforeAll(() => initTheme("dark"));

	it("reuses its lines until an input or the width changes, and invalidate() drops them", () => {
		let model = "model-a";
		const header = new BrandSplashHeader("1.0.0", () => model, () => "/work/a");
		const first = header.render(120);
		expect(header.render(120)).toEqual(first);
		expect(header.render(100)).not.toEqual(first);
		const atHundred = header.render(100);
		model = "model-b";
		const changed = header.render(100);
		expect(changed).not.toEqual(atHundred);
		expect(changed.join("\n")).toContain("model-b");
		header.invalidate();
		expect(header.render(100)).toEqual(changed);
	});

	it("hands out a copy, so a caller appending to it cannot grow the cache", () => {
		// The agents view pushes its notices onto the returned header lines every
		// frame; with the cache handed out directly they piled up without end.
		const header = new BrandSplashHeader("1.0.0", () => "m", () => "/work/a");
		const clean = header.render(120).length;
		for (let frame = 0; frame < 5; frame++) header.render(120).push("", " ⚠ notice");
		expect(header.render(120)).toHaveLength(clean);
	});
});

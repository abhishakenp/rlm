import { describe, expect, it } from "vitest";
import { listedContextSummary } from "../src/core/agent-session.js";

const summary = [
	"  runtime.depth (const number, session) — Recursion depth (0 = root): 0",
	'  runtime.systemPrompt (let prompt, session) — Active system prompt (hot-reloadable): "You are a general…"',
	'  skill.edit (let prompt, session) — Skill: edit (hot-reloadable): "{\\"name\\":\\"edit\\"}"',
	'  skill.goal (let prompt, session) — Skill: goal (hot-reloadable): "{\\"name\\":\\"goal\\"}"',
	'  user.prompt (const prompt, session) — The original user prompt for this session: "Reply with exactly: pong"',
	"  files.packages (let array, session) — Package directories: [\"a\"]",
].join("\n");

describe("listedContextSummary", () => {
	it("leaves out skill.* and runtime.systemPrompt, and says how many and where they are", () => {
		const listed = listedContextSummary(summary);
		expect(listed).not.toContain("skill.edit");
		expect(listed).not.toContain("runtime.systemPrompt (");
		expect(listed).toContain("runtime.depth");
		expect(listed).toContain("user.prompt");
		expect(listed).toContain("files.packages");
		expect(listed).toContain("3 more not listed");
		expect(listed).toContain("context.get reads them");
	});

	it("returns the summary unchanged when there is nothing to leave out", () => {
		const plain = "  files.packages (let array, session) — Package directories: [\"a\"]";
		expect(listedContextSummary(plain)).toBe(plain);
	});

	it("does not drop a user variable that merely mentions skill. in its value", () => {
		const own = '  notes.todo (let string, session) — note: "update skill.edit docs"';
		expect(listedContextSummary(own)).toBe(own);
	});
});

import { describe, expect, it } from "vitest";
import { previewBashCommand, previewCodeCode, previewJsCode } from "../src/core/tools/code-preview.js";

describe("code preview", () => {
	it("skips bash setup and previews the real command", () => {
		expect(previewBashCommand("set -e\nnpm run check")).toEqual({ language: "bash", text: "npm check" });
	});

	it("simplifies common runner wrappers", () => {
		expect(
			previewBashCommand("npx tsx ../../node_modules/vitest/dist/cli.js --run test/code-preview.test.ts"),
		).toEqual({
			language: "bash",
			text: "vitest --run test/code-preview.test.ts",
		});
	});

	it("unwraps node heredocs in bash", () => {
		const command = `set -e
node - <<'JS'
const fs = require("fs");
fs.writeFileSync("package.json", "{}");
JS`;
		const result = previewBashCommand(command);
		expect(result.language).toBe("js");
		expect(result.text).toContain("write");
	});

	it("unwraps bash cells in code", () => {
		const code = `%%bash
set -e
node - <<'JS'
const fs = require("fs");
const data = JSON.parse("{}");
console.log(Object.keys(data));
JS`;
		expect(previewCodeCode(code).language).toBe("js");
	});

	it("previews JS file reads with relative paths", () => {
		const code = `const fs = require("fs");
const text = fs.readFileSync("packages/coding-agent/src/index.ts", "utf8");
console.log(text.slice(0, 100));`;
		const result = previewJsCode(code);
		expect(result.language).toBe("js");
		expect(result.text).toContain("read");
	});

	it("previews JS execSync commands", () => {
		const code = `const { execSync } = require("child_process");
const output = execSync("uptime").toString();
console.log(output);`;
		const result = previewJsCode(code);
		expect(result.language).toBe("js");
		expect(result.text).toContain("uptime");
	});

	it("previews JS readdirSync", () => {
		const code = `const fs = require("fs");
const dirs = fs.readdirSync("packages");`;
		const result = previewJsCode(code);
		expect(result.language).toBe("js");
		expect(result.text).toContain("ls");
	});

	it("previews context.set calls", () => {
		const code = `context.set("auth.files", ["login.ts", "session.ts"], { scope: "project" });`;
		const result = previewJsCode(code);
		expect(result.language).toBe("js");
		expect(result.text).toContain("ctx.set auth.files");
	});

	it("previews rlm.spawn calls", () => {
		const code = `await rlm.spawn("fix auth bug", { context: ["auth.*"] });`;
		const result = previewJsCode(code);
		expect(result.language).toBe("js");
		expect(result.text).toContain("spawn fix auth bug");
	});

	it("handles stronger bash heuristics", () => {
		expect(previewBashCommand("cd packages/coding-agent && npm --prefix ../.. run check")).toEqual({
			language: "bash",
			text: "npm check (../..)",
		});
		expect(previewBashCommand("echo setup\ngit add packages/foo.ts")).toEqual({
			language: "bash",
			text: "git add packages/foo.ts",
		});
		expect(previewBashCommand("cat > packages/foo.ts <<'EOF'\nhello\nEOF")).toEqual({
			language: "bash",
			text: "write packages/foo.ts",
		});
	});

	it("falls back when heredoc has no useful preview", () => {
		const command = `npm run check
node - <<'JS'
JS`;
		expect(previewBashCommand(command)).toEqual({ language: "bash", text: "npm check" });
	});

	it("does not treat a .sh script path as an inline bash heredoc", () => {
		const command = `./script.sh <<'EOF'
hello world
EOF`;
		expect(previewBashCommand(command)).toEqual({ language: "bash", text: "hello world" });
	});

	it("never uses python as a language label", () => {
		const code = `const fs = require("fs");
const data = fs.readFileSync("test.txt", "utf8");`;
		const result = previewCodeCode(code);
		expect(result.language).not.toBe("python");
		expect(result.language).toBe("js");
	});

	it("does not show } as preview for code with closing braces", () => {
		const code = `const fs = require("fs");
const dirs = fs.readdirSync("./packages");
const result = dirs.slice(0, 3);
console.log(result);
context.set("packages.firstThree", result);`;
		const result = previewJsCode(code);
		expect(result.text).not.toBe("}");
		expect(result.text).not.toBe("");
		// Should show a meaningful line, not a closing brace.
		expect(result.text.length).toBeGreaterThan(2);
	});

	it("does not show # comment as preview (Python-style comment in JS)", () => {
		const code = `# print(f"Index of {target} is {result}")
const result = binarySearch(arr, target);
console.log(result);`;
		const result = previewJsCode(code);
		expect(result.text).not.toContain("#");
		expect(result.text).not.toBe("");
		expect(result.text.length).toBeGreaterThan(2);
	});
});

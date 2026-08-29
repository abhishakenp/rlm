import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseCodeBashCell } from "../../../src/core/tools/code-cell-code.js";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const codeTool: AgentTool = {
	name: "code",
	label: "code",
	description: "Execute a test Code cell",
	parameters: Type.Object({ code: Type.String() }),
	execute: async () => ({
		content: [{ type: "text", text: "" }],
		details: { status: "ok" },
	}),
};

describe("ENG-4529 leading newline before %%bash", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("parses blank lines, indentation, arguments, and CRLF before the bash body", () => {
		expect(parseCodeBashCell(" \r\n\t\r\n  %%bash --noprofile\r\necho ok")).toEqual({
			leadingWhitespace: " \r\n\t\r\n",
			indent: "  ",
			magicArguments: " --noprofile",
			lineBreak: "\r\n",
			body: "echo ok",
		});
		expect(parseCodeBashCell("\nprint('python')")).toBeUndefined();
	});

	it("renders a generated bash cell with a leading newline as bash", async () => {
		const code = "\n%%bash\ncd /tmp";
		harness = await createHarness({ tools: [codeTool] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("code", { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the command");

		const start = harness.eventsOfType("tool_execution_start")[0];
		expect(start).toMatchObject({ toolName: "code", args: { code } });
		if (!start) {
			throw new Error("Expected an Code tool call");
		}

		const component = new ToolExecutionComponent(
			start.toolName,
			start.toolCallId,
			start.args,
			{},
			undefined,
			{ requestRender: vi.fn() } as unknown as TUI,
			harness.tempDir,
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult({ content: [], details: { status: "ok" }, isError: false });

		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("✓ bash · cd /tmp · ↑ 1 lines");
		expect(rendered).not.toContain("✓ python");
	});
});

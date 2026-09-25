import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// rlm runs every chat the way prime-agent runs a daemon chat: with
// `returnToAgentsView`. The tray is openable, Down reaches it, and Enter hands
// the terminal to the agents view scoped to this session's children.

const DOWN = "\x1b[B";

const passthrough = (text: string) => text;
const editorTheme: EditorTheme = {
	borderColor: passthrough,
	selectList: {
		selectedPrefix: passthrough,
		selectedText: passthrough,
		description: passthrough,
		scrollInfo: passthrough,
		noMatch: passthrough,
	},
};
const fakeTui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as unknown as TUI;

const child = (
	id: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"],
	overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {},
): AgentConnectionRlmChildAgentSnapshot => ({ id, label: id, status, sessionDir: `/tmp/${id}`, ...overrides });

const method = <T extends (...args: never[]) => unknown>(name: string) =>
	Reflect.get(InteractiveMode.prototype, name) as T;

/** An InteractiveMode as `rlm` runs it: agents view behind it, one live tray. */
const rlmMode = (snapshots: AgentConnectionRlmChildAgentSnapshot[]) => {
	const line = new SubagentSummaryLine();
	line.setOpenable(true);
	line.setSubagentCounts({ total: snapshots.length, running: snapshots.length, idle: 0, inactive: 0 });
	const setFocus = vi.fn();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		options: { returnToAgentsView: true },
		rlmNodeId: undefined,
		subagentSnapshots: new Map(snapshots.map((s) => [s.id, s])),
		subagentSummaryLine: line,
		editor: { getText: () => "" },
		isCtrlCExitHintVisible: () => false,
		isAgentStreaming: () => false,
		ui: { setFocus, requestRender: vi.fn() },
	});
	return { mode, line, setFocus };
};

describe("subagent tray focus", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("Down at the end of the prompt hands focus to the tray", () => {
		const { mode, line, setFocus } = rlmMode([child("a", "running")]);
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		editor.onMoveBelowPrompt = () => method<() => boolean>("focusSubagentSummary").call(mode);

		editor.handleInput(DOWN);

		expect(setFocus).toHaveBeenCalledWith(line);
	});

	it("the tray advertises Down as its selection key once it has subagents", () => {
		const { line } = rlmMode([child("a", "running")]);
		expect(stripAnsi(line.render(120).join("\n"))).toContain("select");
	});

	it("Enter on the tray asks for the agents view scoped to this session", async () => {
		const { mode, line } = rlmMode([child("a", "running")]);
		const requested: string[] = [];
		Object.assign(mode, {
			returnToAgentsView: vi.fn(async (request: string) => {
				requested.push(request);
			}),
		});
		line.onOpen = () => void method<() => Promise<void>>("openScopedAgentsView").call(mode);

		line.handleInput("\r");

		await vi.waitFor(() => expect(requested).toEqual(["scoped_agents_view"]));
	});
});

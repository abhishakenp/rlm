import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	runAgentsViewMode: vi.fn(),
	disposeAll: vi.fn(async () => undefined),
}));

vi.mock("../src/modes/interactive/interactive-mode.js", () => ({
	InteractiveMode: class {
		run = mocks.run;
	},
}));
vi.mock("../src/modes/agents-view/agents-view-mode.js", () => ({ runAgentsViewMode: mocks.runAgentsViewMode }));
vi.mock("../src/modes/agents-view/in-process-daemon.js", () => ({
	InProcessAgentsHost: class {
		socketPath = "inprocess:test";
		activeSessionIdFor = () => "root";
		attach = () => ({ connection: {}, localSessionHost: { createUiServices: () => ({}) } });
		findHosted = () => ({});
		summaryFor = () => ({ id: "root", sessionId: "s" });
		disposeAll = mocks.disposeAll;
	},
}));

import { runInProcessAgentsSession } from "../src/modes/agents-view/in-process-agents-session.js";

const runtime = {
	session: {
		rlmDepth: 0,
		sessionId: "s",
		hasRunningRlmChildren: () => false,
		sessionManager: { getCwd: () => "/tmp", getSessionDir: () => "" },
	},
} as never;

describe("in-process agents session", () => {
	beforeEach(() => vi.clearAllMocks());

	it("opens the agents view rooted at the chat the user left", async () => {
		mocks.run.mockResolvedValue({ type: "scoped_agents_view", source: { sessionId: "s", activeSessionId: "root" } });
		mocks.runAgentsViewMode.mockResolvedValue(undefined);
		await runInProcessAgentsSession({ runtime });
		expect(mocks.runAgentsViewMode).toHaveBeenCalledWith(
			expect.objectContaining({
				socketPath: "inprocess:test",
				initialScopeKey: { sessionId: "s", activeSessionId: "root" },
			}),
		);
		expect(mocks.disposeAll).toHaveBeenCalled();
	});

	it("bare -r starts on the agents view, unscoped and with no chat opened first", async () => {
		mocks.runAgentsViewMode.mockResolvedValue(undefined);
		await expect(runInProcessAgentsSession({ runtime, openAgentsView: true })).resolves.toBeUndefined();
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.runAgentsViewMode).toHaveBeenCalledWith(
			expect.objectContaining({ socketPath: "inprocess:test", initialSession: undefined, initialScopeKey: undefined }),
		);
		expect(mocks.disposeAll).toHaveBeenCalled();
	});

	it("restores the terminal and disposes sessions when the agents view fails", async () => {
		mocks.run.mockResolvedValue({ type: "agents_view", source: { sessionId: "s" } });
		mocks.runAgentsViewMode.mockRejectedValue(new Error("view broke"));
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const tty = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			await expect(runInProcessAgentsSession({ runtime })).rejects.toThrow("view broke");
			expect(write).toHaveBeenCalledWith("\x1b[?1049l\x1b[?25h");
			expect(mocks.disposeAll).toHaveBeenCalled();
		} finally {
			Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
			write.mockRestore();
		}
	});
});

import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { InProcessAgentsHost } from "../src/modes/agents-view/in-process-daemon.js";

type FakeRuntime = AgentSessionRuntime & { children: FakeRuntime[]; walks: number };

const runtime = (sessionId: string, rlmChildId?: string): FakeRuntime => {
	const fake = {
		session: { sessionId },
		metadata: { rlmChildId },
		children: [] as FakeRuntime[],
		walks: 0,
		listSubagentRuntimes() {
			fake.walks++;
			return fake.children;
		},
	};
	return fake as unknown as FakeRuntime;
};

const tree = (width: number) => {
	const root = runtime("root");
	for (let i = 0; i < width; i++) {
		const child = runtime(`s-${i}`, `c-${i}`);
		child.children.push(runtime(`s-${i}-leaf`, `c-${i}-leaf`));
		root.children.push(child);
	}
	return root;
};

describe("InProcessAgentsHost.activeSessionIdForChild", () => {
	it("stamps children from an index instead of walking the tree per update", () => {
		const root = tree(100);
		const host = new InProcessAgentsHost(root);
		expect(host.activeSessionIdForChild("c-7")).toBe("s-7");
		const walksAfterFirst = root.walks;
		// 1,000 child updates for known children: no further tree walks.
		for (let i = 0; i < 1000; i++) expect(host.activeSessionIdForChild(`c-${i % 100}-leaf`)).toBe(`s-${i % 100}-leaf`);
		expect(root.walks).toBe(walksAfterFirst);
	});

	it("rebuilds for a child that appeared later, but at most once per 100 ms of misses", () => {
		vi.useFakeTimers();
		try {
			const root = tree(3);
			const host = new InProcessAgentsHost(root);
			expect(host.activeSessionIdForChild("c-0")).toBe("s-0");
			const late = runtime("s-late", "c-late");
			root.children.push(late);
			const walks = root.walks;
			// Inside the window a miss costs nothing and stays unstamped.
			expect(host.activeSessionIdForChild("c-late")).toBeUndefined();
			expect(root.walks).toBe(walks);
			vi.advanceTimersByTime(150);
			expect(host.activeSessionIdForChild("c-late")).toBe("s-late");
			expect(root.walks).toBe(walks + 1);
		} finally {
			vi.useRealTimers();
		}
	});
});

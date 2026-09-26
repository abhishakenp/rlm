import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

// prime-agent v0.9.6's deferred-event replay, exercised without a daemon: a
// replacement or resync that arrives while the initial transcript is still
// rendering waits for it and is dropped if a newer replacement superseded it;
// initial renders run one at a time and release deferred events once, after
// the last one. Upstream covers the same paths through DaemonAgentConnection in
// agent-connection-daemon.test.ts.

type Listener = (event: any) => void | Promise<void>;

const fakeConnection = () => {
	const listeners = new Set<Listener>();
	return {
		subscribe: (listener: Listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (event: any) => {
			for (const listener of listeners) void listener(event);
		},
		flushBufferedSessionEvents: vi.fn(async () => {}),
	};
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const subscribeToAgent = (ui: object) =>
	(InteractiveMode.prototype as unknown as { subscribeToAgent(this: object): void }).subscribeToAgent.call(ui);

describe("InteractiveMode deferred session events", () => {
	it.each(["session_replaced", "session_resynced"] as const)(
		"drops a %s superseded during the initial render",
		async (type) => {
			const connection = fakeConnection();
			let release!: () => void;
			const initialRenderPromise = new Promise<void>((resolve) => {
				release = resolve;
			});
			const ui = {
				agentConnection: connection,
				sessionEventQueue: Promise.resolve(),
				sessionEventGeneration: 0,
				initialRenderPromise,
				refreshCommandCatalogForCurrentSession: vi.fn(async () => {}),
				renderResyncedSession: vi.fn(async () => {}),
				resetSideQuestion: vi.fn(),
				resetExtensionUI: vi.fn(),
				applyConnectionStateSnapshot: vi.fn(),
				resetCurrentSessionRenderState: vi.fn(),
				rebindCurrentSession: vi.fn(async () => {}),
				renderInitialMessages: vi.fn(async () => {}),
				ui: { requestRender: vi.fn() },
				showError: vi.fn(),
			};
			subscribeToAgent(ui);
			connection.emit(
				type === "session_replaced" ? { type, state: { stale: true } } : { type, snapshot: { stale: true } },
			);
			await tick();
			const latest = { latest: true };
			connection.emit({ type: "session_replaced", state: latest });
			release();
			await tick();
			await ui.sessionEventQueue;
			expect(ui.renderResyncedSession).not.toHaveBeenCalled();
			expect(ui.applyConnectionStateSnapshot).toHaveBeenCalledExactlyOnceWith(latest);
			expect(ui.rebindCurrentSession).toHaveBeenCalledOnce();
			expect(ui.renderInitialMessages).toHaveBeenCalledOnce();
			expect(ui.ui.requestRender).toHaveBeenCalledOnce();
			expect(ui.showError).not.toHaveBeenCalled();
		},
	);

	it("runs initial renders one at a time and releases deferred events once, after the last", async () => {
		const connection = fakeConnection();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const snapshot = { state: { compactionCount: 0 }, children: [] };
		const ui: any = {
			agentConnection: {
				...connection,
				getInitialSnapshot: vi.fn(async () => {
					const n = ++calls;
					order.push(`start ${n}`);
					if (n === 1) await firstGate;
					order.push(`end ${n}`);
					return snapshot;
				}),
			},
			initialRenderPromise: undefined,
			getSessionContextFromConnectionSnapshot: () => ({ messages: [] }),
			seedSubagentSummary: () => {},
			setSessionHasMessages: () => {},
			applyConnectionStateSnapshot: () => {},
			restoreTurnStartFromMessages: () => {},
			renderContextVarsInline: () => {},
			renderSessionContext: async () => {},
			restoreStreamingMessageFromSnapshot: async () => {},
			showStatus: () => {},
		};
		const render = (InteractiveMode.prototype as any).renderInitialMessages as (this: any) => Promise<void>;
		const first = render.call(ui);
		const second = render.call(ui);
		await tick();
		expect(order).toEqual(["start 1"]);
		releaseFirst();
		await Promise.all([first, second]);
		expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
		expect(connection.flushBufferedSessionEvents).toHaveBeenCalledOnce();
		expect(ui.initialRenderPromise).toBeUndefined();
	});

	it("releases deferred events even when the initial render fails", async () => {
		const connection = fakeConnection();
		const ui: any = {
			agentConnection: {
				...connection,
				getInitialSnapshot: vi.fn(async () => {
					throw new Error("snapshot failed");
				}),
			},
			initialRenderPromise: undefined,
		};
		const render = (InteractiveMode.prototype as any).renderInitialMessages as (this: any) => Promise<void>;
		await expect(render.call(ui)).rejects.toThrow("snapshot failed");
		expect(connection.flushBufferedSessionEvents).toHaveBeenCalledOnce();
	});
});

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ExtensionUIContext } from "../src/core/extensions/index.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ClientExtensionUiHost } from "../src/modes/daemon/client-extension-ui-host.js";

const EXT = (marker: string) => `
export default function (pi) {
	let ends = 0;
	let ui;
	const draw = () => ui?.setWidget("todo", () => ({ render: () => ["${marker} ends=" + ends], invalidate() {} }));
	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		ctx.ui.setFooter(() => ({ render: () => ["footer ${marker}"], invalidate() {} }));
		ctx.ui.setWidget("lines", ["worker delivers these"]);
		ctx.ui.notify("worker delivers this too");
		pi.sendMessage({ customType: "x", content: "must be a no-op", display: false });
		globalThis.__kkBranch = ctx.sessionManager.getBranch().length;
		draw();
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		ends++;
		globalThis.__kkLastTool = event.toolName;
		globalThis.__kkBranch = ctx.sessionManager.getBranch().length;
		draw();
	});
	pi.on("session_tree", async (event, ctx) => {
		(globalThis.__kkTrees ??= []).push([event.oldLeafId, event.newLeafId, ctx.sessionManager.getBranch().length]);
	});
	pi.on("session_shutdown", async (event) => {
		(globalThis.__kkShutdowns ??= []).push(event.reason);
	});
	pi.registerShortcut("ctrl+alt+k", { description: "probe", handler: async (ctx) => { ctx.ui.notify("shortcut ${marker}"); } });
}
`;

const recordingUi = () => {
	const calls: Array<[string, unknown[]]> = [];
	const ui = new Proxy({} as ExtensionUIContext, {
		get: (_t, prop) => {
			if (prop === "theme") return {};
			return (...args: unknown[]) => {
				calls.push([String(prop), args]);
				if (prop === "onTerminalInput") return () => calls.push(["offTerminalInput", []]);
				return undefined;
			};
		},
	});
	return { ui, calls };
};

const sessionLine = (entry: object) => `${JSON.stringify(entry)}\n`;

describe("ClientExtensionUiHost", () => {
	let dir: string;
	let cwd: string;
	let agentDir: string;
	let sessionFile: string;
	let hosts: ClientExtensionUiHost[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kk-ui-host-"));
		cwd = join(dir, "proj");
		agentDir = join(dir, "agent");
		for (const d of [cwd, agentDir, join(agentDir, "extensions")]) {
			require("node:fs").mkdirSync(d, { recursive: true });
		}
		writeFileSync(join(agentDir, "extensions", "probe.ts"), EXT("v1"));
		sessionFile = join(dir, "s.jsonl");
		writeFileSync(
			sessionFile,
			sessionLine({ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd }) +
				sessionLine({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "hello", timestamp: Date.now() },
				}),
		);
		for (const k of ["__kkBranch", "__kkLastTool", "__kkShutdowns", "__kkTrees"]) delete (globalThis as any)[k];
	});

	afterEach(async () => {
		for (const h of hosts) await h.dispose();
		hosts = [];
		rmSync(dir, { recursive: true, force: true });
	});

	const start = async (ui: ExtensionUIContext, watch = false) => {
		const host = await ClientExtensionUiHost.start({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			modelRegistry: ModelRegistry.create(AuthStorage.inMemory(), join(dir, "models.json")),
			ui,
			getSessionFile: () => sessionFile,
			getModel: () => undefined,
			getThinkingLevel: () => "off",
			isIdle: () => true,
			abort: () => {},
			getContextUsage: () => undefined,
			onError: (e) => {
				throw new Error(`${e.event}: ${e.error}`);
			},
			watch,
		});
		hosts.push(host);
		return host;
	};

	it("passes only UI the worker cannot deliver, and runs no side effects", async () => {
		const { ui, calls } = recordingUi();
		await start(ui);
		const names = calls.map(([n]) => n);
		expect(names).toContain("setFooter");
		const widgetCalls = calls.filter(([n]) => n === "setWidget").map(([, a]) => a[0]);
		expect(widgetCalls).toEqual(["todo"]); // factory passes; the array widget is the worker's
		expect(names).not.toContain("notify"); // worker delivers notify
		expect((globalThis as any).__kkBranch).toBe(1);
	});

	it("maps daemon session events to extension events and re-reads the session file", async () => {
		const { ui, calls } = recordingUi();
		const host = await start(ui);
		appendFileSync(
			sessionFile,
			sessionLine({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "again", timestamp: Date.now() },
			}),
		);
		host.handleSessionEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "todo", result: {}, isError: false });
		await host.idle();
		expect((globalThis as any).__kkLastTool).toBe("todo");
		expect((globalThis as any).__kkBranch).toBe(2);
		const lastTodo = calls.filter(([n, a]) => n === "setWidget" && a[0] === "todo").at(-1)!;
		expect((lastTodo[1][1] as () => { render(): string[] })().render()).toEqual(["v1 ends=1"]);
	});

	it("replays from disk after a worker tool result, as session_tree for the moved leaf", async () => {
		const { ui } = recordingUi();
		const host = await start(ui);
		appendFileSync(
			sessionFile,
			sessionLine({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: new Date().toISOString(),
				message: { role: "toolResult", toolCallId: "t1", toolName: "todo", content: [], isError: false, timestamp: Date.now() },
			}),
		);
		host.handleSessionEvent({ type: "message_end", message: { role: "toolResult", toolCallId: "t1" } });
		await host.idle();
		expect((globalThis as any).__kkTrees).toEqual([["m1", "m2", 2]]);
		// No change on disk → no second event.
		host.handleSessionEvent({ type: "agent_end", messages: [] });
		await host.idle();
		expect((globalThis as any).__kkTrees).toHaveLength(1);
	});

	it("runs shortcuts client-side with the full UI", async () => {
		const { ui, calls } = recordingUi();
		const host = await start(ui);
		expect(host.handleShortcut("\x1b\x0b", {})).toBe(true); // ctrl+alt+k
		await new Promise((r) => setTimeout(r, 20));
		expect(calls.some(([n, a]) => n === "notify" && a[0] === "shortcut v1")).toBe(true);
	});

	it("reloads live when the extension file changes, and takes its surfaces down", async () => {
		const { ui, calls } = recordingUi();
		const host = await start(ui, true);
		writeFileSync(join(agentDir, "extensions", "probe.ts"), EXT("v2"));
		const deadline = Date.now() + 5000;
		while (!host.lifecycle.includes("start:reload") && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(host.lifecycle).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
		expect((globalThis as any).__kkShutdowns).toEqual(["reload"]);
		const lastFooter = calls.filter(([n]) => n === "setFooter").at(-1)!;
		expect((lastFooter[1][0] as () => { render(): string[] })().render()).toEqual(["footer v2"]);
		await host.dispose();
		const tail = calls.slice(-2).map(([n, a]) => [n, a[0]]);
		expect(tail).toEqual([
			["setFooter", undefined],
			["setWidget", "todo"],
		]);
		expect(readFileSync(sessionFile, "utf8").split("\n").filter(Boolean)).toHaveLength(2); // never wrote the session
	});
});

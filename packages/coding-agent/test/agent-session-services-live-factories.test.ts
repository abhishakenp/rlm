import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveConcat } from "../src/core/agent-session-services.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";

// A row mounted after a session was built (cordis.yml edited live, a hot swap)
// contributes its extension factory to a live list. The session's resource
// loader must see it on the next reload; it used to hold a copy made at
// session creation, so such an extension never attached until a restart.
describe("extension factories contributed after session creation", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("liveConcat reflects later additions", () => {
		const tail: string[] = ["a"];
		const live = liveConcat(["builtin"], tail);
		expect([...live]).toEqual(["builtin", "a"]);
		tail.push("b");
		expect(live.length).toBe(3);
		expect([...live.entries()].map(([, v]) => v)).toEqual(["builtin", "a", "b"]);
	});

	it("a factory added after the loader is built is loaded on reload", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "live-factories-"));
		const agentDir = mkdtempSync(join(tmpdir(), "live-factories-agent-"));
		dirs.push(cwd, agentDir);
		const contributed: Array<(pi: any) => void> = [];
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: liveConcat([], contributed),
		});
		await loader.reload();
		const before = loader.getExtensions().extensions.length;
		contributed.push((pi) => pi.registerCommand("late-row", { description: "late", handler: async () => {} }));
		await loader.reload();
		const commands = loader.getExtensions().extensions.flatMap((e: any) => [...e.commands.keys()]);
		expect(loader.getExtensions().extensions.length).toBe(before + 1);
		expect(commands).toContain("late-row");
	});
});

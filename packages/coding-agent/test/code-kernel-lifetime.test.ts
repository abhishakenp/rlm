import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { CodeKernelProvisioner, rebindCodeKernels } from "../src/core/tools/code.js";

/**
 * The code kernel lives as long as its session. A rebuild of the session's
 * tools — `/reload`, a resource or plugin reload, a heartbeat controller being
 * attached — used to dispose it and start another, so a cell in flight failed
 * with "Code kernel provisioner disposed" and every variable was gone.
 */

describe("code kernel lifetime", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `code-kernel-lifetime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	const createSession = async () => {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true });
		await loader.reload();
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: "Test", tools: [] },
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd,
			modelRegistry: ModelRegistry.create(authStorage, tempDir),
			resourceLoader: loader,
		});
	};

	const kernelOf = (s: AgentSession) => (s as any)._codeKernelProvisioner as CodeKernelProvisioner;

	it("keeps the same kernel and its variables across repeated reloads", async () => {
		session = await createSession();
		const kernel = kernelOf(session);
		expect(kernel).toBeInstanceOf(CodeKernelProvisioner);
		expect((await kernel.execute("var x = 42; x")).status).toBe("ok");

		for (let i = 0; i < 3; i++) await session.reload();

		expect(kernelOf(session)).toBe(kernel);
		const after = await kernelOf(session).execute("x");
		expect(after.status).toBe("ok");
		expect(after.result).toBe("42");
	});

	it("lets a cell that is running across a reload finish", async () => {
		session = await createSession();
		const kernel = kernelOf(session);
		await kernel.execute("var y = 7");
		const inFlight = kernel.execute("await new Promise((r) => setTimeout(r, 200)); y * 6");
		await session.reload();
		const result = await inFlight;
		expect(result.status).toBe("ok");
		expect(result.result).toBe("42");
	});

	it("disposes the kernel only when the session is disposed", async () => {
		session = await createSession();
		const kernel = kernelOf(session);
		await session.reload();
		expect(kernel.hasRunningKernel || (await kernel.ensure(), kernel.hasRunningKernel)).toBe(true);
		await session.disposeAsync();
		session = undefined;
		await expect(kernel.ensure()).rejects.toThrow(/disposed/);
	});

	it("a kernel an older rebuild disposed under a live session comes back instead of failing every cell", async () => {
		const kernel = new CodeKernelProvisioner(cwd);
		await kernel.execute("var a = 1");
		// What the pre-fix `_buildRuntime` left behind: flagged and emptied, but
		// not ended by its session.
		(kernel as any)._disposed = true;
		(kernel as any).context = null;
		await expect(kernel.ensure()).resolves.toBeDefined();
		const r = await kernel.execute("typeof a + ',' + (1 + 1)");
		expect(r.status).toBe("ok");
		expect(r.result).toBe("undefined,2");
		await kernel.dispose();
		await expect(kernel.ensure()).rejects.toThrow(/disposed/);
	});

	it("an idle kernel that is killed still answers the next cell with its variables", async () => {
		const kernel = new CodeKernelProvisioner(cwd);
		await kernel.execute("var z = 5");
		await kernel.kill();
		const r = await kernel.execute("z + 1");
		expect(r.status).toBe("ok");
		expect(r.result).toBe("6");
	});

	it("rebinding host globals after a code reload keeps user variables and user overrides", async () => {
		const kernel = new CodeKernelProvisioner(cwd);
		await kernel.execute("var keep = 'mine'\nvar sh = () => 'user sh'");
		expect((await kernel.execute("typeof exec")).result).toBe("function");
		const execBefore = (await kernel.execute("globalThis.__execRef = exec; 1")).status;
		expect(execBefore).toBe("ok");
		expect(rebindCodeKernels()).toBeGreaterThanOrEqual(1);
		// Host helpers are the current module's again…
		expect((await kernel.execute("exec === globalThis.__execRef")).result).toBe("false");
		expect((await kernel.execute("typeof exec")).result).toBe("function");
		// …and nothing the user put in the kernel moved.
		expect((await kernel.execute("keep")).result).toBe("mine");
		// A name the user reassigned is theirs; a rebind must not take it back.
		expect((await kernel.execute("sh()")).result).toBe("user sh");
		await kernel.dispose();
	});
});

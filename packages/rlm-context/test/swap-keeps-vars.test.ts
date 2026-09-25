/**
 * A swap of the rlm-context row keeps session/task variables and the proxy the
 * code kernel holds; removing the row for real takes the proxy back.
 *
 * Run: bunx vitest run packages/rlm-context/test/swap-keeps-vars.test.ts
 */
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("vars and the kernel's proxy survive a swap; removal releases the proxy", async () => {
	const { Context } = await import("@deepseek-ai/cordis");
	const { RlmContextService } = await import("../src/index.ts");
	const projectRoot = mkdtempSync(join(tmpdir(), "rlm-ctx-swap-"));
	const root: any = new Context();

	const a = root.plugin(RlmContextService, { projectRoot });
	await a.await?.();
	const proxy = (globalThis as any).__rlmContextProxy;
	expect(proxy).toBeTruthy();
	proxy.set("swapProbe", 4242, { scope: "session" });

	await a.dispose();
	const b = root.plugin(RlmContextService, { projectRoot });
	await b.await?.();
	// The kernel's reference is the same object and still answers.
	expect((globalThis as any).__rlmContextProxy).toBe(proxy);
	expect(proxy.get("swapProbe")).toBe(4242);
	expect(root.get("rlmContext").get("swapProbe")?.value).toBe(4242);

	await b.dispose();
	await new Promise((r) => setTimeout(r, 3200));
	expect((globalThis as any).__rlmContextProxy).toBeUndefined();
}, 15000);

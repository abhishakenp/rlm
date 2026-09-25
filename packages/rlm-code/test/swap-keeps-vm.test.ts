/**
 * A swap of the rlm-code row keeps the VM (and the variables in it); removing
 * the row for real releases it.
 *
 * Run: bunx vitest run packages/rlm-code/test/swap-keeps-vm.test.ts
 */
import { expect, test } from "vitest";
import { isHeld } from "../../rlm-hmr/src/hot.ts";

test("variables survive dispose + a new generation; a real removal releases the VM", async () => {
	const { Context } = await import("@deepseek-ai/cordis");
	const { RlmCodeService } = await import("../src/index.ts");
	const root: any = new Context();
	root.provide("rlmConfig", {}, true);

	const a = root.plugin(RlmCodeService, {});
	await a.await?.();
	const svcA: any = root.get("rlmCode");
	expect((await svcA.execute("var kept = 41 + 1; kept")).result).toBe("42");

	// Swap: old generation disposed, new one started (what rlm-hmr does).
	await a.dispose();
	const b = root.plugin(RlmCodeService, {});
	await b.await?.();
	const svcB: any = root.get("rlmCode");
	expect(svcB).not.toBe(svcA);
	expect((await svcB.execute("kept")).result).toBe("42");
	expect(svcB.vars()).toContain("kept");

	// Removed for real: after the grace period the VM is released.
	await b.dispose();
	await new Promise((r) => setTimeout(r, 3200));
	expect(isHeld("rlm-code:vm")).toBe(false);
}, 15000);

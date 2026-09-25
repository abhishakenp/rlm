/**
 * A swap of the rlm-prompt row keeps every row's fragments; removing the row
 * for real clears the registry.
 *
 * Run: bun test packages/rlm-prompt/swap-keeps-fragments.test.ts
 */
import { expect, test } from "bun:test";

test("fragments registered before a swap are in the new registry; old handles still dispose", async () => {
	const { Context } = await import("@deepseek-ai/cordis");
	const { RlmPromptService } = await import("./src/index.ts");
	const root: any = new Context();

	const a = root.plugin(RlmPromptService, {});
	await a.await?.();
	const regA: any = (globalThis as any).__rlmPrompt;
	const h1 = regA.registerFragment("probe-row", { id: "one", content: "FRAGMENT-ONE", priority: 10 });
	regA.registerFragment("probe-row", { id: "two", content: "FRAGMENT-TWO", priority: 20 });

	await a.dispose();
	const b = root.plugin(RlmPromptService, {});
	await b.await?.();
	const regB: any = (globalThis as any).__rlmPrompt;
	expect(regB).not.toBe(regA);
	const texts = () => regB.getFragments().map((f: any) => f.content);
	expect(texts()).toEqual(["FRAGMENT-TWO", "FRAGMENT-ONE"]);

	// A handle issued by the old generation still works against the shared registry.
	h1.dispose();
	expect(texts()).toEqual(["FRAGMENT-TWO"]);

	await b.dispose();
	await new Promise((r) => setTimeout(r, 3200));
	expect((globalThis as any).__rlmPrompt).toBeUndefined();
});

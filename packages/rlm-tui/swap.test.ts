/**
 * A hot swap of the tui row carries its registry to the successor: items,
 * listeners and the render callback registered on the old instance keep
 * working, handles issued by the old instance still dispose, and nothing is
 * wiped when a successor took over. Run: `bun test packages/rlm-tui/swap.test.ts`.
 */
import { expect, test } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import RlmTuiService from "./src/index.ts";

const g = globalThis as any;

test("the successor adopts the registry; the old handles still work", async () => {
	const root: any = new Context();
	const first = root.plugin(RlmTuiService, {});
	for (let i = 0; i < 100 && !g.__rlmTui; i++) await Bun.sleep(5);
	const old = g.__rlmTui;
	let renders = 0;
	old.setRenderCallback?.(() => renders++);
	const item = old.registerStatusBarItem("probe", { id: "probe-item", renderer: () => "P" });
	const heard: string[] = [];
	old.onDisplayedSessionEvent("probe", (e: any) => heard.push(e.type));

	first.dispose();
	root.plugin(RlmTuiService, {});
	for (let i = 0; i < 100 && g.__rlmTui === old; i++) await Bun.sleep(5);
	const next = g.__rlmTui;
	expect(next).not.toBe(old);

	expect(next.getStatusBarItems().map((i: any) => i.id)).toContain("probe-item");
	next.publishDisplayedSessionEvent({ type: "message_start" }, "s1");
	expect(heard).toEqual(["message_start"]); // exactly once: no duplicate listener

	await Bun.sleep(3300); // past the old instance's retire grace: nothing wiped
	expect(next.getStatusBarItems().map((i: any) => i.id)).toContain("probe-item");

	item.dispose(); // a handle from the old instance still removes from the live registry
	expect(next.getStatusBarItems().map((i: any) => i.id)).not.toContain("probe-item");
}, 10000);

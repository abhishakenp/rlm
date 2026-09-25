/**
 * The row end to end against a real rlm-tui: displayed-session events in, one
 * status item out; per-session values; late (bunched) events rated from the
 * message's own start; and still registered after the tui row is swapped.
 */
import { Context } from "@deepseek-ai/cordis";
import RlmTuiService from "/Users/abhi/proj/rlm/packages/rlm-tui/src/index.ts";
import RlmTpsService from "/Users/abhi/proj/rlm/packages/rlm-tps/src/index.ts";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => {
	if (ok) { pass++; console.log("  ok  " + name); }
	else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as any;

const root: any = new Context();
const tuiFiber = root.plugin(RlmTuiService, {});
await sleep(200);
root.plugin(RlmTpsService, {});
await sleep(200);

const tpsText = () => {
	const item = g.__rlmTui?.getStatusBarItems?.().find((i: any) => i.id === "tokens-per-second");
	return item ? item.renderer({ width: 120, cwd: "/" }) : "(no item)";
};
const assistant = (text: string, timestamp: number, output = 0) => ({
	role: "assistant",
	timestamp,
	content: [{ type: "text", text }],
	usage: { output },
});
const publish = (event: any, sid: string) => g.__rlmTui.publishDisplayedSessionEvent(event, sid);

t("registered on the tray", tpsText() === null, String(tpsText()));

// A reply whose events all arrive in the last 100ms of a 10s response.
const start = Date.now() - 10_000;
publish({ type: "session_attached" }, "s1");
publish({ type: "message_start", message: assistant("", start) }, "s1");
publish({ type: "message_update", message: assistant("x".repeat(40), start) }, "s1");
await sleep(100);
publish({ type: "message_end", message: assistant("x".repeat(560), start, 140) }, "s1");
t("bunched events are rated from the message's own start", tpsText() === "14 tok/s", String(tpsText()));

// Another session shows its own value; coming back shows the first one.
publish({ type: "session_attached" }, "s2");
t("a fresh session shows nothing yet", tpsText() === null, String(tpsText()));
publish({ type: "session_attached" }, "s1");
t("back on the first session its value returns", tpsText() === "14 tok/s", String(tpsText()));

// Updates with no start seen (listener attached mid-stream) still time from the message.
const start2 = Date.now() - 4_000;
publish({ type: "message_update", message: assistant("y".repeat(40), start2) }, "s3");
await sleep(60);
publish({ type: "message_end", message: assistant("y".repeat(400), start2, 100) }, "s3");
t("mid-stream attach rates from the message start", tpsText() === "25 tok/s", String(tpsText()));

// Swap the tui row: the new service starts empty; the row registers again.
tuiFiber.dispose();
await sleep(50);
root.plugin(RlmTuiService, {});
await sleep(1300);
t("re-registered after the tui row was swapped", tpsText() !== "(no item)", String(tpsText()));
publish({ type: "session_attached" }, "s1");
t("and still has its per-session values", tpsText() === "14 tok/s", String(tpsText()));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

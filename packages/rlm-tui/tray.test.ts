/**
 * The prompt tray's plugin surface: status items in `order`, the displayed
 * session's events, the one transient notice, and the stderr guard that keeps
 * `[rlm] …` chatter from landing in the middle of a running chat.
 */
import { Context } from "@deepseek-ai/cordis";
import RlmTuiService, { routeRlmChatter } from "/Users/abhi/proj/rlm/packages/rlm-tui/src/index.ts";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => {
	if (ok) { pass++; console.log("  ok  " + name); }
	else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

const root: any = new Context();
root.plugin(RlmTuiService, {});
await new Promise((r) => setTimeout(r, 250));
const tui = root.rlmTui ?? root.get?.("rlmTui");
t("the tui service is up", !!tui);

// Status items render in `order`, lowest first; default 100.
tui.registerStatusBarItem("p1", { id: "late", renderer: () => "late" });
tui.registerStatusBarItem("p2", { id: "early", order: 10, renderer: () => "early" });
const ids = tui.getStatusBarItems().map((i: any) => i.id);
t("status items sort by order", ids.indexOf("early") < ids.indexOf("late"), JSON.stringify(ids));

// Displayed-session events reach listeners with the session id; disposal stops them.
const seen: Array<[string, string | undefined]> = [];
const handle = tui.onDisplayedSessionEvent("p3", (e: any, sid: string | undefined) => seen.push([e.type, sid]));
tui.publishDisplayedSessionEvent({ type: "message_start" }, "s1");
tui.publishDisplayedSessionEvent({ type: "session_attached" }, "s2");
handle.dispose();
tui.publishDisplayedSessionEvent({ type: "message_end" }, "s2");
t("listener hears events with their session id", JSON.stringify(seen) === JSON.stringify([["message_start", "s1"], ["session_attached", "s2"]]), JSON.stringify(seen));

// One notice: the latest replaces the last, and it expires.
let renders = 0;
tui.setRenderCallback(() => { renders++; });
tui.announce("↻ reloaded a.ts", { ttlMs: 150 });
tui.announce("↻ reloaded b.ts", { ttlMs: 150 });
const n = tui.getNotice();
t("latest notice wins", n?.text === "↻ reloaded b.ts", JSON.stringify(n));
t("the burst is counted", n?.count === 2, JSON.stringify(n));
t("announcing asks for a render", renders >= 2);
await new Promise((r) => setTimeout(r, 250));
t("the notice clears itself", tui.getNotice() === undefined);
t("and asks for a render when it does", renders >= 3);

// The stderr guard: only while a chat is up, only `[rlm]` lines.
const g = globalThis as any;
t("the guard wrapped console.error", typeof g.__rlmStderrGuard?.originalError === "function" && console.error !== g.__rlmStderrGuard.originalError);
const realActive = tui.isTuiActive.bind(tui);
tui.isTuiActive = () => true;
t("a reload line under a running chat is taken", routeRlmChatter("[rlm] HMR: session resources reloaded (plugin reloaded)") === true);
t("and becomes the notice", tui.getNotice()?.text === "↻ session resources reloaded (plugin reloaded)", JSON.stringify(tui.getNotice()));
routeRlmChatter("\x1b[31m[rlm] HMR: system prompt refresh failed: boom\x1b[0m");
t("a failed reload is a warning (colour codes ignored)", tui.getNotice()?.level === "warn" && tui.getNotice()?.text === "⚠ system prompt refresh failed: boom", JSON.stringify(tui.getNotice()));
const kept = tui.getNotice()?.text;
t("other [rlm] chatter is taken (logged, not printed)", routeRlmChatter("[rlm] rlm-integration: listening on http://127.0.0.1:20130") === true);
t("without replacing the notice", tui.getNotice()?.text === kept);
t("non-rlm stderr passes through", routeRlmChatter("TypeError: real problem") === false);
tui.isTuiActive = () => false;
t("with no chat up nothing is taken", routeRlmChatter("[rlm] HMR: session resources reloaded (x)") === false);
tui.isTuiActive = realActive;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

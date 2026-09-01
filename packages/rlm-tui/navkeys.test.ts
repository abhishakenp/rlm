/**
 * h, j, k and l are letters before they are directions. Binding them at the
 * panel level takes them out of ordinary typing, so navigation is arrows by
 * default and hjkl is opt-in.
 */
import { Context } from "@deepseek-ai/cordis";
import RlmTuiService, { resolveRlmTuiConfig, DEFAULT_TUI_CONFIG } from "/Users/abhi/proj/rlm/packages/rlm-tui/src/index.ts";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

t("hjkl is off in the shipped default", DEFAULT_TUI_CONFIG.hjklNavigation === false);
t("and off when a config omits it", resolveRlmTuiConfig({}).hjklNavigation === false);
t("but still opt-in", resolveRlmTuiConfig({ hjklNavigation: true }).hjklNavigation === true);

const root: any = new Context();
root.plugin(RlmTuiService, {});
await new Promise((r) => setTimeout(r, 250));
const tui = root.rlmTui ?? root.get?.("rlmTui");

t("the tui service is up", !!tui);
if (tui) {
  t("arrows navigate", tui.isNavKey("arrowdown", "down") === true);
  t("arrows navigate horizontally", tui.isNavKey("arrowleft", "left") === true);
  for (const [key, dir] of [["j", "down"], ["k", "up"], ["h", "left"], ["l", "right"]] as const) {
    t(`typing "${key}" is not navigation`, tui.isNavKey(key, dir) === false);
  }
  const optedIn: any = new Context();
  optedIn.plugin(RlmTuiService, { hjklNavigation: true });
  await new Promise((r) => setTimeout(r, 250));
  const tui2 = optedIn.rlmTui ?? optedIn.get?.("rlmTui");
  t('opting in restores "j"', tui2?.isNavKey("j", "down") === true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

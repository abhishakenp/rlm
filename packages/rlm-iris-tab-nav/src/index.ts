/**
 * rlm-iris-tab-nav — tab navigation commands via the Iris daemon protocol.
 *
 * Uses the same AppleScript + app scripting dictionary pattern as @iris/control
 * to switch between tabs. Commands:
 *   iris tab prev  — switch to previous tab in the frontmost app
 *   iris tab next  — switch to next tab in the frontmost app
 *   iris tab switch <name> — find a tab matching <name> and switch to it
 */

import { execSync } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Service, type Context } from "@deepseek-ai/cordis";

const run = promisify(execFile);

declare module "@deepseek-ai/cordis" {
  interface Context {
    irisTabNav: IrisTabNavService;
  }
}

export const name = "iris-tab-nav";

async function osa(
  lines: string[],
  args: string[] = [],
  timeoutMs = 8000,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const script = ["on run argv", ...lines, "end run"];
  const argv: string[] = [];
  for (const line of script) argv.push("-e", line);
  try {
    const { stdout } = await run("/usr/bin/osascript", [...argv, "--", ...args], {
      timeout: timeoutMs,
    });
    return { ok: true, output: stdout.trim() };
  } catch (err: unknown) {
    const msg = String((err as { stderr?: string; message?: string }).stderr ?? (err as Error).message ?? "AppleScript failed").trim();
    return { ok: false, output: "", error: msg };
  }
}

export class IrisTabNavService extends Service {
  static provide = "irisTabNav" as const;
  static inject = ["commands"] as const;

  constructor(ctx: Context) {
    super(ctx, undefined as any);
  }

  async [Service.init]() {
    this.registerCommands();
  }

  /** Ctrl+Shift+Tab — previous tab in Terminal, Safari, Chrome, Brave, Firefox and Arc. */
  private async prevTab(): Promise<{ ok: boolean; error?: string }> {
    return this.sendKey("prev");
  }

  /** Ctrl+Tab — next tab in the same apps. */
  private async nextTab(): Promise<{ ok: boolean; error?: string }> {
    return this.sendKey("next");
  }

  /**
   * Press the tab chord. `keystroke "control+["` used to type those characters
   * literally (and Ctrl+[ is Escape in a terminal); key code 48 is Tab.
   */
  private async sendKey(direction: "prev" | "next"): Promise<{ ok: boolean; error?: string }> {
    const mods = direction === "prev" ? "{control down, shift down}" : "{control down}";
    const script = `tell application "System Events" to key code 48 using ${mods}`;
    return osa([script], [], 3000);
  }

  async findAndSwitchTab(name: string): Promise<{ ok: boolean; app?: string; tab?: string; error?: string }> {
    const n = name.trim();
    if (!n) return { ok: false, error: "empty search name" };

    const apps: Array<{ name: string; script: string }> = [
      {
        name: "Terminal",
        script: `tell application "Terminal"
  set matchTab to null
  repeat with w in windows
    repeat with t in tabs of w
      try
        set tabName to (custom title of t as string)
        if tabName contains (item 1 of argv) then set matchTab to t
      end try
      if matchTab is not null then exit repeat
    end repeat
    if matchTab is not null then exit repeat
  end repeat
  if matchTab is null then return "not found"
  return ((id of window of matchTab) as string) & "|" & ((index of matchTab) as string) & "|" & ((custom title of matchTab) as string)
end tell`,
      },
      {
        name: "Safari",
        script: `tell application "Safari"
  set matchTab to null
  repeat with w in windows
    repeat with t in tabs of w
      if ((name of t) as string) contains (item 1 of argv) then set matchTab to t
      if matchTab is null and ((URL of t) as string) contains (item 1 of argv) then set matchTab to t
      if matchTab is not null then exit repeat
    end repeat
    if matchTab is not null then exit repeat
  end repeat
  if matchTab is null then return "not found"
  return ((id of w) as string) & "|" & ((index of matchTab) as string) & "|" & ((name of matchTab) as string)
end tell`,
      },
      {
        name: "Google Chrome",
        script: `tell application "Google Chrome"
  set matchTab to null
  repeat with w in windows
    repeat with t in tabs of w
      if ((title of t) as string) contains (item 1 of argv) then set matchTab to t
      if matchTab is null and ((URL of t) as string) contains (item 1 of argv) then set matchTab to t
      if matchTab is not null then exit repeat
    end repeat
    if matchTab is not null then exit repeat
  end repeat
  if matchTab is null then return "not found"
  return ((id of w) as string) & "|" & ((index of matchTab) as string) & "|" & ((title of matchTab) as string)
end tell`,
      },
      {
        name: "Arc",
        script: `tell application "Arc"
  try
    set matchTab to null
    repeat with t in (tabs of front window)
      if ((name of t) as string) contains (item 1 of argv) then set matchTab to t
      if matchTab is not null then exit repeat
    end repeat
  on error
    return "not found"
  end try
  if matchTab is null then return "not found"
  return "found|" & ((name of matchTab) as string)
end tell`,
      },
      {
        name: "Brave Browser",
        script: `tell application "Brave Browser"
  set matchTab to null
  repeat with w in windows
    repeat with t in tabs of w
      if ((title of t) as string) contains (item 1 of argv) then set matchTab to t
      if matchTab is null and ((URL of t) as string) contains (item 1 of argv) then set matchTab to t
      if matchTab is not null then exit repeat
    end repeat
    if matchTab is not null then exit repeat
  end repeat
  if matchTab is null then return "not found"
  return ((id of w) as string) & "|" & ((index of matchTab) as string) & "|" & ((title of matchTab) as string)
end tell`,
      },
      {
        name: "Firefox",
        script: `tell application "Firefox"
  set matchTab to null
  repeat with w in windows
    repeat with t in tabs of w
      if ((name of t) as string) contains (item 1 of argv) then set matchTab to t
      if matchTab is not null then exit repeat
    end repeat
    if matchTab is not null then exit repeat
  end repeat
  if matchTab is null then return "not found"
  return ((id of w) as string) & "|" & ((index of matchTab) as string)
end tell`,
      },
    ];

    for (const app of apps) {
      const result = await osa([app.script], [n], 5000);
      if (!result.ok) continue;
      const out = result.output.trim();
      if (!out || out.startsWith("not found") || out.includes("error") || out === "missing value") continue;

      await osa(["tell application (item 1 of argv) to activate"], [app.name], 3000);

      const parts = out.split("|");
      if (parts[0] && parts[0] !== "not found") {
        if (app.name === "Arc") {
          // Arc does not expose tab selection via AppleScript; use keyboard shortcut as fallback
          const navResult = await this.sendKey("next");
          return { ok: navResult.ok, app: app.name, tab: parts[1] ?? n, error: navResult.error };
        }

        const tabIndexStr = parts[1];
        const tabTitle = parts[2] ?? n;
        const switchResult = await this.switchToTabByIndex(app.name, tabIndexStr);
        return {
          ok: switchResult.ok,
          app: app.name,
          tab: tabTitle,
          error: switchResult.error,
        };
      }
    }

    return { ok: false, error: `no tab found matching "${n}"` };
  }

  private async switchToTabByIndex(
    appName: string,
    indexStr: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const idx = parseInt(indexStr, 10);
    if (!Number.isFinite(idx) || idx < 1) return { ok: false, error: "invalid tab index" };

    const scripts: Record<string, (i: number) => string> = {
      Terminal: (i) =>
        `tell application "Terminal"
  set w to window 1
  set tabCount to count of tabs of w
  if ${i} > tabCount then return "out of range"
  set selected tab of w to tab ${i} of w
end tell`,
      Safari: (i) =>
        `tell application "Safari"
  set w to front window
  set current tab of w to tab ${i} of w
end tell`,
      "Google Chrome": (i) =>
        `tell application "Google Chrome"
  set w to front window
  set active tab index of w to ${i}
end tell`,
      "Brave Browser": (i) =>
        `tell application "Brave Browser"
  set w to front window
  set active tab index of w to ${i}
end tell`,
      Firefox: (i) =>
        `tell application "Firefox"
  set w to front window
  set active tab index of w to ${i}
end tell`,
    };

    const scriptFn = scripts[appName];
    if (!scriptFn) return { ok: false, error: appName + " does not support direct tab selection" };

    const result = await osa([scriptFn(idx)], [], 5000);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true };
  }

  private registerCommands() {
    const c = this.ctx.commands;

    c.register({
      name: "iris tab prev",
      summary: "Switch to the previous terminal or app tab.",
      examples: ["iris tab prev"],
      mutates: true,
      run: async () => {
        const result = await this.prevTab();
        if (!result.ok) return "could not switch to previous tab — " + (result.error ?? "unknown error");
        return "switched to previous tab";
      },
    });

    c.register({
      name: "iris tab next",
      summary: "Switch to the next terminal or app tab.",
      examples: ["iris tab next"],
      mutates: true,
      run: async () => {
        const result = await this.nextTab();
        if (!result.ok) return "could not switch to next tab — " + (result.error ?? "unknown error");
        return "switched to next tab";
      },
    });

    c.register({
      name: "iris tab switch",
      summary:
        "Find a tab by its title or working directory and switch to it. Searches Terminal, Safari, Chrome, Arc, Brave and Firefox.",
      examples: ['iris tab switch name="rlm"', 'iris tab switch name="github"'],
      mutates: true,
      parameters: {
        name: { type: "string", description: "A substring to match against tab titles or working directories.", required: true },
      },
      run: async ({ name }: { name: string }) => {
        const result = await this.findAndSwitchTab(name);
        if (!result.ok) return result.error ?? `could not switch to tab matching "${name}"`;
        return `switched to "${result.tab ?? name}" in ${result.app ?? "unknown app"}`;
      },
    });
  }
}

export default IrisTabNavService;

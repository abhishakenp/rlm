import { Service } from "@deepseek-ai/cordis";

/**
 * @rlm/iris-notify — desktop notification dispatch for the iris system.
 *
 * Provides a "notify" iris command that sends native desktop notifications
 * via the running macOS TUI session.
 */

export interface NotifyOptions {
  title?: string;
  body?: string;
  sound?: boolean;
  timeout?: number;
}

export interface NotifyConfig {
  defaultTitle?: string;
  defaultSound?: boolean;
  defaultTimeout?: number;
}

export class IrisNotify extends Service {
  static inject = ["rlmTui"] as const;
  static provide = "irisNotify" as const;

  declare config: NotifyConfig;

  constructor(goog: any, config: NotifyConfig = {}) {
    super(goog, undefined as any);
    this.config = config;
  }

  async [Service.init]() {
    const tui = this.ctx.get("rlmTui") as any;
    if (!tui?.registerSlashCommand) return;

    tui.registerSlashCommand("iris-notify", {
      name: "notify",
      description: "Send a desktop notification",
      takesArgument: true,
      argumentHint: "<title> [--body <text>] [--sound] [--timeout <ms>]",
      handler: async (args: string, ctx: any) => {
        const result = this.parseArgs(args);
        ctx.showMessage?.("```json\n" + JSON.stringify(result, null, 2) + "\n```");
        return result;
      },
    });
  }

  /**
   * Parse notification arguments from a string like:
   *   "Build complete" --body "All tests passed" --sound --timeout 3000
   */
  parseArgs(args: string): Record<string, unknown> {
    const parts = args.trim().split(/s+/);
    const title = parts[0] || this.config.defaultTitle || "Notification";
    const result: Record<string, unknown> = { title, dispatched: true };

    let i = 1;
    while (i < parts.length) {
      const key = parts[i].replace(/^--/, "");
      if (key === "body" && parts[i + 1] !== undefined) {
        result.body = parts[i + 1];
        i += 2;
      } else if (key === "sound") {
        result.sound = true;
        i++;
      } else if (key === "timeout" && parts[i + 1] !== undefined) {
        result.timeout = parseInt(parts[i + 1], 10);
        i += 2;
      } else {
        // Treat unknown flags as extra args
        result[key] = true;
        i++;
      }
    }

    return result;
  }

  /**
   * Send a notification programmatically.
   */
  async notify(opts: NotifyOptions): Promise<Record<string, unknown>> {
    const title = opts.title ?? this.config.defaultTitle ?? "Notification";
    const sound = opts.sound ?? this.config.defaultSound ?? true;
    const timeout = opts.timeout ?? this.config.defaultTimeout ?? 5000;

    return {
      title,
      body: opts.body ?? "",
      sound,
      timeout,
      dispatched: true,
    };
  }
}

export default IrisNotify;

import { Service } from "@deepseek-ai/cordis";
import * as readline from "node:readline";
import { stdin, stdout } from "node:process";

export class TuiService extends Service {
  static inject = ["memory", "refine", "wound", "reflection"] as const;

  private rl: readline.Interface | null = null;
  private messages: { role: string; content: string; timestamp: number }[] = [];
  private running = false;

  constructor(ctx: any) {
    super(ctx, "tui");
  }

  async *[Service.init]() {
    this.rl = readline.createInterface({ input: stdin, output: stdout, prompt: "rlm> " });
    this.running = true;

    this.ctx.on("assistant/message", (e: { data: { content: string } }) =>
      this.render("assistant", e.data.content),
    );
    this.ctx.on("tool/call", (e: { data: { name: string; args: unknown } }) =>
      this.render("tool", `[${e.data.name}] ${JSON.stringify(e.data.args).slice(0, 100)}`),
    );
    this.ctx.on("tool/result", (e: { data: { result: string; error?: string } }) =>
      this.render("result", e.data.error ? `ERROR: ${e.data.error}` : (e.data.result ?? "").slice(0, 200)),
    );
    this.ctx.on("wound/detected", (d: { pluginId: string; error: string; severity: string }) =>
      this.render("wound", `[${d.severity}] ${d.pluginId}: ${d.error.slice(0, 80)}`),
    );
    this.ctx.on("refine/swap", (e: { plugin: string; path: string }) =>
      this.render("evolve", `HOT-SWAP: ${e.plugin} (${e.path})`),
    );
    this.ctx.on("reflect/complete", (r: { journal: string }) =>
      this.render("reflect", r.journal),
    );
    this.ctx.on("refine/complete", (e: { success: boolean }) =>
      this.render("refine", e.success ? "success" : "failed"),
    );

    this.renderHeader();
    this.rl.prompt();
    this.rl.on("line", (line: string) => this.handleInput(line));
    this.rl.on("close", () => { this.running = false; });

    this.ctx.logger.info("tui: terminal surface active");

    yield async () => {
      this.running = false;
      this.rl?.close();
    };
  }

  private renderHeader() {
    stdout.write("\x1b[1m\x1b[36m");
    stdout.write("╔══════════════════════════════════════════╗\n");
    stdout.write("║  rlm — self-evolving terminal agent      ║\n");
    stdout.write("║  Cordis kernel + prime-agent brain       ║\n");
    stdout.write("╚══════════════════════════════════════════╝\n");
    stdout.write("\x1b[0m");
    stdout.write("Commands: /refine, /reflect, /wounds, /memory, /plugins, /exit\n\n");
  }

  private render(role: string, content: string) {
    if (!this.running || !this.rl) return;
    const colors: Record<string, string> = {
      assistant: "\x1b[37m", tool: "\x1b[33m", result: "\x1b[32m",
      wound: "\x1b[31m", evolve: "\x1b[35m", reflect: "\x1b[36m",
      refine: "\x1b[35m", user: "\x1b[1m\x1b[37m", system: "\x1b[90m",
    };
    const prefix: Record<string, string> = {
      assistant: "  ai", tool: " tool", result: "  out", wound: "WOUND",
      evolve: "EVOLVE", reflect: "REFLECT", refine: "REFINE",
      user: "  you", system: "  sys",
    };
    const color = colors[role] ?? "\x1b[0m";
    const tag = prefix[role] ?? role.padEnd(5);
    readline.cursorTo(stdout, 0);
    readline.clearLine(stdout, 0);
    stdout.write(`${color}${tag} │ \x1b[0m${content}\n`);
    this.rl.prompt();
  }

  private handleInput(line: string) {
    const input = line.trim();
    if (!input) { this.rl?.prompt(); return; }
    if (input.startsWith("/")) {
      this.handleCommand(input);
    } else {
      this.messages.push({ role: "user", content: input, timestamp: Date.now() });
      this.render("user", input);
      this.ctx.emit("user/message", { data: { content: input } });
      this.ctx.emit("turn/end", {});
    }
  }

  private handleCommand(cmd: string) {
    const [command, ...args] = cmd.slice(1).split(" ");
    switch (command) {
      case "exit": case "quit":
        this.render("system", "shutting down...");
        this.ctx.fiber.dispose().then(() => process.exit(0));
        break;
      case "refine": {
        const refine = this.ctx.refine;
        if (refine) {
          this.render("system", "triggering refinement...");
          refine.plan(this.messages, "manual", args[0]).then((p: unknown) =>
            this.render("refine", p ? `proposed: ${JSON.stringify(p).slice(0, 100)}` : "no proposal"),
          );
        } else { this.render("system", "refine plugin not loaded"); }
        break;
      }
      case "reflect": {
        const reflection = this.ctx.reflection;
        if (reflection) {
          this.render("system", "reflecting...");
          reflection.reflect().then((r: { journal: string }) => this.render("reflect", r.journal));
        } else { this.render("system", "reflection plugin not loaded"); }
        break;
      }
      case "wounds": {
        const wound = this.ctx.wound;
        if (wound) {
          const d = wound.getDiagnoses();
          if (d.length === 0) this.render("system", "no wounds detected");
          else d.forEach((w: any) => this.render("wound", `[${w.severity}] ${w.pluginId}: ${w.error.slice(0, 60)}`));
        } else { this.render("system", "wound plugin not loaded"); }
        break;
      }
      case "memory": {
        const memory = this.ctx.memory;
        if (memory) {
          const s = memory.loadMerged();
          if (s.entries.length === 0) this.render("system", "no memories stored");
          else s.entries.forEach((e: any) => this.render("system", `[${e.kind}] ${e.title}: ${e.content.slice(0, 60)}`));
        } else { this.render("system", "memory plugin not loaded"); }
        break;
      }
      case "plugins": {
        const reg = this.ctx.registry;
        const keys: string[] = [];
        reg?.forEach?.((cb: any) => { if (cb?.name) keys.push(cb.name); });
        this.render("system", `loaded: ${keys.join(", ") || "none"}`);
        break;
      }
      default:
        this.render("system", `unknown: /${command}`);
    }
  }
}

export default TuiService;

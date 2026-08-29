import { Service } from "@deepseek-ai/cordis";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface KernelConfig {
  pythonPath: string;
  kernelDir: string;
}

export class KernelService extends Service {
  static inject = ["subagents", "refine", "memory"] as const;

  private config: KernelConfig;
  private process: ChildProcess | null = null;
  private started = false;

  constructor(ctx: any, config: KernelConfig) {
    super(ctx, "kernel");
    this.config = config;
  }

  async *[Service.init]() {
    await mkdir(this.config.kernelDir, { recursive: true });
    this.ctx.logger.info("kernel: ipython kernel service ready (lazy start)");

    yield async () => {
      await this.shutdown();
    };
  }

  private async ensureKernel(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.ctx.logger.info("kernel: starting Python subprocess");
    this.process = spawn(this.config.pythonPath, ["-u", "-i"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout?.on("data", (data: Buffer) =>
      this.ctx.emit("kernel/stream", { data: data.toString() }),
    );
    this.process.stderr?.on("data", (data: Buffer) =>
      this.ctx.emit("kernel/stream", { data: data.toString(), stderr: true }),
    );
    this.process.on("exit", (code: number | null) => {
      this.ctx.logger.info(`kernel: Python exited (code ${code})`);
      this.started = false;
      this.process = null;
    });
  }

  async execute(code: string): Promise<{ stdout: string; stderr: string; result: unknown }> {
    await this.ensureKernel();
    if (!this.process?.stdin || !this.process?.stdout) throw new Error("kernel: not available");
    return new Promise((resolve, reject) => {
      const marker = `__RLM_${randomUUID().slice(0, 8)}__`;
      let stdout = "";
      let stderr = "";
      const onOut = (data: Buffer) => {
        stdout += data.toString();
        if (stdout.includes(marker)) {
          this.process?.stdout?.off("data", onOut);
          this.process?.stderr?.off("data", onErr);
          resolve({ stdout: stdout.replace(marker, ""), stderr, result: undefined });
        }
      };
      const onErr = (data: Buffer) => { stderr += data.toString(); };
      this.process.stdout?.on("data", onOut);
      this.process.stderr?.on("data", onErr);
      this.process.stdin.write(`${code}\nprint("${marker}")\n`);
      setTimeout(() => {
        this.process?.stdout?.off("data", onOut);
        this.process?.stderr?.off("data", onErr);
        reject(new Error("kernel: timeout"));
      }, 30000);
    });
  }

  async interrupt(): Promise<void> { this.process?.kill("SIGINT"); }
  async shutdown(): Promise<void> {
    if (this.process) { this.process.kill("SIGTERM"); this.process = null; this.started = false; }
  }

  async handleHostRequest(type: string, payload: unknown): Promise<unknown> {
    switch (type) {
      case "rlm.run": return this.ctx.subagents?.start(payload as any) ?? { error: "no subagent service" };
      case "refine.run": return this.ctx.refine?.plan(payload, "manual") ?? null;
      case "agent_message.send": return this.ctx.peers?.send(payload as any) ?? { error: "no peers" };
      case "rlm.list_subagents": return this.ctx.subagents?.list() ?? [];
      case "rlm.delete_subagent": return this.ctx.subagents?.delete(payload as any) ?? false;
      case "rlm.get_harness_state": return this.ctx.memory?.loadMerged() ?? { entries: [] };
      default: return { error: `unknown: ${type}` };
    }
  }
}

export default KernelService;

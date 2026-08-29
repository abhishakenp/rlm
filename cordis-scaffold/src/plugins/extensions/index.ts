import { Service } from "@deepseek-ai/cordis";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface ExtensionsConfig {
  extensionsDir: string;
}

export interface ExtensionAPI {
  on(event: string, handler: (...args: unknown[]) => void): () => void;
  registerTool(tool: { name: string; description: string; execute: (args: unknown) => Promise<unknown> }): void;
  registerCommand(command: { name: string; description: string; handler: (...args: unknown[]) => void }): void;
  sendMessage(message: unknown): void;
  sendUserMessage(content: string): void;
  appendEntry(entry: unknown): void;
  exec(cmd: string): Promise<{ stdout: string; stderr: string }>;
  setActiveTools(tools: string[]): void;
  setModel(model: string): void;
}

export class ExtensionsService extends Service {
  static inject = [] as const;

  private config: ExtensionsConfig;
  private loaded: Map<string, unknown> = new Map();

  constructor(ctx: any, config: ExtensionsConfig) {
    super(ctx, "extensions");
    this.config = config;
  }

  async *[Service.init]() {
    await this.loadExtensions();
    this.ctx.logger.info(`extensions: ${this.loaded.size} loaded from ${this.config.extensionsDir}`);

    yield async () => {};
  }

  private async loadExtensions(): Promise<void> {
    let files: string[];
    try { files = await readdir(this.config.extensionsDir); } catch { return; }
    for (const file of files) {
      if (!file.endsWith(".mjs") && !file.endsWith(".js") && !file.endsWith(".ts")) continue;
      try {
        const path = join(this.config.extensionsDir, file);
        const mod = await import(path);
        const factory = mod.default ?? mod;
        if (typeof factory !== "function") continue;
        const api = this.createAPI(file);
        await factory(api);
        this.loaded.set(file, { factory, api });
      } catch (err) {
        this.ctx.logger.warn(`extensions: failed to load ${file}: ${err}`);
      }
    }
  }

  private createAPI(name: string): ExtensionAPI {
    const ctx = this.ctx;
    return {
      on(event, handler) { return ctx.on(event, handler); },
      registerTool(tool) {
        if (ctx.tools) { ctx.tools.register(tool); ctx.logger.info(`extensions: [${name}] tool ${tool.name}`); }
      },
      registerCommand(cmd) { ctx.emit("extension/command-registered", { extension: name, ...cmd }); },
      sendMessage(msg) { ctx.emit("agent/message", { data: msg }); },
      sendUserMessage(content) { ctx.emit("user/message", { data: { content } }); },
      appendEntry(entry) { ctx.emit("extension/entry", { extension: name, entry }); },
      async exec(cmd) {
        const { exec } = await import("node:child_process");
        return new Promise((resolve, reject) => {
          exec(cmd, (err, stdout, stderr) => err ? reject(err) : resolve({ stdout, stderr }));
        });
      },
      setActiveTools(tools) { ctx.emit("extension/tools-changed", { extension: name, tools }); },
      setModel(model) { ctx.emit("extension/model-changed", { extension: name, model }); },
    };
  }

  getLoaded(): string[] { return Array.from(this.loaded.keys()); }
}

export default ExtensionsService;

import { Service } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";

export interface SubagentConfig {
  maxDepth: number;
}

interface Subagent {
  id: string;
  depth: number;
  status: "running" | "done" | "error";
  result?: unknown;
  error?: string;
}

export class SubagentService extends Service {
  static inject = [] as const;

  private config: SubagentConfig;
  private children: Map<string, Subagent> = new Map();

  constructor(ctx: any, config: SubagentConfig) {
    super(ctx, "subagents");
    this.config = config;
  }

  async *[Service.init]() {
    this.ctx.logger.info(`subagents: recursive delegation ready (maxDepth=${this.config.maxDepth})`);

    yield async () => {
      for (const [id] of this.children) {
        this.children.set(id, { ...this.children.get(id)!, status: "done" });
      }
    };
  }

  async start(request: { prompt: string; depth?: number; parent?: string }): Promise<Subagent> {
    const depth = request.depth ?? 0;
    const id = randomUUID();
    if (depth >= this.config.maxDepth) {
      return { id, depth, status: "error", error: `max depth (${this.config.maxDepth}) reached` };
    }
    const child: Subagent = { id, depth, status: "running" };
    this.children.set(id, child);
    this.ctx.emit("subagent/started", { id, depth, prompt: request.prompt });
    // In full implementation: create child AgentSession + Agent, run LLM loop
    const allowRecursion = depth < this.config.maxDepth - 1;
    child.status = "done";
    child.result = { prompt: request.prompt, allowRecursion, depth };
    this.ctx.emit("subagent/completed", { id, result: child.result });
    return child;
  }

  list(): Subagent[] { return Array.from(this.children.values()); }
  delete(id: string): boolean { return this.children.delete(id); }
  get(id: string): Subagent | undefined { return this.children.get(id); }
}

export default SubagentService;

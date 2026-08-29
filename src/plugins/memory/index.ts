import { Service } from "@deepseek-ai/cordis";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessEntry, HarnessState } from "../../types/index.js";

export interface MemoryConfig {
  dataDir: string;
}

export class MemoryService extends Service {
  static inject = [] as const;

  private dataDir: string;
  private globalState: HarnessState = { entries: [] };
  private sessionState: HarnessState = { entries: [] };
  private historyPath: string;

  constructor(ctx: any, config: MemoryConfig) {
    super(ctx, "memory");
    this.dataDir = config.dataDir;
    this.historyPath = join(this.dataDir, "refinements.jsonl");
  }

  async *[Service.init]() {
    await mkdir(this.dataDir, { recursive: true });
    await this.loadGlobal();
    this.ctx.logger.info(`memory: loaded ${this.globalState.entries.length} global entries`);

    yield async () => {
      await this.saveGlobal();
    };
  }

  private async loadGlobal() {
    try {
      const raw = await readFile(join(this.dataDir, "harness_state.json"), "utf-8");
      this.globalState = JSON.parse(raw);
    } catch {
      this.globalState = { entries: [] };
    }
  }

  async saveGlobal() {
    await writeFile(
      join(this.dataDir, "harness_state.json"),
      JSON.stringify(this.globalState, null, 2),
    );
  }

  load(scope: "global" | "session"): HarnessState {
    return scope === "global" ? this.globalState : this.sessionState;
  }

  loadMerged(): HarnessState {
    return {
      entries: [...this.globalState.entries, ...this.sessionState.entries],
    };
  }

  store(entry: HarnessEntry): void {
    const state = entry.scope === "global" ? this.globalState : this.sessionState;
    const existing = state.entries.findIndex(
      (e) => e.kind === entry.kind && e.title === entry.title,
    );
    if (existing >= 0) {
      state.entries[existing] = { ...entry, version: state.entries[existing].version + 1 };
    } else {
      state.entries.push({ ...entry, version: 1 });
    }
    if (entry.scope === "global") this.saveGlobal();
  }

  recall(query: string): HarnessEntry[] {
    const merged = this.loadMerged();
    const lower = query.toLowerCase();
    return merged.entries.filter(
      (e) =>
        e.title.toLowerCase().includes(lower) ||
        e.content.toLowerCase().includes(lower),
    );
  }

  async appendHistory(event: {
    type: string;
    timestamp: number;
    data: unknown;
  }): Promise<void> {
    await appendFile(this.historyPath, JSON.stringify(event) + "\n");
  }

  async readHistory(): Promise<string[]> {
    try {
      const raw = await readFile(this.historyPath, "utf-8");
      return raw.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}

export default MemoryService;

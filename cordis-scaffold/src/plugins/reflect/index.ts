import { Service } from "@deepseek-ai/cordis";
import type { ReflectionResult } from "../../types/index.js";

export interface ReflectConfig {
  intervalTurns: number;
}

export class ReflectService extends Service {
  static inject = ["memory", "refine"] as const;

  private config: ReflectConfig;
  private turnCount = 0;
  private reflections: string[] = [];

  constructor(ctx: any, config: ReflectConfig) {
    super(ctx, "reflection");
    this.config = config;
  }

  async *[Service.init]() {
    this.ctx.on("turn/end", () => {
      this.turnCount++;
      if (this.turnCount % this.config.intervalTurns === 0) {
        this.reflect().catch((err: Error) =>
          this.ctx.logger.warn(`reflect: ${err}`),
        );
      }
    });

    this.ctx.on("wound/healed", () => {
      this.evaluateRecentFix().catch((err: Error) =>
        this.ctx.logger.warn(`reflect: evaluation ${err}`),
      );
    });

    this.ctx.on("refine/complete", () => {
      this.evaluateRecentFix().catch((err: Error) =>
        this.ctx.logger.warn(`reflect: evaluation ${err}`),
      );
    });

    this.ctx.logger.info(
      `reflect: self-learning engine active (every ${this.config.intervalTurns} turns)`,
    );

    yield async () => {};
  }

  async reflect(): Promise<ReflectionResult> {
    const memory = this.ctx.memory;
    if (!memory) return this.emptyResult();

    const history = await memory.readHistory();
    const recent = history.slice(-20);
    const journal = `Reflection at turn ${this.turnCount}: processed ${recent.length} recent events`;

    const result: ReflectionResult = {
      journal,
      proposals: [],
      learnedRules: [],
    };

    memory.store({
      kind: "memory",
      title: `reflection-${this.turnCount}`,
      content: journal,
      scope: "session",
      version: 1,
    });

    this.reflections.push(journal);
    this.ctx.emit("reflect/complete", result);
    this.ctx.emit("reflect/journal", journal);
    return result;
  }

  async evaluateRecentFix(): Promise<ReflectionResult | null> {
    const memory = this.ctx.memory;
    if (!memory) return null;

    const history = await memory.readHistory();
    const parsed = history.map((h) => JSON.parse(h));
    const recentSwaps = parsed.filter((h) => h.type === "refine/swap").slice(-1);

    if (recentSwaps.length === 0) return null;

    const recentWounds = parsed.filter((h) => h.type === "wound/detected").slice(-5);
    const lastSwap = recentSwaps[0];
    const woundsAfterFix = recentWounds.filter(
      (w) => w.data.timestamp > lastSwap.data.timestamp && w.data.pluginId === lastSwap.data.plugin,
    );

    const worked = woundsAfterFix.length === 0;
    const notes = worked
      ? `Fix for ${lastSwap.data.plugin} appears successful — no re-occurrence`
      : `Fix for ${lastSwap.data.plugin} did not prevent re-occurrence (${woundsAfterFix.length} new wounds)`;

    const result: ReflectionResult = {
      journal: notes,
      proposals: [],
      learnedRules: [
        worked
          ? `SUCCESS: ${lastSwap.data.plugin} fix pattern works`
          : `FAILURE: ${lastSwap.data.plugin} fix pattern does not work — try different approach`,
      ],
      fixEvaluation: { fixId: lastSwap.data.plugin, worked, notes },
    };

    memory.store({
      kind: "memory",
      title: `fix-evaluation-${lastSwap.data.plugin}`,
      content: notes,
      scope: "global",
      version: 1,
    });

    this.ctx.emit("reflect/complete", result);
    return result;
  }

  private emptyResult(): ReflectionResult {
    return { journal: "", proposals: [], learnedRules: [] };
  }

  getReflections(): string[] {
    return this.reflections;
  }
}

export default ReflectService;

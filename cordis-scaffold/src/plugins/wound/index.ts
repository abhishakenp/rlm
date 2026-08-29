import { Service } from "@deepseek-ai/cordis";
import type { WoundDiagnosis } from "../../types/index.js";

export interface WoundConfig {
  maxRefinePerPlugin: number;
  cooldownTurns: number;
}

interface FailureRecord {
  pluginId: string;
  error: string;
  timestamp: number;
  count: number;
}

export class WoundService extends Service {
  static inject = ["refine", "memory"] as const;

  private config: WoundConfig;
  private failures: Map<string, FailureRecord> = new Map();
  private cooldowns: Map<string, number> = new Map();
  private turnCount = 0;

  constructor(ctx: any, config: WoundConfig) {
    super(ctx, "wound");
    this.config = config;
  }

  async *[Service.init]() {
    this.ctx.on("tool/result", (event: { data: { error?: string; tool?: string } }) => {
      if (event.data?.error) {
        this.detect("tool", event.data.tool ?? "unknown", event.data.error);
      }
    });

    this.ctx.on("turn/end", () => {
      this.turnCount++;
      this.checkCooldowns();
    });

    this.ctx.logger.info("wound: self-healing detector active");

    yield async () => {};
  }

  private detect(source: string, pluginId: string, error: string): void {
    const key = `${pluginId}:${error.slice(0, 50)}`;
    const existing = this.failures.get(key);

    if (existing) {
      existing.count++;
      existing.timestamp = Date.now();
    } else {
      this.failures.set(key, { pluginId, error, timestamp: Date.now(), count: 1 });
    }

    const record = this.failures.get(key)!;
    if (record.count >= 2) {
      this.classifyAndTrigger(source, pluginId, error, record.count);
    }
  }

  private classifyAndTrigger(
    source: string,
    pluginId: string,
    error: string,
    count: number,
  ): void {
    const cooldownEnd = this.cooldowns.get(pluginId);
    if (cooldownEnd && this.turnCount < cooldownEnd) return;

    const severity = count >= 5 ? "high" : count >= 3 ? "medium" : "low";
    const diagnosis: WoundDiagnosis = {
      pluginId,
      error,
      pattern: `repeated ${source} failure (${count}x)`,
      severity,
      timestamp: Date.now(),
    };

    this.ctx.emit("wound/detected", diagnosis);
    this.ctx.logger.warn(
      `wound: detected ${severity} failure in ${pluginId}: ${error.slice(0, 80)}`,
    );

    const refine = this.ctx.refine;
    if (refine) {
      refine
        .plan([], "wound", pluginId)
        .then((proposal: unknown) => {
          if (proposal) {
            this.ctx.emit("wound/healed", { diagnosis, proposal });
          } else {
            this.ctx.emit("wound/unhealed", { diagnosis, reason: "no proposal" });
          }
        })
        .catch((err: Error) => {
          this.ctx.emit("wound/unhealed", { diagnosis, reason: String(err) });
        });

      this.cooldowns.set(pluginId, this.turnCount + this.config.cooldownTurns);
    }
  }

  private checkCooldowns(): void {
    for (const [plugin, end] of this.cooldowns) {
      if (this.turnCount >= end) this.cooldowns.delete(plugin);
    }
  }

  getDiagnoses(): WoundDiagnosis[] {
    return Array.from(this.failures.values()).map((r) => ({
      pluginId: r.pluginId,
      error: r.error,
      pattern: `failure (${r.count}x)`,
      severity: r.count >= 5 ? "high" : r.count >= 3 ? "medium" : "low",
      timestamp: r.timestamp,
    }));
  }
}

export default WoundService;

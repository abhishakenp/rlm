import { Service } from "@deepseek-ai/cordis";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  RefinementProposal,
  RefinementEdit,
  HarnessEntry,
} from "../../types/index.js";

export class RefineService extends Service {
  static inject = ["memory"] as const;

  private staging: Map<string, string> = new Map();
  private rateLimit: Map<string, number> = new Map();
  private maxAttempts = 5;

  constructor(ctx: any) {
    super(ctx, "refine");
  }

  async *[Service.init]() {
    this.ctx.logger.info("refine: self-evolution engine ready");

    yield async () => {};
  }

  async plan(
    trajectory: unknown,
    trigger: "manual" | "auto" | "wound" | "reflect",
    targetPlugin?: string,
  ): Promise<RefinementProposal | null> {
    const memory = this.ctx.memory;
    if (!memory) return null;

    if (targetPlugin) {
      const count = this.rateLimit.get(targetPlugin) ?? 0;
      if (count >= this.maxAttempts) {
        this.ctx.logger.warn(
          `refine: rate limit hit for ${targetPlugin} (${count} attempts)`,
        );
        return null;
      }
      this.rateLimit.set(targetPlugin, count + 1);
    }

    const proposal: RefinementProposal = {
      id: randomUUID(),
      kind: "harness",
      action: "create",
      target: targetPlugin ?? "global",
      edits: [],
      reason: `refine triggered by ${trigger}`,
      trigger,
    };

    this.ctx.emit("refine/plan", proposal);
    return proposal;
  }

  async applyHarnessEdit(
    proposal: RefinementProposal,
    entry: HarnessEntry,
  ): Promise<boolean> {
    const memory = this.ctx.memory;
    if (!memory) return false;

    try {
      memory.store(entry);
      await memory.appendHistory({
        type: "refine/apply",
        timestamp: Date.now(),
        data: { proposalId: proposal.id, entry },
      });
      this.ctx.emit("refine/apply", { proposal, entry });
      this.ctx.emit("refine/complete", { proposal, success: true });
      return true;
    } catch (err) {
      this.ctx.emit("refine/failed", { proposal, error: String(err) });
      return false;
    }
  }

  async applyPluginSourceEdit(
    proposal: RefinementProposal,
    edit: RefinementEdit,
  ): Promise<boolean> {
    const targetPlugin = proposal.target;

    try {
      const stagingPath = edit.path + ".staging";
      await mkdir(dirname(stagingPath), { recursive: true });
      await writeFile(stagingPath, edit.content);
      this.staging.set(proposal.id, stagingPath);

      const testResult = await this.testPlugin(stagingPath);
      if (!testResult) {
        this.ctx.logger.warn(`refine: sandbox test failed for ${targetPlugin}`);
        await this.discardStaging(proposal.id);
        this.ctx.emit("refine/failed", { proposal, error: "sandbox test failed" });
        return false;
      }

      let backup: string | null = null;
      try {
        backup = await readFile(edit.path, "utf-8");
      } catch {}

      await writeFile(edit.path, edit.content);
      await this.discardStaging(proposal.id);

      const memory = this.ctx.memory;
      if (memory) {
        await memory.appendHistory({
          type: "refine/swap",
          timestamp: Date.now(),
          data: {
            proposalId: proposal.id,
            plugin: targetPlugin,
            path: edit.path,
            backup: backup ? "saved" : "new-file",
          },
        });
      }

      this.ctx.emit("refine/swap", { proposal, plugin: targetPlugin, path: edit.path });
      this.ctx.emit("refine/complete", { proposal, success: true });
      return true;
    } catch (err) {
      await this.discardStaging(proposal.id);
      this.ctx.emit("refine/failed", { proposal, error: String(err) });
      return false;
    }
  }

  private async testPlugin(path: string): Promise<boolean> {
    try {
      const content = await readFile(path, "utf-8");
      if (!content.trim()) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async discardStaging(proposalId: string): Promise<void> {
    const stagingPath = this.staging.get(proposalId);
    if (stagingPath) {
      try {
        await writeFile(stagingPath, "");
      } catch {}
      this.staging.delete(proposalId);
    }
  }

  async rollback(proposalId: string, backup: string, path: string): Promise<void> {
    await writeFile(path, backup);
    this.ctx.emit("refine/swap", {
      proposal: { id: proposalId } as RefinementProposal,
      plugin: "rollback",
      path,
    });
  }
}

export default RefineService;

/**
 * @rlm/config — settings, model registry, and auth storage as a Cordis Service.
 *
 * Foundation plugin — no dependencies. Other plugins depend on this for:
 * - settingsManager (SettingsManager)
 * - modelRegistry (ModelRegistry)
 * - authStorage (AuthStorage)
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.js";
import { ModelRegistry } from "../../coding-agent/src/core/model-registry.js";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.js";
import { getAgentDir } from "../../coding-agent/src/config.js";

export interface RlmConfigConfig {
  agentDir?: string;
  cwd?: string;
}

export class RlmConfigService extends Service {
  static inject = [] as const;
  static provide = "rlmConfig" as const;

  declare config: RlmConfigConfig;

  settingsManager!: SettingsManager;
  modelRegistry!: ModelRegistry;
  authStorage!: AuthStorage;

  constructor(ctx: any, config: RlmConfigConfig = {}) {
    super(ctx, undefined as any);
    this.config = config;
  }

  async [Service.init]() {
    const agentDir = this.config.agentDir ?? getAgentDir();
    const cwd = this.config.cwd ?? process.cwd();

    this.authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    this.settingsManager = SettingsManager.create(cwd, agentDir);
    this.modelRegistry = ModelRegistry.create(this.authStorage);

    this.ctx.logger?.info(`rlm-config: ready (agentDir=${agentDir})`);
  }

  getSettingsManager(): SettingsManager {
    return this.settingsManager;
  }

  getModelRegistry(): ModelRegistry {
    return this.modelRegistry;
  }

  getAuthStorage(): AuthStorage {
    return this.authStorage;
  }
}

export default RlmConfigService;
export const name = "rlm-config";
export const inject = [] as const;
export { RlmConfigService as RlmConfig };

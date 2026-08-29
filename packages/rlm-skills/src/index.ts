/**
 * @rlm/skills — skill system service.
 *
 * Wraps prime-agent's skill system as a Cordis Service.
 * Discovers, loads, and manages skills from ~/.prime/agent/skills.
 * Skills are reusable prompt+tool bundles the agent can invoke.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

export interface RlmSkillsConfig {
	/** Skills directory (default: ~/.prime/agent/skills). */
	skillsDir?: string;
	/** Whether to disable skill discovery. */
	disabled?: boolean;
}

export class RlmSkillsService extends Service {
	static inject = ["rlmAgent"];

	declare config: RlmSkillsConfig;
	private skills: Map<string, any> = new Map();

	constructor(ctx: any, config: RlmSkillsConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmSkills";
	}

	async [Service.init]() {
		if (this.config.disabled) {
			this.ctx.logger?.info("rlm-skills: disabled");
			return;
		}
		const dir = this.config.skillsDir ?? join(homedir(), ".prime", "agent", "skills");
		if (!existsSync(dir)) {
			this.ctx.logger?.info("rlm-skills: no skills dir, skipping");
			return;
		}
		// Discover skills.
		try {
			for (const entry of readdirSync(dir)) {
				const skillPath = join(dir, entry);
				if (statSync(skillPath).isDirectory()) {
					this.skills.set(entry, { path: skillPath, name: entry });
				}
			}
		} catch {
			// Empty skills dir — fine.
		}
		this.ctx.logger?.info(`rlm-skills: discovered ${this.skills.size} skills`);
	}

	/** Get a skill by name. */
	get(name: string) {
		return this.skills.get(name);
	}

	/** List all skill names. */
	list() {
		return [...this.skills.keys()];
	}

	async [Symbol.dispose]() {
		this.skills.clear();
	}
}

export default RlmSkillsService;
export const name = "rlm-skills";
export const inject = ["rlmAgent"] as const;
export { RlmSkillsService as RlmSkills };

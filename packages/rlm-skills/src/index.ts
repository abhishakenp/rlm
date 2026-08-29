/**
 * @rlm/skills — skill system.
 *
 * Clean Cordis Service. No prime-agent code.
 * Discovers skills from ~/.rlm/skills. Each skill is a directory with
 * a SKILL.md file containing the skill prompt + optional tool definitions.
 *
 * Reference: DSH's dsh-skill plugin manages skill discovery and registration.
 * rlm-skills is simpler — skills are markdown files with frontmatter.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";

export interface RlmSkillsConfig {
	skillsDir?: string;
	disabled?: boolean;
}

export interface Skill {
	name: string;
	path: string;
	description: string;
	prompt: string;
}

export class RlmSkillsService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmSkills" as const;

	declare config: RlmSkillsConfig;
	private skills: Map<string, Skill> = new Map();

	constructor(ctx: any, config: RlmSkillsConfig = {}) {
		super(ctx, "rlmSkills");
		this.config = config;
	}

	async [Service.init]() {
		if (this.config.disabled) {
			this.ctx.logger?.info("rlm-skills: disabled");
			return;
		}
		const dir = this.config.skillsDir ?? join(homedir(), ".rlm", "skills");
		if (!existsSync(dir)) {
			this.ctx.logger?.info("rlm-skills: no skills dir");
			return;
		}
		this.discover(dir);
		this.ctx.logger?.info(`rlm-skills: discovered ${this.skills.size} skills`);
	}

	private discover(dir: string): void {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (!statSync(path).isDirectory()) continue;
			const skillFile = join(path, "SKILL.md");
			if (!existsSync(skillFile)) continue;
			try {
				const content = readFileSync(skillFile, "utf-8");
				const { description, prompt } = this.parseSkillFile(content);
				this.skills.set(entry, { name: entry, path, description, prompt });
			} catch {
				// Skip malformed skill.
			}
		}
	}

	private parseSkillFile(content: string): { description: string; prompt: string } {
		// Simple frontmatter parsing — look for --- delimiters.
		const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return { description: "", prompt: content };
		const frontmatter = match[1];
		const body = match[2];
		const descMatch = frontmatter.match(/description:\s*(.+)/);
		return {
			description: descMatch?.[1]?.trim() ?? "",
			prompt: body.trim(),
		};
	}

	get(name: string): Skill | undefined {
		return this.skills.get(name);
	}

	list(): string[] {
		return [...this.skills.keys()];
	}

	/** Get all skill prompts as a combined string for the system prompt. */
	getCombinedPrompt(): string {
		const skills = [...this.skills.values()];
		if (skills.length === 0) return "";
		return "\n\n## Available Skills\n" + skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
	}

	async [Symbol.dispose]() {
		this.skills.clear();
	}
}

export default RlmSkillsService;
export const name = "rlm-skills";
export const inject = ["rlmAgent"] as const;
export { RlmSkillsService as RlmSkills };

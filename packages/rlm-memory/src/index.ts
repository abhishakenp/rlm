/**
 * @rlm/memory — persistent memory service.
 *
 * Clean Cordis Service. No prime-agent code.
 * Stores key-value memories on disk as JSON files.
 * Survives process exit; loaded on next boot.
 *
 * Reference: DSH uses dsh-storage + dsh-session-persistence for state.
 * rlm-memory is simpler — flat JSON files in ~/.rlm/memory/.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";

export interface RlmMemoryConfig {
	memoryDir?: string;
}

export class RlmMemoryService extends Service {
	static inject = [] as const;
	static provide = "rlmMemory" as const;

	declare config: RlmMemoryConfig;
	private memoryDir: string;
	private cache: Map<string, any> = new Map();

	constructor(ctx: any, config: RlmMemoryConfig = {}) {
		super(ctx, "rlmMemory");
		this.config = config;
		this.memoryDir = config.memoryDir ?? join(homedir(), ".rlm", "memory");
	}

	async [Service.init]() {
		if (!existsSync(this.memoryDir)) {
			mkdirSync(this.memoryDir, { recursive: true });
		}
		try {
			for (const file of readdirSync(this.memoryDir)) {
				if (file.endsWith(".json")) {
					const key = file.replace(/\.json$/, "");
					this.cache.set(key, JSON.parse(readFileSync(join(this.memoryDir, file), "utf-8")));
				}
			}
		} catch {
			// Empty memory dir.
		}
		this.ctx.logger?.info(`rlm-memory: loaded ${this.cache.size} memories`);
	}

	get(key: string): any {
		return this.cache.get(key);
	}

	set(key: string, value: any): void {
		this.cache.set(key, value);
		writeFileSync(join(this.memoryDir, `${key}.json`), JSON.stringify(value, null, 2), "utf-8");
	}

	delete(key: string): void {
		this.cache.delete(key);
		try { unlinkSync(join(this.memoryDir, `${key}.json`)); } catch { /* already gone */ }
	}

	keys(): string[] {
		return [...this.cache.keys()];
	}

	async [Symbol.dispose]() {
		// All writes are immediate.
	}
}

export default RlmMemoryService;
export const name = "rlm-memory";
export const inject = [] as const;
export { RlmMemoryService as RlmMemory };

// HMR touch 1788020789499

// HMR touch 1788020811020

// HMR touch 1788020842209

// HMR touch 1788020863995

// chokidar touch 1788020887981

// HMR touch 1788020909238

// HMR touch 1788020961923

// touch 1788021058677
// HMR touch Sat Aug 29 22:17:46 +0545 2026
// touch 1788021186836
// HMR touch Sat Aug 29 22:18:32 +0545 2026

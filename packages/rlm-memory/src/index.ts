/**
 * @rlm/memory — persistent memory service.
 *
 * Wraps prime-agent's memory/harness state as a Cordis Service.
 * Stores session memory, learning data, and harness state on disk.
 * Survives process exit; loaded on next boot.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";

export interface RlmMemoryConfig {
	/** Memory directory (default: ~/.prime/agent/memory). */
	memoryDir?: string;
}

export class RlmMemoryService extends Service {
	static inject = [];

	declare config: RlmMemoryConfig;
	private memoryDir: string;
	private cache: Map<string, any> = new Map();

	constructor(ctx: any, config: RlmMemoryConfig = {}) {
		super(ctx, config);
		this.config = config;
		this.memoryDir = config.memoryDir ?? join(homedir(), ".prime", "agent", "memory");
	}

	get [Symbol.name]() {
		return "rlmMemory";
	}

	async [Service.init]() {
		if (!existsSync(this.memoryDir)) {
			mkdirSync(this.memoryDir, { recursive: true });
		}
		// Load all memories into cache.
		try {
			for (const file of readdirSync(this.memoryDir)) {
				if (file.endsWith(".json")) {
					const key = file.replace(/\.json$/, "");
					const data = JSON.parse(readFileSync(join(this.memoryDir, file), "utf-8"));
					this.cache.set(key, data);
				}
			}
		} catch {
			// Empty memory dir — fine.
		}
		this.ctx.logger?.info(`rlm-memory: loaded ${this.cache.size} memories`);
	}

	/** Get a memory by key. */
	get(key: string) {
		return this.cache.get(key);
	}

	/** Set a memory by key (persists to disk). */
	set(key: string, value: any) {
		this.cache.set(key, value);
		writeFileSync(join(this.memoryDir, `${key}.json`), JSON.stringify(value, null, 2), "utf-8");
	}

	/** Delete a memory by key. */
	delete(key: string) {
		this.cache.delete(key);
		const path = join(this.memoryDir, `${key}.json`);
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(path);
		} catch {
			// Already gone.
		}
	}

	/** List all memory keys. */
	keys() {
		return [...this.cache.keys()];
	}

	async [Symbol.dispose]() {
		// All writes are immediate — nothing to flush.
	}
}

export default RlmMemoryService;
export const name = "rlm-memory";
export const inject = [] as const;
export { RlmMemoryService as RlmMemory };

// HMR test touch 1788018497057

/**
 * @rlm/kernel — IPython/ZMQ kernel service.
 *
 * Wraps prime-agent's KernelManager as a Cordis Service.
 * Manages the IPython kernel process, ZMQ sockets, and Jupyter comm protocol.
 * On disposal (HMR), shuts down the kernel + closes sockets cleanly.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RlmKernelConfig {
	/** Python path (default: python3). */
	pythonPath?: string;
	/** Kernel venv directory (default: ~/.prime/agent/kernel-venv). */
	kernelDir?: string;
}

export class RlmKernelService extends Service {
	static inject = [];

	declare config: RlmKernelConfig;
	private manager: any = null;

	constructor(ctx: any, config: RlmKernelConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmKernel";
	}

	async [Service.init]() {
		this.ctx.logger?.info("rlm-kernel: KernelManager service ready (lazy init)");
		// KernelManager is created on first use, not at boot.
	}

	/** Start the IPython kernel. */
	async start(opts: any = {}) {
		if (this.manager) return this.manager;
		const { KernelManager } = await import("@earendil-works/pi-coding-agent");
		const kernelDir = this.config.kernelDir ?? join(homedir(), ".prime", "agent", "kernel-venv");
		this.manager = new KernelManager({
			pythonPath: this.config.pythonPath ?? "python3",
			kernelDir,
			...opts,
		});
		await this.manager.start();
		return this.manager;
	}

	/** Get the running kernel manager (if any). */
	get manager_() {
		return this.manager;
	}

	/** Execute code in the kernel. */
	async execute(code: string) {
		if (!this.manager) await this.start();
		return this.manager?.execute(code);
	}

	/** Interrupt the kernel. */
	async interrupt() {
		return this.manager?.interrupt();
	}

	/** Shutdown the kernel. */
	async shutdown() {
		if (this.manager) {
			await this.manager.shutdown();
			this.manager = null;
		}
	}

	async [Symbol.dispose]() {
		await this.shutdown();
	}
}

export default RlmKernelService;
export const name = "rlm-kernel";
export const inject = [] as const;
export { RlmKernelService as RlmKernel };

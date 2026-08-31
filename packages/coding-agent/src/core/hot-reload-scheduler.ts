/**
 * Decides *when* a live session re-derives its resources after a file change.
 *
 * Reloading is cheap to ask for and expensive to get wrong. Two rules govern
 * it, and both exist to protect the thing the harness promises: a running turn
 * is never interrupted.
 *
 *   Rapid saves collapse. An editor writing four files in half a second must
 *   cost one reload, not four.
 *
 *   A reload that arrives mid-turn waits. The turn finishes against the
 *   resources it started with — swapping skills or tools underneath a model
 *   that is halfway through using them produces failures no one can read — and
 *   the reload runs the moment the turn ends.
 *
 * The logic lives here rather than inline in AgentSession because it is the
 * only part of hot reloading with real edge cases, and it should be testable
 * without booting an agent.
 */

export interface HotReloadSchedulerOptions {
	/** Milliseconds to batch rapid changes into one reload. Default 300. */
	debounceMs?: number;
	/** Performs the actual reload. Rejections are reported, never thrown. */
	reload: () => Promise<void>;
	/** True while a turn is in flight. */
	isBusy: () => boolean;
	/** Diagnostics. */
	onError?: (error: unknown) => void;
	onReload?: (reason: string) => void;
	/** Injectable for tests. */
	setTimeoutFn?: (fn: () => void, ms: number) => any;
	clearTimeoutFn?: (handle: any) => void;
}

export class HotReloadScheduler {
	private timer: any = null;
	private pending = false;
	private running = false;
	private reasons = new Set<string>();
	private readonly debounceMs: number;
	private readonly setTimeoutFn: (fn: () => void, ms: number) => any;
	private readonly clearTimeoutFn: (handle: any) => void;

	constructor(private readonly options: HotReloadSchedulerOptions) {
		this.debounceMs = options.debounceMs ?? 300;
		this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
	}

	/** A change happened. Coalesce it into the next reload. */
	schedule(reason = "resources changed"): void {
		this.reasons.add(reason);
		if (this.timer) this.clearTimeoutFn(this.timer);
		this.timer = this.setTimeoutFn(() => {
			this.timer = null;
			void this.fire();
		}, this.debounceMs);
	}

	/** A turn ended. Apply anything that arrived while it was running. */
	async onIdle(): Promise<void> {
		if (!this.pending) return;
		this.pending = false;
		await this.fire();
	}

	/** True when a reload is waiting for the current turn to finish. */
	get isPending(): boolean {
		return this.pending;
	}

	private async fire(): Promise<void> {
		if (this.options.isBusy()) {
			// Hold it. onIdle() picks this up when the turn ends.
			this.pending = true;
			return;
		}
		if (this.running) {
			// A reload is already in flight; fold this one into the next chance.
			this.pending = true;
			return;
		}
		const reason = [...this.reasons].join(", ") || "resources changed";
		this.reasons.clear();
		this.running = true;
		try {
			await this.options.reload();
			this.options.onReload?.(reason);
		} catch (error) {
			this.options.onError?.(error);
		} finally {
			this.running = false;
		}
		// A change that landed during the reload deserves another pass.
		if (this.pending && !this.options.isBusy()) {
			this.pending = false;
			await this.fire();
		}
	}

	dispose(): void {
		if (this.timer) this.clearTimeoutFn(this.timer);
		this.timer = null;
		this.pending = false;
		this.reasons.clear();
	}
}

/**
 * Wire a scheduler to the reload events the HMR plugin emits.
 *
 * Kept next to the scheduler, and separate from AgentSession, so the whole
 * chain — file change, plugin, event, deferral, reload — can be exercised
 * without booting an agent.
 */
export function installResourceHotReload(
	ctx: any,
	options: Omit<HotReloadSchedulerOptions, "setTimeoutFn" | "clearTimeoutFn"> & { debounceMs?: number },
): HotReloadScheduler | undefined {
	if (!ctx?.on) return undefined;
	const scheduler = new HotReloadScheduler(options);
	try {
		ctx.on("rlm/resources-changed", (data: any) =>
			scheduler.schedule(data?.reason ?? "resources changed"),
		);
		ctx.on("rlm/hmr-reload", () => scheduler.schedule("plugin reloaded"));
	} catch {
		return undefined;
	}
	return scheduler;
}

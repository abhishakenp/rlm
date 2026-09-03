/**
 * acpx repair harness — a plugin/extension point for self-healing agent failures.
 *
 * This module provides:
 * - An agent subscription stream listener
 * - Error-only monitoring with configurable thresholds
 * - Automatic self-repair triggering
 * - One-time Iris configuration at setup, runs passively thereafter
 */

export type AgentEvent = {
	type: "message" | "error" | "complete" | "unknown";
	data: unknown;
	timestamp: number;
};

export type AgentSubscription = {
	stream: AsyncGenerator<AgentEvent, void, unknown>;
	id: string;
};

export type RepairStrategy = {
	type: "restart" | "retry" | "escalate" | "rollback";
	maxAttempts?: number;
	backoffMs?: number;
};

export type RepairTrigger = {
	error: string | RegExp | ((error: unknown) => boolean);
	strategy: RepairStrategy;
};

export type RepairHarnessConfig = {
	triggers: RepairTrigger[];
	onRepairStart?: (agentId: string, error: unknown, strategy: RepairStrategy) => void;
	onRepairComplete?: (agentId: string, success: boolean) => void;
	globalBackoffMs?: number;
	maxTotalRepairs?: number;
};

export type RepairHarness = {
	configure(config: RepairHarnessConfig): void;
	subscribe(agent: AgentSubscription): () => void;
	stop(): void;
	status(): HarnessStatus;
};

export type HarnessStatus = {
	active: boolean;
	subscribedAgents: number;
	totalRepairs: number;
	configured: boolean;
};

/**
 * Creates a repair harness instance.
 * The harness accepts agent subscription streams, monitors only error events,
 * and triggers self-repair when configured error patterns are matched.
 */
export function createRepairHarness(): RepairHarness {
	let config: RepairHarnessConfig | null = null;
	let stopRequested = false;
	const activeSubscriptions = new Map<string, boolean>();
	let repairCount = 0;

	async function processStream(agent: AgentSubscription) {
		if (stopRequested || !config) return;

		activeSubscriptions.set(agent.id, true);

		try {
			for await (const event of agent.stream) {
				if (stopRequested || !activeSubscriptions.get(agent.id)) break;

				if (event.type === "error") {
					const error = event.data;
					const matchingTrigger = config.triggers.find((trigger) => {
						if (typeof trigger.error === "function") {
							return trigger.error(error);
						}
						if (trigger.error instanceof RegExp) {
							const msg = String(error);
							return trigger.error.test(msg);
						}
						const errMsg = String(error);
						return errMsg.includes(String(trigger.error));
					});

					if (matchingTrigger) {
						repairCount++;
						const strategy = matchingTrigger.strategy;

						config.onRepairStart?.(agent.id, error, strategy);

						try {
							await executeRepair(strategy, agent);
							config.onRepairComplete?.(agent.id, true);
						} catch {
							config.onRepairComplete?.(agent.id, false);
						}
					}
				}
			}
		} finally {
			activeSubscriptions.delete(agent.id);
		}
	}

	async function executeRepair(
		strategy: RepairStrategy,
		agent: AgentSubscription
	): Promise<void> {
		const attempts = strategy.maxAttempts ?? 1;
		let lastError: unknown;

		for (let i = 0; i < attempts; i++) {
			if (i > 0 && strategy.backoffMs) {
				await new Promise((resolve) => setTimeout(resolve, strategy.backoffMs * i));
			}

			try {
				switch (strategy.type) {
					case "restart":
						// Signal agent restart - caller implements actual restart logic
						await triggerRestart(agent);
						break;
					case "retry":
						// Re-subscribe and continue - caller implements retry logic
						await triggerRetry(agent);
						break;
					case "escalate":
						// Notify external handler - caller implements escalation
						await triggerEscalate(agent, lastError);
						break;
					case "rollback":
						// Trigger state rollback - caller implements rollback
						await triggerRollback(agent);
						break;
				}
				return;
			} catch (err) {
				lastError = err;
			}
		}

		if (lastError) throw lastError;
	}

	async function triggerRestart(agent: AgentSubscription): Promise<void> {
		// Placeholder for restart implementation
		// Caller connects this to actual agent restart mechanism
	}

	async function triggerRetry(agent: AgentSubscription): Promise<void> {
		// Placeholder for retry implementation
		// Caller connects this to actual retry mechanism
	}

	async function triggerEscalate(
		agent: AgentSubscription,
		error: unknown
	): Promise<void> {
		// Placeholder for escalation
		// Caller connects this to actual escalation mechanism
	}

	async function triggerRollback(agent: AgentSubscription): Promise<void> {
		// Placeholder for rollback
		// Caller connects this to actual rollback mechanism
	}

	return {
		configure(cfg: RepairHarnessConfig) {
			config = cfg;
		},

		subscribe(agent: AgentSubscription) {
			processStream(agent).catch(console.error);
			return () => {
				activeSubscriptions.set(agent.id, false);
			};
		},

		stop() {
			stopRequested = true;
			for (const id of activeSubscriptions.keys()) {
				activeSubscriptions.set(id, false);
			}
		},

		status(): HarnessStatus {
			return {
				active: !stopRequested,
				subscribedAgents: activeSubscriptions.size,
				totalRepairs: repairCount,
				configured: config !== null,
			};
		},
	};
}

/**
 * Fallback repair handler for graceful degradation.
 * Used when the harness encounters unrecoverable states.
 */
export function fallbackRepair(error: unknown, context?: Record<string, unknown>): void {
	console.error("[acpx] fallback repair triggered:", error, context);
}

/**
 * Error pattern matchers for common agent failure modes.
 */
export const commonErrorPatterns = {
	timeout: /timeout|timed? out/i,
	connection: /connect(ion)? (?:failed|reset|refused)/i,
	auth: /auth(enticat(?:ion|ed))?|unauthorized|forbidden/i,
	rateLimit: /rate.?limit|too.?many.?requests|429/i,
	memory: /out.?of.?memory|heap|memory.?exhaust/i,
	stackOverflow: /stack.?overflow|maximum call stack/i,
};

export type RepairHarnessFactory = {
	createRepairHarness(): RepairHarness;
	fallbackRepair(error: unknown, context?: Record<string, unknown>): void;
	commonErrorPatterns: typeof commonErrorPatterns;
};


/**
 * Alias for createRepairHarness() - lowercase naming convention.
 * Provides the same functionality with a different export name.
 */
export const repairHarness = createRepairHarness;

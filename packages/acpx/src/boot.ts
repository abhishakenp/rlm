/**
 * acpx boot sequence — starts all capabilities including the repair harness.
 *
 * The repair harness is initialized here so that it is available
 * for self-healing from the moment acpx is loaded.
 */
import { repairHarness, fallbackRepair } from "./repair-harness.js";

/**
 * Initialize the repair harness with default error recovery patterns.
 * The harness listens for agent error events and triggers self-repair
 * automatically based on the configured triggers.
 */
function boot(): void {
	const harness = repairHarness();
	harness.configure({
		triggers: [],
		onRepairStart: (agentId, _error, strategy) => {
			console.log(`[acpx:boot] repair starting for ${agentId}: ${strategy.type}`);
		},
		onRepairComplete: (agentId, success) => {
			console.log(`[acpx:boot] repair ${success ? "succeeded" : "failed"} for ${agentId}`);
		},
	});
}

boot();

export { repairHarness, fallbackRepair };

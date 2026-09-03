/**
 * acpx load sequence — initializes all core capabilities including the repair harness.
 *
 * This module is called once at package initialization time and starts
 * the repair harness automatically, so any errors encountered by the
 * agent can be self-healed without additional setup.
 */
import { repairHarness, fallbackRepair } from "./repair-harness.js";

/**
 * Default repair triggers for common agent failure patterns.
 * These are applied automatically when the harness is loaded.
 */
const DEFAULT_TRIGGERS = [
	{
		error: /kernel has been shut down|kernel died|kernel revival/i,
		strategy: { type: "restart" as const, maxAttempts: 2, backoffMs: 1000 },
	},
	{
		error: /rate.?limit|too.?many.?requests|429/i,
		strategy: { type: "retry" as const, maxAttempts: 3, backoffMs: 2000 },
	},
	{
		error: /connect(?:ion)? (?:failed|reset|refused)/i,
		strategy: { type: "retry" as const, maxAttempts: 2, backoffMs: 1500 },
	},
];

const harness = repairHarness();

harness.configure({
	triggers: DEFAULT_TRIGGERS,
	onRepairStart: (agentId, error, strategy) => {
		console.log(`[acpx] repair starting for ${agentId}: ${strategy.type}`, error);
	},
	onRepairComplete: (agentId, success) => {
		console.log(`[acpx] repair ${success ? "succeeded" : "failed"} for ${agentId}`);
	},
});

export { harness, fallbackRepair };
export default harness;

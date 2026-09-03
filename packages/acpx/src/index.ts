/**
 * acpx — agent context extensions
 *
 * Public API surface for Iris integration.
 */

import "./load.js";

export {
	createRepairHarness,
	repairHarness,
	fallbackRepair,
	commonErrorPatterns,
} from "./repair-harness.js";

export type {
	AgentEvent,
	AgentSubscription,
	RepairStrategy,
	RepairTrigger,
	RepairHarnessConfig,
	RepairHarness,
	HarnessStatus,
	RepairHarnessFactory,
} from "./repair-harness.js";

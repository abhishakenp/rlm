export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createCodeTool,
	createCodeToolDefinition,
	CodeKernelProvisioner,
	type CodeToolDetails,
	type CodeToolInput,
	type CodeToolOptions,
} from "./code.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { createCodeToolDefinition, type CodeToolOptions } from "./code.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "code";

export interface ToolsOptions {
	code?: CodeToolOptions;
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		code: createCodeToolDefinition(cwd, options?.code),
	};
}

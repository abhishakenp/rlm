/**
 * Kernel types — minimal stubs.
 * The old Python kernel has been fully replaced by the JS code tool
 * (packages/coding-agent/src/core/tools/code.ts). These type definitions
 * remain for compatibility with agent-session.ts which references them.
 */

export interface HostRequestHandler {
	(...args: any[]): Promise<any>;
}

export interface HostRequestHandlers {
	[key: string]: HostRequestHandler | undefined;
}

export interface KernelSentAgentMessage {
	id?: string;
	role?: string;
	content?: string;
	message?: string;
	deliveryStatus?: string;
	receiver_role?: string;
	receiver_name?: string;
	target?: {
		activeSessionId?: string;
		sessionId?: string;
		sessionName?: string;
	};
}

export interface KernelDiffDisplay {
	path: string;
	diff: string;
}

export interface KernelAttachment {
	mimeType: string;
	data: string;
	name?: string;
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
	durationMs: number;
	diffs?: KernelDiffDisplay[];
	attachments?: KernelAttachment[];
	sentAgentMessages?: KernelSentAgentMessage[];
}

export class KernelBusyAfterInterruptError extends Error {
	constructor() {
		super("Kernel is busy after interrupt");
		this.name = "KernelBusyAfterInterruptError";
	}
}

/**
 * KernelManager stub — the JS code tool uses CodeKernelProvisioner instead.
 * This exists only for type compatibility.
 */
export class KernelManager {
	constructor(_options?: any) {}
	async start(_opts?: any): Promise<void> {}
	async execute(_code: string, _opts?: any): Promise<ExecuteResult> {
		return { stdout: "", stderr: "", status: "ok", durationMs: 0 };
	}
	async dispose(): Promise<void> {}
	async kill(): Promise<void> {}
	async restoreState(): Promise<any> { return undefined; }
	async pruneOversizedVariables(): Promise<{ pruned: string[] } | null> { return null; }
	async listNamespaceNames(_signal?: AbortSignal): Promise<string[] | null> { return null; }
	get isRunning(): boolean { return false; }
}

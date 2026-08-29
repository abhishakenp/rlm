/**
 * JS code tool — AgentTool wrapper for @rlm/code.
 *
 * This replaces prime-agent's kernel tool with a JS code execution tool.
 * Same UX: !shell, %%bash, persistent variables, rlm.run().
 *
 * The agent calls this tool with JS code, gets back stdout/stderr/result —
 * same shape as kernel's ExecuteResult.
 *
 * Used via baseToolsOverride in createAgentSession() to replace kernel.
 */
import { Type } from "typebox";

const jsCodeSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript code to execute in the persistent agent kernel. Supports `!command` for shell (like kernel), `%%bash` for multi-line shell blocks, `await` for async, `var` for persistent variables, `rlm.run()` for subagent spawning, `fs`/`path`/`os` for Node builtins, `fetch` for network, `import()` for ESM modules. Variables persist across calls.",
	}),
});

export interface JsCodeToolDetails {
	status: "ok" | "error" | "aborted";
	durationMs: number;
}

/**
 * Create a JS code execution AgentTool that wraps the RlmCodeService.
 *
 * @param codeService - the @rlm/code service instance (ctx.get("rlmCode"))
 * @returns AgentTool compatible with prime-agent's baseToolsOverride
 */
export function createJsCodeTool(codeService: any): any {
	return {
		name: "code",
		label: "code",
		description:
			"Execute JavaScript scratchpad code in a persistent JS kernel. Supports `!command` for shell, `%%bash` for multi-line shell, `await` for async, `rlm.run()` for subagent spawning. Variables persist across calls. Node builtins (fs, path, os, child_process, fetch) available.",
		promptSnippet:
			"code - persistent JS kernel for scratchpad code, !shell commands, and rlm.run() subagent spawning",
		executionMode: "sequential" as const,
		parameters: jsCodeSchema,
		execute: async (
			_toolCallId: string,
			params: { code: string },
			signal?: AbortSignal,
			onUpdate?: (partial: any) => void,
		): Promise<{ content: any[]; details: JsCodeToolDetails }> => {
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Code execution aborted." }],
					details: { status: "aborted", durationMs: 0 },
				};
			}

			try {
				const result = await codeService.execute(params.code);

				// Build the content — same as kernel tool's output format.
				const parts: any[] = [];

				if (result.stdout) {
					parts.push({ type: "text", text: result.stdout });
				}
				if (result.stderr) {
					parts.push({ type: "text", text: result.stderr });
				}
				if (result.result) {
					parts.push({ type: "text", text: result.result });
				}

				if (result.status === "error") {
					const errorMsg = result.error
						? `${result.error.name}: ${result.error.message}\n${result.error.stack?.join("\n") ?? ""}`
						: "Unknown error";
					parts.push({ type: "text", text: errorMsg });
				}

				if (parts.length === 0) {
					parts.push({ type: "text", text: "" });
				}

				return {
					content: parts,
					details: {
						status: result.status,
						durationMs: result.durationMs,
					},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					details: { status: "error", durationMs: 0 },
				};
			}
		},
	};
}

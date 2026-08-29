/**
 * @rlm/agent — agent loop service.
 *
 * Clean Cordis Service. No prime-agent code.
 * Owns the agent loop: system prompt → model → tool calls → tool results → repeat.
 *
 * Reference: DSH's dsh-agent exposes an AgentRegistry service.
 * rlm-agent exposes an RlmAgent service with run() that drives the loop.
 *
 * Tools are registered by other plugins via ctx.emit("rlm/register-tool", tool).
 * This keeps the agent plugin small and tool-agnostic — tools are plugins too.
 */
import { Service } from "@deepseek-ai/cordis";
import type { ChatMessage, CompleteResult } from "@rlm/llm";

export interface RlmAgentConfig {
	systemPrompt?: string;
	maxIterations?: number;
	maxDepth?: number;
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: object;
	execute: (args: any, ctx: AgentRunContext) => Promise<string>;
}

export interface AgentRunContext {
	cwd: string;
	depth: number;
	maxDepth: number;
	abortSignal?: AbortSignal;
	onContent?: (delta: string) => void;
	onToolCall?: (name: string, args: any) => void;
	onToolResult?: (name: string, result: string) => void;
}

export interface AgentRunOptions {
	prompt: string;
	cwd?: string;
	depth?: number;
	maxDepth?: number;
	systemPrompt?: string;
	tools?: ToolDefinition[];
	abortSignal?: AbortSignal;
	onContent?: (delta: string) => void;
	onToolCall?: (name: string, args: any) => void;
	onToolResult?: (name: string, result: string) => void;
}

const DEFAULT_SYSTEM_PROMPT = `You are rlm, a self-evolving terminal agent.
You help with software engineering tasks.
When you need to run code, use the available tools.
Be concise and direct.`;

export class RlmAgentService extends Service {
	static inject = ["rlmLlm"] as const;
	static provide = "rlmAgent" as const;

	declare config: RlmAgentConfig;
	private tools: Map<string, ToolDefinition> = new Map();

	constructor(ctx: any, config: RlmAgentConfig = {}) {
		super(ctx, "rlmAgent");
		this.config = config;
	}

	async [Service.init]() {
		// Listen for tool registrations from other plugins.
		this.ctx.on("rlm/register-tool", (tool: ToolDefinition) => {
			this.tools.set(tool.name, tool);
			this.ctx.logger?.info(`rlm-agent: registered tool "${tool.name}"`);
		});
		this.ctx.logger?.info(`rlm-agent: agent loop ready (${this.tools.size} tools)`);
	}

	/** Register a tool directly. */
	registerTool(tool: ToolDefinition) {
		this.tools.set(tool.name, tool);
	}

	/** Get all registered tools. */
	getTools() {
		return [...this.tools.values()];
	}

	/** Run an agent loop. Returns the final assistant message. */
	async run(opts: AgentRunOptions): Promise<string> {
		const llm = this.ctx.get("rlmLlm");
		if (!llm) throw new Error("rlm-agent: rlmLlm service not available");

		const depth = opts.depth ?? 0;
		const maxDepth = opts.maxDepth ?? this.config.maxDepth ?? 10;
		const maxIterations = this.config.maxIterations ?? 25;
		const systemPrompt = opts.systemPrompt ?? this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

		const tools = opts.tools ?? this.getTools();
		const runCtx: AgentRunContext = {
			cwd: opts.cwd ?? process.cwd(),
			depth,
			maxDepth,
			abortSignal: opts.abortSignal,
			onContent: opts.onContent,
			onToolCall: opts.onToolCall,
			onToolResult: opts.onToolResult,
		};

		const messages: ChatMessage[] = [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: opts.prompt },
		];

		for (let i = 0; i < maxIterations; i++) {
			const toolSchemas = tools.length > 0
				? tools.map((t) => ({
						type: "function" as const,
						function: {
							name: t.name,
							description: t.description,
							parameters: t.parameters,
						},
					}))
				: undefined;

			const result = await llm.complete({
				messages,
				tools: toolSchemas,
				signal: opts.abortSignal,
			});

			// Add assistant message to history.
			const assistantMsg: ChatMessage = {
				role: "assistant",
				content: result.content,
			};
			if (result.toolCalls?.length) {
				assistantMsg.tool_calls = result.toolCalls;
			}
			messages.push(assistantMsg);

			// Stream content if callback provided.
			if (result.content && opts.onContent) {
				opts.onContent(result.content);
			}

			// No tool calls → done.
			if (!result.toolCalls?.length || result.finishReason === "stop") {
				return result.content;
			}

			// Execute tool calls.
			for (const tc of result.toolCalls) {
				const tool = this.tools.get(tc.function.name);
				opts.onToolCall?.(tc.function.name, tc.function.arguments);

				let toolResult: string;
				if (!tool) {
					toolResult = `Error: tool "${tc.function.name}" not found`;
				} else {
					try {
						let args: any;
						try {
							args = JSON.parse(tc.function.arguments);
						} catch {
							args = {};
						}
						toolResult = await tool.execute(args, runCtx);
					} catch (error) {
						toolResult = `Error: ${error instanceof Error ? error.message : String(error)}`;
					}
				}

				opts.onToolResult?.(tc.function.name, toolResult);
				messages.push({
					role: "tool",
					content: toolResult,
					tool_call_id: tc.id,
				} as ChatMessage);
			}
		}

		return "rlm-agent: max iterations reached";
	}

	async [Symbol.dispose]() {
		this.tools.clear();
	}
}

export default RlmAgentService;
export const name = "rlm-agent";
export const inject = ["rlmLlm"] as const;
export { RlmAgentService as RlmAgent };

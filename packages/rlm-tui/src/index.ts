/**
 * @rlm/tui — terminal UI service.
 *
 * Clean Cordis Service. No prime-agent code.
 * Owns terminal rendering: raw mode, input, ANSI output.
 *
 * Reference: DSH's dsh-host-frontend-static is a plugin that injects
 * webServer and serves static files. rlm-tui is the terminal analog —
 * it injects rlmAgent and renders the conversation to stdout.
 *
 * On disposal (HMR): restores terminal state (raw mode off, alternate screen off).
 * On reload: re-initializes with fresh state.
 */
import { Service } from "@deepseek-ai/cordis";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

export interface RlmTuiConfig {
	/** Show tool calls. */
	verbose?: boolean;
}

export class RlmTuiService extends Service {
	static inject = ["rlmAgent", "rlmLlm"] as const;
	static provide = "rlmTui" as const;

	declare config: RlmTuiConfig;
	private active = false;

	constructor(ctx: any, config: RlmTuiConfig = {}) {
		super(ctx, "rlmTui");
		this.config = config;
	}

	async [Service.init]() {
		this.ctx.logger?.info("rlm-tui: terminal UI ready");
	}

	/** Run a one-shot prompt in print mode (no interactive UI). */
	async runPrint(prompt: string): Promise<string> {
		const agent = this.ctx.get("rlmAgent");
		if (!agent) throw new Error("rlm-tui: rlmAgent service not available");

		let output = "";
		const result = await agent.run({
			prompt,
			onContent: (delta) => {
				process.stdout.write(delta);
				output += delta;
			},
			onToolCall: (name, args) => {
				if (this.config.verbose) {
					process.stderr.write(`\n[tool: ${name}]\n`);
				}
			},
			onToolResult: (name, result) => {
				if (this.config.verbose) {
					process.stderr.write(`\n[tool result: ${name} → ${result.slice(0, 200)}]\n`);
				}
			},
		});
		process.stdout.write("\n");
		return result;
	}

	/** Start the interactive TUI loop. */
	async startInteractive(): Promise<void> {
		const agent = this.ctx.get("rlmAgent");
		if (!agent) throw new Error("rlm-tui: rlmAgent service not available");

		this.active = true;
		const rl = createInterface({ input: stdin, output: stdout });

		process.stdout.write("rlm — self-evolving terminal agent\n");
		process.stdout.write("Type your message. Ctrl+C to exit.\n\n");

		const prompt = (): Promise<string> =>
			new Promise((resolve) => {
				rl.question("you> ", (answer) => resolve(answer));
			});

		while (this.active) {
			const input = await prompt();
			if (!input.trim() || !this.active) continue;
			if (input.trim() === "exit" || input.trim() === "quit") break;

			process.stdout.write("rlm> ");
			try {
				await agent.run({
					prompt: input,
					onContent: (delta) => process.stdout.write(delta),
					onToolCall: (name) => process.stdout.write(`\n  [tool: ${name}]`),
					onToolResult: (name, result) => {
						if (this.config.verbose) {
							process.stdout.write(`\n  [result: ${result.slice(0, 200)}]`);
						}
					},
				});
			} catch (error) {
				process.stdout.write(`\nError: ${error instanceof Error ? error.message : String(error)}`);
			}
			process.stdout.write("\n\n");
		}

		rl.close();
		this.active = false;
	}

	stop(): void {
		this.active = false;
	}

	async [Symbol.dispose]() {
		this.active = false;
		// Restore terminal state if needed.
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
		}
	}
}

export default RlmTuiService;
export const name = "rlm-tui";
export const inject = ["rlmAgent", "rlmLlm"] as const;
export { RlmTuiService as RlmTui };

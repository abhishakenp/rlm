/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import { cutAtPseudoMarkup, type ImageContent, INLINE_THINK_SIGNATURE } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import { type AgentAutonomousStatus, type AutonomousLimitReason, autonomousLimitReason } from "../core/autonomous.js";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.js";
import { killTrackedDetachedChildren } from "../utils/shell.js";
import { InProcessAgentConnection } from "./agent-connection/in-process-agent-connection.js";
import type { AgentConnection } from "./agent-connection/types.js";
import { latestAutonomousGateAttempt, selectHeadlessTerminalResult } from "./headless-completion.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

function describeAutonomousLimit(status: AgentAutonomousStatus, reason: AutonomousLimitReason): string {
	if (reason === "maxContinuations") {
		return `maxContinuations reached (${status.continuationsUsed}/${status.limits.maxContinuations})`;
	}
	if (reason === "maxTurns") {
		return `maxTurns reached (${status.turnsUsed}/${status.limits.maxTurns})`;
	}
	if (reason === "maxTokens") {
		return `maxTokens reached (${status.tokensUsed}/${status.limits.maxTokens})`;
	}
	const elapsed = status.startedAt === undefined ? 0 : Math.max(0, Date.now() - status.startedAt);
	return `timeoutMs reached (${elapsed}/${status.limits.timeoutMs})`;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const connection = new InProcessAgentConnection(runtimeHost);
	return runPrintModeWithConnectionInternal(connection, options, () => connection.bindHeadlessExtensions());
}

export async function runPrintModeWithConnection(
	connection: AgentConnection,
	options: PrintModeOptions,
): Promise<number> {
	return runPrintModeWithConnectionInternal(connection, options);
}

async function runPrintModeWithConnectionInternal(
	connection: AgentConnection,
	options: PrintModeOptions,
	bindHeadlessExtensions?: () => Promise<void>,
): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	const repeatLoop = createRepeatedAnswerGuard();
	let disposed = false;
	let unsubscribe: (() => void) | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeConnection = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await connection.dispose();
	};

	for (const signal of [
		"SIGINT",
		"SIGTERM",
		...(process.platform === "win32" ? [] : ["SIGHUP"]),
	] as NodeJS.Signals[]) {
		const handler = () => {
			killTrackedDetachedChildren();
			void disposeConnection().finally(() => {
				const exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
				process.exit(exitCode);
			});
		};
		process.on(signal, handler);
		signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	try {
		if (mode === "json") {
			const header = await connection.getSessionHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		unsubscribe = connection.subscribe((event) => {
			if (mode === "json" && event.type === "session_event") {
				writeRawStdout(`${JSON.stringify(event.event)}\n`);
			}
			if (event.type === "session_event" && !repeatLoop.answer) {
				const stop = repeatLoop.observe(event.event as { type?: string; message?: unknown });
				if (stop) void connection.abort().catch(() => undefined);
			}
			if (event.type === "extension_error") {
				console.error(`Extension error (${event.extensionPath}): ${event.error}`);
			}
		});
		await bindHeadlessExtensions?.();

		if (initialMessage) {
			await connection.promptAndWait(initialMessage, { images: initialImages });
		}
		for (const message of messages) {
			await connection.promptAndWait(message);
		}

		const autonomousStatus = await connection.waitForHeadlessCompletion();
		if (repeatLoop.answer !== undefined) {
			// Stopped a run that kept giving the same answer and calling tools.
			console.error(`[rlm] stopped after ${REPEATED_ANSWER_LIMIT} identical answers in a row`);
			if (mode === "text") writeRawStdout(`${repeatLoop.answer}\n`);
		} else if (mode === "text") {
			const allMessages = await connection.getMessages();
			const { primary, compactionOutcomes } = selectHeadlessTerminalResult(allMessages);
			if (primary?.role === "assistant") {
				if (primary.stopReason === "error" || primary.stopReason === "aborted") {
					console.error(primary.errorMessage || `Request ${primary.stopReason}`);
					exitCode = 1;
				} else {
					// Inline-think routes can restart reasoning in plain text after the
					// answer, behind pseudo chat-template markup; print the answer only.
					const inlineThink = primary.content.some(
						(content) => content.type === "thinking" && content.thinkingSignature === INLINE_THINK_SIGNATURE,
					);
					const texts = primary.content
						.filter((content) => content.type === "text")
						.map((content) => (inlineThink ? cutAtPseudoMarkup(content.text) : content.text));
					const earlier = inlineThink ? restatedEarlierAnswer(allMessages, primary, texts.join("")) : undefined;
					if (earlier !== undefined) writeRawStdout(`${earlier}\n`);
					else for (const text of texts) writeRawStdout(`${text}\n`);
				}
			} else if (primary) {
				writeRawStdout(`${primary.content}\n`);
				if (!primary.details.success || primary.details.severity === "error") exitCode = 1;
			}
			for (const outcome of compactionOutcomes) {
				console.error(outcome.content);
				if (outcome.details.outcome === "failed") exitCode = 1;
			}
		}

		const autonomousLimit = autonomousLimitReason(autonomousStatus);
		if (autonomousStatus.enabled && autonomousStatus.gates.commands.length > 0 && autonomousStatus.lastGateFailure) {
			const limitText = autonomousLimit
				? `; autonomous limit reached: ${describeAutonomousLimit(autonomousStatus, autonomousLimit)}`
				: "";
			console.error(
				`Autonomous quality gate still failing after attempt ${latestAutonomousGateAttempt(autonomousStatus)}/${autonomousStatus.gates.maxRetries}: ${autonomousStatus.lastGateFailure.exitText}${limitText}`,
			);
			exitCode = 1;
		} else if (autonomousStatus.enabled && autonomousStatus.gates.commands.length === 0 && autonomousLimit) {
			console.error(
				`Autonomous run stopped before terminal evidence; ${describeAutonomousLimit(autonomousStatus, autonomousLimit)}`,
			);
			exitCode = 1;
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeConnection();
		await flushRawStdout();
	}
}

/** Identical answers in a row (each followed by more tool calls) that end a headless run. */
export const REPEATED_ANSWER_LIMIT = 3;

/** Tool-call markup some routes pass through as text; the answer ends where it starts. */
const TEXT_TOOL_MARKUP = /<function_calls>|<tool_response>|<invoke[\s>]|\[\/?TOOL_CALL\]/;

/** A code cell that does nothing but print or record — no files, shell, network or subagents. */
const WORKING_CALL = /\b(rlm|fs|sh|exec|execSync|spawn|fetch|require|import|process|path|os|refine|agent_message|goal|compact)\s*[.(`]|%%bash|^\s*!/m;
const isBookkeepingCall = (block: { type: string; name?: string; arguments?: unknown }): boolean => {
	if (block.type !== "toolCall") return false;
	if (block.name === undefined) return true; // nothing to inspect: counted as before
	if (block.name !== "code") return false; // edit and other tools change things
	const code = String((block.arguments as { code?: unknown } | undefined)?.code ?? "");
	return code.length <= 400 && !WORKING_CALL.test(code);
};

/** The answer a message leads with: its first paragraph, up to any tool markup. */
const leadAnswer = (text: string): string => text.split(TEXT_TOOL_MARKUP)[0]!.trim().split(/\n\s*\n/)[0]!.trim();

/**
 * A headless run can loop: the model answers, calls a tool, answers the same
 * thing, calls another tool, … (live: `pong` + `<function_calls>` for 150s until
 * the timeout, rc 124; and `pong\n\nDone. …` + `console.log('pong')` 22 times,
 * each turn's narration worded a little differently). Nobody is there to stop
 * it, so the run stops itself once the same LEAD answer (the first paragraph)
 * has come back REPEATED_ANSWER_LIMIT times in a row with nothing but
 * bookkeeping cells between — console.log / context.* — and that answer is the
 * result. A turn that does real work (files, shell, network, subagents) resets
 * the count, so a long real run that opens every turn the same way is not cut.
 */
export function createRepeatedAnswerGuard() {
	let last: string | undefined;
	let count = 0;
	const guard = {
		answer: undefined as string | undefined,
		observe(event: { type?: string; message?: unknown }): boolean {
			if (event.type !== "message_end") return false;
			const message = event.message as {
				role?: string;
				content?: Array<{ type: string; text?: string; name?: string; arguments?: unknown }>;
			};
			if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("");
			const answer = leadAnswer(text);
			const calls = message.content.filter((block) => block.type === "toolCall");
			if (!answer || calls.length === 0 || calls.some((call) => !isBookkeepingCall(call))) {
				last = undefined;
				count = 0;
				return false;
			}
			count = answer === last ? count + 1 : 1;
			last = answer;
			if (count < REPEATED_ANSWER_LIMIT) return false;
			guard.answer = answer;
			return true;
		},
	};
	return guard;
}

/**
 * The run's earlier answer, when the final message only restates it and adds
 * narration (`pong` + tool call, then `pong**@user** — exactly \`pong\` as
 * requested ✓ …`, live). Inline-think routes do this after a tool round trip:
 * the answer was already given, and what follows it is commentary on the tool
 * call. Returns undefined when the final text is not such a restatement.
 */
export function restatedEarlierAnswer(
	messages: readonly { role?: string; content?: unknown }[],
	final: { content?: unknown },
	finalText: string,
): string | undefined {
	const text = finalText.trim();
	let runStart = messages.length - 1;
	while (runStart > 0 && messages[runStart]?.role !== "user") runStart--;
	for (let i = runStart + 1; i < messages.length; i++) {
		const message = messages[i]!;
		if (message === final || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const answer = (message.content as { type: string; text?: string }[])
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("")
			.trim();
		if (answer && text.length > answer.length && text.startsWith(answer)) return answer;
	}
	return undefined;
}

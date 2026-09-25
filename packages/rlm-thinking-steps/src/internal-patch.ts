import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, ThinkingContent } from "@mariozechner/pi-ai";
import { Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { decrementPatchRefCount, getActiveThinkingState, getPatchCleanup, setThinkingStepsMode, getPatchInstallPromise, incrementPatchRefCount, resolveThinkingMessageScope, setPatchCleanup, setPatchInstallPromise } from "./state.js";
import { ThinkingStepsComponent } from "./render.js";
import type { ThinkingSourceBlock, ThinkingThemeLike } from "./types.js";

// rlm: the running TUI is packages/coding-agent/src executed as TypeScript, so
// the patch must reach those module instances — `dist/` is a separate, stale copy.
export const PI_CODING_AGENT_INTERNAL_MODULES = {
	assistantMessageComponent: "src/modes/interactive/components/assistant-message.ts",
	theme: "src/modes/interactive/theme/theme.ts",
} as const;

interface AssistantMessageComponentPrototype {
	updateContent(message: AssistantMessage): void;
	setHideThinkingBlock(hide: boolean): void;
	setHiddenThinkingLabel(label: string): void;
	contentContainer: {
		clear(): void;
		addChild(component: unknown): void;
	};
	lastMessage?: AssistantMessage;
	hideThinkingBlock: boolean;
	markdownTheme: unknown;
	hiddenThinkingLabel: string;
}

export function assertPatchableAssistantMessageComponent(value: unknown): { prototype: AssistantMessageComponentPrototype } {
	if (!value || (typeof value !== "function" && typeof value !== "object")) {
		throw new Error("Thinking Steps patch failed: AssistantMessageComponent export is missing or invalid.");
	}

	const prototype = (value as { prototype?: unknown }).prototype;
	if (!prototype || typeof prototype !== "object") {
		throw new Error("Thinking Steps patch failed: AssistantMessageComponent.prototype is missing.");
	}

	const candidate = prototype as Record<string, unknown>;
	const missingMethods = ["updateContent", "setHideThinkingBlock", "setHiddenThinkingLabel"].filter((name) => typeof candidate[name] !== "function");
	if (missingMethods.length > 0) {
		throw new Error(`Thinking Steps patch failed: AssistantMessageComponent prototype is incompatible (missing ${missingMethods.join(", ")}).`);
	}

	return value as { prototype: AssistantMessageComponentPrototype };
}

export function assertThinkingStepsTheme(value: unknown): ThinkingThemeLike {
	if (!value || typeof value !== "object") {
		throw new Error("Thinking Steps patch failed: interactive theme export is missing or invalid.");
	}

	try {
		const candidate = value as Record<string, unknown>;
		if (typeof candidate.fg !== "function" || typeof candidate.bold !== "function") {
			throw new Error("Thinking Steps patch failed: interactive theme export is incompatible.");
		}
	} catch (error) {
		if (error instanceof Error && /Theme not initialized/.test(error.message)) {
			return value as ThinkingThemeLike;
		}
		throw error;
	}

	return value as ThinkingThemeLike;
}

function hasPatchableContentContainer(value: AssistantMessageComponentPrototype): boolean {
	return Boolean(
		value.contentContainer
		&& typeof value.contentContainer.clear === "function"
		&& typeof value.contentContainer.addChild === "function",
	);
}

function fallbackToOriginalUpdateContent(
	instance: AssistantMessageComponentPrototype,
	message: AssistantMessage,
	originalUpdateContent: (message: AssistantMessage) => void,
): void {
	try {
		originalUpdateContent.call(instance, message);
	} catch (error) {
		throw new Error("Thinking Steps patch failed: Pi internals are incompatible and fallback rendering also failed.", { cause: error });
	}
}

function getPackageRoot(packageName: string): string {
	let entryUrl: string;
	try {
		entryUrl = import.meta.resolve(packageName);
	} catch (error) {
		throw new Error(`Thinking Steps patch failed: could not resolve ${packageName} package root. Pi internals may be unavailable or moved.`, {
			cause: error,
		});
	}

	try {
		const entryPath = fileURLToPath(entryUrl);
		return dirname(dirname(entryPath));
	} catch (error) {
		throw new Error(`Thinking Steps patch failed: could not derive ${packageName} package root from ${entryUrl}.`, {
			cause: error,
		});
	}
}

export function resolvePiCodingAgentInternalModuleUrl(relativePath: string): string {
	const packageRoot = getPackageRoot("@mariozechner/pi-coding-agent");
	return pathToFileURL(join(packageRoot, relativePath)).href;
}

export async function importPiCodingAgentInternal<TModule>(relativePath: string): Promise<TModule> {
	const moduleUrl = resolvePiCodingAgentInternalModuleUrl(relativePath);
	try {
		return (await import(moduleUrl)) as TModule;
	} catch (error) {
		throw new Error(`Thinking Steps patch failed: could not import internal module "@mariozechner/pi-coding-agent/${relativePath}". Pi internals may have moved.`, {
			cause: error,
		});
	}
}

function hasVisibleThinking(content: ThinkingContent): boolean {
	return content.redacted === true || content.thinking.trim().length > 0;
}

const THINK_TAG = /<\/?(?:think|thinking|reasoning)\s*>/gi;

function collectThinkingBlocks(message: AssistantMessage): ThinkingSourceBlock[] {
	const blocks: ThinkingSourceBlock[] = [];
	message.content.forEach((content, index) => {
		if (content.type !== "thinking") return;
		if (!hasVisibleThinking(content)) return;
		blocks.push({
			contentIndex: index,
			// rlm: never show raw reasoning delimiters inside a step.
			text: content.thinking.includes("<") ? content.thinking.replace(THINK_TAG, "") : content.thinking,
			redacted: content.redacted,
		});
	});
	return blocks;
}

/**
 * rlm: Ctrl+T (app.thinking.toggle, persisted as hideThinkingBlock) is rlm's
 * one thinking switch. The plugin owns thinking display, so the switch picks
 * its mode: hidden → the `summary` step tree, visible → `expanded`. rlm
 * rebuilds every message on a toggle, handing the new value to each
 * component's constructor (or the setter, for the streaming one), so a change
 * is detected here the first time a component shows a different value than
 * the last one seen. The first value seen only records the baseline — the
 * starting mode is the plugin's own restore (session → project → global).
 */
const lastHiddenByScope = new Map<string, boolean>();

function syncHiddenToMode(instance: object, scopeKey: string): void {
	const own = instance as { __thinkingStepsHide?: boolean; hideThinkingBlock?: boolean };
	const hidden = own.__thinkingStepsHide ?? own.hideThinkingBlock;
	if (typeof hidden !== "boolean") return;
	const previous = lastHiddenByScope.get(scopeKey);
	lastHiddenByScope.set(scopeKey, hidden);
	if (previous === undefined || previous === hidden) return;
	setThinkingStepsMode(hidden ? "summary" : "expanded", scopeKey);
}

/** rlm: the private members of rlm's AssistantMessageComponent the rendered tail reads. */
interface RlmAssistantMessageInternals {
	createErrorComponent(message: string, prefix?: string): unknown;
	retried?: boolean;
	precededByToolActivity?: boolean;
	hasToolCalls?: boolean;
}

/** rlm: components kept across updates of one message, so streaming does not rebuild them per token. */
interface ThinkingStepsReuse {
	timestamp: number;
	thinkingKey?: string;
	nextDeriveAt: number;
	steps?: ThinkingStepsComponent;
	markdowns: Map<number, InstanceType<typeof Markdown>>;
}

const reuseByInstance = new WeakMap<object, ThinkingStepsReuse>();
/**
 * rlm: bumped on every install and release; a component rebuilds once when it
 * sees a new value. On globalThis, like upstream's state, so a hot-reloaded copy
 * of this module and the render() wrapper an older copy installed share it.
 */
const patchShared = ((globalThis as Record<PropertyKey, unknown>)[Symbol.for("rlm.thinking-steps.patch")] ??= {
	generation: 0,
	wrapped: new WeakSet<object>(),
}) as { generation: number; wrapped: WeakSet<object> };
const DERIVE_INTERVAL_MS = 150;

/** rlm: components whose setter fell back to Pi's renderer, and so stay on it (upstream semantics). */
const nativeRender = new WeakSet<object>();
const markNativeRender = (instance: object): void => {
	nativeRender.add(instance);
};

function reuseFor(instance: object, timestamp: number): ThinkingStepsReuse {
	const existing = reuseByInstance.get(instance);
	if (existing && existing.timestamp === timestamp) return existing;
	const created: ThinkingStepsReuse = { timestamp, nextDeriveAt: 0, markdowns: new Map() };
	reuseByInstance.set(instance, created);
	return created;
}

function hasVisibleTextContent(message: AssistantMessage): boolean {
	return message.content.some((content) => content.type === "text" && content.text.trim().length > 0);
}

function hasVisibleThinkingContent(message: AssistantMessage): boolean {
	return message.content.some((content) => content.type === "thinking" && hasVisibleThinking(content));
}

async function installPatch(): Promise<() => void> {
	const [{ AssistantMessageComponent: rawAssistantMessageComponent }, { theme: rawTheme }] = await Promise.all([
		importPiCodingAgentInternal<{ AssistantMessageComponent: unknown }>(
			PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
		),
		importPiCodingAgentInternal<{ theme: unknown }>(
			PI_CODING_AGENT_INTERNAL_MODULES.theme,
		),
	]);

	const AssistantMessageComponent = assertPatchableAssistantMessageComponent(rawAssistantMessageComponent);
	const theme = assertThinkingStepsTheme(rawTheme);
	const prototype = AssistantMessageComponent.prototype;
	const originalUpdateContent = prototype.updateContent;
	const originalSetHideThinkingBlock = prototype.setHideThinkingBlock;
	const originalSetHiddenThinkingLabel = prototype.setHiddenThinkingLabel;

	// rlm: AssistantMessageComponent is lazy \u2014 updateContent() and every setter only
	// mark it dirty, and render() calls reconcile(). Upstream patches the eager
	// updateContent, which rlm's render() would then overwrite on the next dirty
	// frame (retry, theme change, expand). So the renderer goes on reconcile(),
	// and "the original renderer" for fallbacks is rlm's reconcile().
	const rlmPrototype = prototype as unknown as { reconcile?: (message: AssistantMessage) => void };
	const originalReconcile = typeof rlmPrototype.reconcile === "function" ? rlmPrototype.reconcile : undefined;
	const originalRender = originalReconcile ?? originalUpdateContent;
	const rlmErrors = await importPiCodingAgentInternal<{ summarizeErrorDetails?: (message: string) => string }>(
		"src/modes/interactive/components/collapsible-error.ts",
	).catch(() => undefined);
	const rlmSummarizeError = rlmErrors?.summarizeErrorDetails ?? ((message: string) => message);

	const normalizeHiddenThinkingLabel = (label: string): string => label.replace(/\u2060+$/gu, "");

	const restoreOriginalMethods = (): void => {
		if (prototype.updateContent !== originalUpdateContent) {
			prototype.updateContent = originalUpdateContent;
		}
		if (originalReconcile && rlmPrototype.reconcile !== originalReconcile) {
			rlmPrototype.reconcile = originalReconcile;
			patchShared.generation++;
		}
		if (prototype.setHideThinkingBlock !== originalSetHideThinkingBlock) {
			prototype.setHideThinkingBlock = originalSetHideThinkingBlock;
		}
		if (prototype.setHiddenThinkingLabel !== originalSetHiddenThinkingLabel) {
			prototype.setHiddenThinkingLabel = originalSetHiddenThinkingLabel;
		}
	};

	const withOriginalInstanceMethods = <T>(instance: AssistantMessageComponentPrototype, callback: () => T): T => {
		const ownUpdateContent = Object.prototype.hasOwnProperty.call(instance, "updateContent");
		const ownSetHideThinkingBlock = Object.prototype.hasOwnProperty.call(instance, "setHideThinkingBlock");
		const ownSetHiddenThinkingLabel = Object.prototype.hasOwnProperty.call(instance, "setHiddenThinkingLabel");
		const previousUpdateContent = instance.updateContent;
		const previousSetHideThinkingBlock = instance.setHideThinkingBlock;
		const previousSetHiddenThinkingLabel = instance.setHiddenThinkingLabel;

		instance.updateContent = originalUpdateContent;
		instance.setHideThinkingBlock = originalSetHideThinkingBlock;
		instance.setHiddenThinkingLabel = originalSetHiddenThinkingLabel;

		try {
			return callback();
		} finally {
			if (ownUpdateContent) {
				instance.updateContent = previousUpdateContent;
			} else {
				delete (instance as unknown as Record<string, unknown>).updateContent;
			}

			if (ownSetHideThinkingBlock) {
				instance.setHideThinkingBlock = previousSetHideThinkingBlock;
			} else {
				delete (instance as unknown as Record<string, unknown>).setHideThinkingBlock;
			}

			if (ownSetHiddenThinkingLabel) {
				instance.setHiddenThinkingLabel = previousSetHiddenThinkingLabel;
			} else {
				delete (instance as unknown as Record<string, unknown>).setHiddenThinkingLabel;
			}
		}
	};

	const reportFallback = (stage: string, error: unknown): void => {
		console.warn(`Thinking Steps patch warning: falling back to Pi renderer during ${stage}.`, error);
	};

	const fallbackErrorMessage = "Thinking Steps patch failed: Pi internals are incompatible and fallback rendering also failed.";

	const fallbackToOriginalUpdateContent = (
		instance: AssistantMessageComponentPrototype,
		message: AssistantMessage,
		stage: string,
		originalError?: unknown,
	): void => {
		try {
			withOriginalInstanceMethods(instance, () => {
				originalRender.call(instance, message);
			});
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			});
		}

		if (originalError) {
			reportFallback(stage, originalError);
		}
	};

	const fallbackToOriginalSetHideThinkingBlock = (
		instance: AssistantMessageComponentPrototype,
		hide: boolean,
		originalError?: unknown,
	): void => {
		try {
			withOriginalInstanceMethods(instance, () => {
				originalSetHideThinkingBlock.call(instance, hide);
			});
			if (originalError) markNativeRender(instance);
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			});
		}

		if (originalError) {
			reportFallback("setHideThinkingBlock", originalError);
		}
	};

	const fallbackToOriginalSetHiddenThinkingLabel = (
		instance: AssistantMessageComponentPrototype,
		label: string,
		originalError?: unknown,
	): void => {
		const normalizedLabel = normalizeHiddenThinkingLabel(label);
		try {
			withOriginalInstanceMethods(instance, () => {
				originalSetHiddenThinkingLabel.call(instance, normalizedLabel);
			});
			if (originalError) markNativeRender(instance);
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			});
		}

		if (originalError) {
			reportFallback("setHiddenThinkingLabel", originalError);
		}
	};

	const patchedUpdateContent = function patchedUpdateContent(this: AssistantMessageComponentPrototype, message: AssistantMessage): void {
		this.lastMessage = message;
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalUpdateContent(this, message, "updateContent");
			return;
		}
		// rlm: after a setter fell back, upstream leaves that component on Pi's native
		// renderer. rlm renders lazily through this function, so honour it here.
		if (originalReconcile && nativeRender.has(this)) {
			fallbackToOriginalUpdateContent(this, message, "updateContent");
			return;
		}

		try {
			syncHiddenToMode(this, resolveThinkingMessageScope(message));
			this.contentContainer.clear();

			const thinkingBlocks = collectThinkingBlocks(message);
			const hasVisibleContent = hasVisibleTextContent(message) || thinkingBlocks.length > 0;
			if (hasVisibleContent) {
				this.contentContainer.addChild(new Spacer(1));
			}

			let renderedThinking = false;
			const hasVisibleTextAfterThinking = (() => {
				const firstThinkingIndex = thinkingBlocks[0]?.contentIndex;
				if (firstThinkingIndex === undefined) return false;
				return message.content.slice(firstThinkingIndex + 1).some((content) => content.type === "text" && content.text.trim().length > 0);
			})();

			// rlm: streaming calls updateContent once per token. Upstream builds a new
			// Markdown per text block and a new ThinkingStepsComponent (re-deriving every
			// step from the whole trace) each time — 12.65ms/token vs rlm's 1.35ms over
			// a 1,500-token reply. Reuse both across updates of the same message; the
			// output is identical (ThinkingStepsComponent keys its own cache on mode,
			// width and active step, so mode switches still repaint).
			// rlm's invalidate() (theme change) clears lastSignature to force a rebuild with
			// fresh theme-dependent children; honour it by dropping what we kept.
			const rlmSignature = this as unknown as { lastSignature?: string };
			if (originalReconcile && rlmSignature.lastSignature === undefined) reuseByInstance.delete(this);
			rlmSignature.lastSignature = "thinking-steps";
			const reuse = reuseFor(this, message.timestamp);
			const nextMarkdowns = new Map<number, InstanceType<typeof Markdown>>();
			const scopeKey = resolveThinkingMessageScope(message);
			const thinkingKey = `${scopeKey}\u0000${thinkingBlocks.map((b) => `${b.contentIndex}:${b.redacted ? 1 : 0}:${b.text}`).join("\u0000")}`;

			message.content.forEach((content, index) => {
				if (content.type === "text" && content.text.trim()) {
					const text = content.text.trim();
					let markdown = reuse.markdowns.get(index);
					if (markdown) {
						markdown.setText(text);
					} else {
						markdown = new Markdown(text, 1, 0, this.markdownTheme as any);
					}
					nextMarkdowns.set(index, markdown);
					this.contentContainer.addChild(markdown);
					return;
				}

				if (content.type === "thinking" && thinkingBlocks.length > 0 && !renderedThinking) {
					if (!reuse.steps || reuse.thinkingKey !== thinkingKey) {
						// Deriving steps re-parses the whole trace (24.7ms/token averaged over a
						// 3,000-token trace, growing with it). While the trace is still streaming,
						// re-derive at most every 150ms (longer if deriving is slow); once thinking ends the final steps are
						// always derived from the complete text.
						const now = Date.now();
						const streaming = getActiveThinkingState(message.timestamp, scopeKey).active;
						if (!reuse.steps || !streaming || now >= reuse.nextDeriveAt) {
							reuse.steps = new ThinkingStepsComponent(theme, message.timestamp, thinkingBlocks, scopeKey);
							reuse.thinkingKey = thinkingKey;
							// Wait at least 4x what that derivation cost, so a long trace
							// never takes more than ~20% of the main thread while it streams.
							const took = Date.now() - now;
							reuse.nextDeriveAt = now + Math.max(DERIVE_INTERVAL_MS, took * 4);
						}
					}
					this.contentContainer.addChild(reuse.steps);
					renderedThinking = true;
					if (hasVisibleTextAfterThinking) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			});
			reuse.markdowns = nextMarkdowns;

			const hasToolCalls = message.content.some((content) => content.type === "toolCall");
			// rlm: keep rlm's own tail — retried errors as a muted "↻ … — retried" line,
			// login-recovery errors, aborts shown even with tool calls, and the spacer
			// before tool blocks — so only the thinking rendering changes.
			const rlm = this as unknown as RlmAssistantMessageInternals;
			if (typeof rlm.createErrorComponent === "function") {
				rlm.hasToolCalls = hasToolCalls;
				if (message.stopReason === "aborted") {
					const abortMessage =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: "Operation aborted";
					this.contentContainer.addChild(new Spacer(1));
					this.contentContainer.addChild(rlm.createErrorComponent(abortMessage));
				} else if (!hasToolCalls && message.stopReason === "error") {
					const errorMessage = message.errorMessage || "Unknown error";
					this.contentContainer.addChild(new Spacer(1));
					this.contentContainer.addChild(
						rlm.retried
							? new Text(theme.fg("muted", `↻ ${rlmSummarizeError(errorMessage)} — retried`), 1, 0)
							: rlm.createErrorComponent(errorMessage, "Error"),
					);
				}
				if (hasToolCalls && (hasVisibleContent || message.stopReason === "aborted" || !rlm.precededByToolActivity)) {
					this.contentContainer.addChild(new Spacer(1));
				}
				return;
			}
			if (!hasToolCalls) {
				if (message.stopReason === "aborted") {
					const abortMessage =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: "Operation aborted";
					this.contentContainer.addChild(new Spacer(1));
					this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
				} else if (message.stopReason === "error") {
					const errorMessage = message.errorMessage || "Unknown error";
					this.contentContainer.addChild(new Spacer(1));
					this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
				}
			}
		} catch (error) {
			fallbackToOriginalUpdateContent(this, message, "updateContent", error);
		}
	};

	const patchedSetHideThinkingBlock = function patchedSetHideThinkingBlock(this: AssistantMessageComponentPrototype, hide: boolean): void {
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalSetHideThinkingBlock(this, hide);
			return;
		}

		// rlm: remember what rlm asked for (Ctrl+T) — the renderer maps it to a mode.
		(this as unknown as { __thinkingStepsHide?: boolean }).__thinkingStepsHide = hide;
		this.hideThinkingBlock = false;
		if (!this.lastMessage) return;
		try {
			this.updateContent(this.lastMessage);
		} catch (error) {
			fallbackToOriginalSetHideThinkingBlock(this, hide, error);
		}
	};

	const patchedSetHiddenThinkingLabel = function patchedSetHiddenThinkingLabel(
		this: AssistantMessageComponentPrototype,
		label: string,
	): void {
		const normalizedLabel = normalizeHiddenThinkingLabel(label);
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalSetHiddenThinkingLabel(this, normalizedLabel);
			return;
		}

		this.hiddenThinkingLabel = normalizedLabel;
		if (!this.lastMessage) return;
		try {
			this.updateContent(this.lastMessage);
		} catch (error) {
			fallbackToOriginalSetHiddenThinkingLabel(this, normalizedLabel, error);
		}
	};

	try {
		if (originalReconcile) {
			// rlm: render lazily from reconcile(); updateContent stays rlm's (mark dirty).
			rlmPrototype.reconcile = patchedUpdateContent;
			// Messages already on screen were built by the renderer in place before;
			// rebuild each once, the next time it paints (install and release both).
			patchShared.generation++;
			if (!patchShared.wrapped.has(prototype)) {
				const renderProto = prototype as unknown as { render(width: number): string[] };
				const innerRender = renderProto.render;
				patchShared.wrapped.add(prototype);
				renderProto.render = function renderAtGeneration(this: Record<string, unknown>, width: number): string[] {
					if (this.__thinkingStepsGeneration !== patchShared.generation) {
						this.__thinkingStepsGeneration = patchShared.generation;
						if (this.lastMessage) {
							this.lastSignature = undefined;
							this.dirty = true;
						}
					}
					return innerRender.call(this, width);
				};
			}
		} else {
			prototype.updateContent = patchedUpdateContent;
		}
		prototype.setHideThinkingBlock = patchedSetHideThinkingBlock;
		prototype.setHiddenThinkingLabel = patchedSetHiddenThinkingLabel;
	} catch (error) {
		try {
			restoreOriginalMethods();
		} catch (rollbackError) {
			throw new Error("Thinking Steps patch failed: AssistantMessageComponent prototype patching failed and rollback was incomplete.", {
				cause: { installError: error, rollbackError },
			});
		}

		throw new Error("Thinking Steps patch failed: AssistantMessageComponent prototype is incompatible with thinking-steps patching.", { cause: error });
	}

	return () => {
		restoreOriginalMethods();
	};
}

export async function retainThinkingStepsPatch(): Promise<() => Promise<void>> {
	incrementPatchRefCount();
	let cleanup = getPatchCleanup();
	if (!cleanup) {
		const existingInstallPromise = getPatchInstallPromise();
		const installPromise = existingInstallPromise ?? installPatch();
		if (!existingInstallPromise) {
			setPatchInstallPromise(installPromise);
		}

		try {
			cleanup = await installPromise;
			if (!getPatchCleanup()) {
				setPatchCleanup(cleanup);
			}
		} catch (error) {
			decrementPatchRefCount();
			throw error;
		} finally {
			if (getPatchInstallPromise() === installPromise) {
				setPatchInstallPromise(undefined);
			}
		}
	}

	let released = false;
	return async () => {
		if (released) return;

		const refCount = decrementPatchRefCount();
		if (refCount > 0) {
			released = true;
			return;
		}

		const currentCleanup = getPatchCleanup();
		if (!currentCleanup) {
			released = true;
			return;
		}

		if (getPatchCleanup() === currentCleanup) {
			setPatchCleanup(undefined);
		}

		try {
			await currentCleanup();
			released = true;
		} catch (error) {
			incrementPatchRefCount();
			if (!getPatchCleanup()) {
				setPatchCleanup(currentCleanup);
			}
			throw error;
		}
	};
}

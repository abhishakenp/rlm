/**
 * rlm-iris-always — the "Iris listens" half of Always dictation.
 *
 * Routes voice by focus state:
 * - Text field focused: the transcription is typed into the field — unless it
 *   starts with "iris", which goes to Iris instead.
 * - Not focused: Iris listens — the transcription goes to Iris.
 *
 * The `always` row does the routing against the Always daemon: it flips the
 * daemon's consume mode from focus, and the daemon pastes dictation itself. What
 * reaches `always.onTranscript` is exactly the speech meant for Iris (consume
 * mode, or a wake-word-led utterance), and this row hands each final one to Iris
 * as `iris "<words>"` — the CLI's natural-language form.
 *
 * Kept from the first version: `ears/final` + `desktop/focus` events from any
 * other voice row are still honoured, with this row typing the text itself
 * (osascript) when a field is focused — for a voice source that is not Always.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Service } from "@deepseek-ai/cordis";
import type { Always, AlwaysTranscript } from "../../always/src/index.ts";

const execFileP = promisify(execFile);

export const name = "rlm-iris-always";

export interface IrisAlwaysConfig {
	enabled?: boolean;
	/** Wake word that sends an utterance to Iris while dictating. Default "iris". */
	commandPrefix?: string;
	verbose?: boolean;
	/** The Iris CLI. Default `iris` on PATH. */
	irisBin?: string;
}

export interface RouteDecision {
	action: "type" | "command" | "ignore";
	text: string;
}

/**
 * Strip a leading wake word ("iris", "iris, …", "Iris …") the way the daemon
 * matches it (`starts_with_wake_word`): case-insensitive, then space or comma.
 */
export const stripWakeWord = (text: string, wake = "iris"): { led: boolean; rest: string } => {
	const t = text.trim();
	const w = wake.trim().toLowerCase();
	if (!w) return { led: false, rest: t };
	const lower = t.toLowerCase();
	if (lower === w) return { led: true, rest: "" };
	if (lower.startsWith(`${w} `) || lower.startsWith(`${w},`)) return { led: true, rest: t.slice(w.length + 1).trim() };
	return { led: false, rest: t };
};

/**
 * The routing rule for the legacy `ears/final` input: type when focused unless
 * wake-word-led; otherwise only wake-word-led speech runs as an Iris command.
 */
export const decide = (text: string, focused: boolean, wake = "iris"): RouteDecision => {
	const { led, rest } = stripWakeWord(text, wake);
	if (!text.trim()) return { action: "ignore", text: "" };
	if (focused && !led) return { action: "type", text: text.trim() };
	if (led && rest) return { action: "command", text: rest };
	return { action: "ignore", text: "" };
};

declare module "@deepseek-ai/cordis" {
	interface Context {
		alwaysMode: IrisAlways;
	}
	interface Events {
		"always-mode/changed"(detail: { focused: boolean; action: string }): void;
	}
}

export class IrisAlways extends Service {
	static inject = ["always"] as const;
	static provide = "alwaysMode" as const;

	declare config: IrisAlwaysConfig;
	private isEditable = false;

	constructor(ctx: any, config: IrisAlwaysConfig = {}) {
		super(ctx, undefined as any);
		this.config = config ?? {};
	}

	private get enabled(): boolean {
		return this.config.enabled ?? true;
	}

	private get wake(): string {
		return (this.config.commandPrefix ?? "iris").trim();
	}

	[Service.init]() {
		const ctx = this.ctx as any;
		const always = ctx.always as Always | undefined;
		// Everything below is unsubscribed by the fiber's disposer — the only
		// cleanup Cordis runs. Handlers call methods by name, so a hot patch of
		// this class applies to them.
		const offs: Array<() => void> = [];
		if (always) {
			offs.push(always.onTranscript((t) => void this.fromAlways(t)));
			offs.push(
				always.onFocusChange((s) => {
					this.isEditable = s.editable;
					ctx.emit?.("always-mode/changed", { focused: s.editable, action: "focus" });
				}),
			);
		}
		offs.push(
			ctx.on("desktop/focus", (editable: boolean) => {
				this.isEditable = !!editable;
				ctx.emit?.("always-mode/changed", { focused: !!editable, action: "focus" });
			}),
		);
		offs.push(ctx.on("ears/final", (text: string) => void this.fromEars(text)));
		ctx.effect(() => () => {
			for (const off of offs.splice(0)) {
				try {
					off();
				} catch {
					/* already gone */
				}
			}
		});
	}

	/** Speech the Always row routed to Iris. Partials are previews; act on finals. */
	async fromAlways(t: AlwaysTranscript): Promise<void> {
		if (!this.enabled || t.partial) return;
		const { rest } = stripWakeWord(t.text, this.wake);
		if (!rest) return;
		(this.ctx as any).emit?.("always-mode/changed", { focused: this.isEditable, action: "command" });
		await this.runIris(rest);
	}

	/** Legacy input: a transcript from a voice row that is not Always. */
	async fromEars(text: string): Promise<void> {
		if (!this.enabled || !text?.trim()) return;
		const d = decide(text, this.isEditable, this.wake);
		if (d.action === "ignore") return;
		(this.ctx as any).emit?.("always-mode/changed", { focused: this.isEditable, action: d.action });
		if (d.action === "type") await this.typeText(d.text);
		else await this.runIris(d.text);
	}

	async typeText(text: string): Promise<void> {
		// Escape for an AppleScript string literal: backslashes first, then quotes.
		const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		try {
			await execFileP("osascript", ["-e", `tell application "System Events" to keystroke "${escaped}"`]);
		} catch (err) {
			this.log("typeText failed", err);
		}
	}

	/** `iris "<words>"` — argv, never a shell, so the words cannot run as commands. */
	async runIris(words: string): Promise<void> {
		try {
			await execFileP(this.config.irisBin ?? "iris", [words], { timeout: 120_000 });
		} catch (err) {
			this.log(`iris "${words}" failed`, err);
		}
	}

	private log(msg: string, err: unknown): void {
		if (this.config.verbose) (this.ctx as any).logger?.error?.(`[rlm-iris-always] ${msg}: ${(err as Error)?.message ?? err}`);
	}
}

/** The first version exported this name; kept for anything that imported it. */
export { IrisAlways as AlwaysService };
export default IrisAlways;

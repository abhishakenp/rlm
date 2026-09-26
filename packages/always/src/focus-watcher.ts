/**
 * FocusWatcher — the system-wide "is an editable text field focused?" signal,
 * from the `focused-editable --watch` Swift helper (newline-delimited JSON).
 * Port of old Iris's main/focus-watcher.js.
 *
 * This is the switch between dictation and Iris: an editable field focused →
 * Always dictates natively (consume OFF); nothing editable → speech goes to
 * Iris (consume ON). Deduped on the routing-relevant fields so a busy stream
 * never re-fires the toggle for a no-op. bundleId is part of the key: the same
 * editable state in a different app can flip routing via the per-app whitelist.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const defaultFocusBin = (): string =>
	process.env.FOCUSED_EDITABLE_BIN ?? join(homedir(), "proj", "sensei", "iris-sama", "iris", "scripts", "focused-editable");

export interface FocusState {
	editable: boolean;
	secure: boolean;
	trusted: boolean;
	bundleId: string;
	role: string;
	subrole: string;
	reason: string;
}

export interface FocusWatcherOptions {
	binPath?: string;
	intervalMs?: number;
	onChange?: (state: FocusState) => void;
	onError?: (err: Error) => void;
}

export class FocusWatcher {
	binPath: string;
	intervalMs: number;
	onChange: (state: FocusState) => void;
	onError: (err: Error) => void;
	private proc: ChildProcess | null = null;
	private buf = "";
	private lastKey: string | null = null;
	private running = false;
	private respawn: ReturnType<typeof setTimeout> | null = null;

	constructor(opts: FocusWatcherOptions = {}) {
		this.binPath = opts.binPath ?? defaultFocusBin();
		this.intervalMs = Math.max(80, Math.trunc(opts.intervalMs ?? 300));
		this.onChange = opts.onChange ?? (() => {});
		this.onError = opts.onError ?? (() => {});
	}

	start(): void {
		if (this.running) return;
		if (!existsSync(this.binPath)) {
			this.onError(new Error(`focused-editable not found at ${this.binPath}`));
			return;
		}
		this.running = true;
		this.spawnHelper();
	}

	private spawnHelper(): void {
		if (!this.running) return;
		let proc: ChildProcess;
		try {
			proc = spawn(this.binPath, ["--watch", String(this.intervalMs)], { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			this.onError(err as Error);
			return;
		}
		this.proc = proc;
		this.buf = "";
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
		proc.stderr?.on("data", () => {
			/* the helper is quiet on stderr */
		});
		proc.on("error", (err) => this.onError(err));
		proc.on("close", () => {
			if (this.proc === proc) this.proc = null;
			// Crash or Accessibility revoked: respawn so the signal self-heals.
			if (this.running) this.respawn = setTimeout(() => this.spawnHelper(), 1000);
		});
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) !== -1) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (line) this.handleLine(line);
		}
	}

	/** Visible for tests: one line of helper output. */
	handleLine(line: string): void {
		let s: Record<string, unknown>;
		try {
			s = JSON.parse(line);
		} catch {
			return; // partial/garbled frame
		}
		const bundleId = String(s.bundleId ?? "");
		const key = `${!!s.editable}|${!!s.secure}|${!!s.trusted}|${bundleId}`;
		if (key === this.lastKey) return;
		this.lastKey = key;
		this.onChange({
			editable: !!s.editable,
			secure: !!s.secure,
			trusted: !!s.trusted,
			bundleId,
			role: String(s.role ?? ""),
			subrole: String(s.subrole ?? ""),
			reason: String(s.reason ?? ""),
		});
	}

	stop(): void {
		this.running = false;
		if (this.respawn) {
			clearTimeout(this.respawn);
			this.respawn = null;
		}
		if (this.proc) {
			try {
				this.proc.kill("SIGTERM");
			} catch {
				/* noop */
			}
			this.proc = null;
		}
		this.lastKey = null;
		this.buf = "";
	}
}

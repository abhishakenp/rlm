/**
 * The `always` CLI: status, and bringing the daemon up cooperatively without
 * fighting the Always GUI that owns it. Port of old Iris's always-stream.js
 * helpers (daemonRunning / streamEnabled / ensureAlwaysReady / alwaysStatus).
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { socketPath } from "./event-client.ts";

const execFileAsync = promisify(execFile);

/** The `always` CLI. Override with ALWAYS_CLI (tests). */
export const alwaysCli = (): string => process.env.ALWAYS_CLI ?? join(homedir(), ".cargo", "bin", "always");

export const daemonRunning = async (): Promise<boolean> => {
	try {
		const { stdout } = await execFileAsync(alwaysCli(), ["status"], { timeout: 5000 });
		return /running|active|pid/i.test(stdout) && !/not\s+running|stopped/i.test(stdout);
	} catch {
		return false;
	}
};

/** `always start` fully detached, so the daemon outlives whoever called us. A no-op when one is up. */
export const startDaemonDetached = (): void => {
	try {
		spawn(alwaysCli(), ["start"], { detached: true, stdio: "ignore" }).unref();
	} catch {
		/* reported by the caller's readiness check */
	}
};

const waitForDaemon = async (timeoutMs = 8000): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await daemonRunning()) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return daemonRunning();
};

export interface AlwaysReady {
	ok: boolean;
	installed: boolean;
	running?: boolean;
	error?: string;
}

/**
 * Make sure the CLI is installed and a daemon is up. The UDS event stream needs
 * no `transcript_stream` flag (that was old Iris's file tail), so unlike the
 * original this never stops a running daemon.
 */
export const ensureAlwaysReady = async (): Promise<AlwaysReady> => {
	const cli = alwaysCli();
	if (!existsSync(cli)) return { ok: false, installed: false, error: `Always CLI not found at ${cli}` };
	if (await daemonRunning()) return { ok: true, installed: true, running: true };
	startDaemonDetached();
	const running = await waitForDaemon();
	return { ok: running, installed: true, running };
};

export const alwaysStatus = async (): Promise<{ installed: boolean; running: boolean; socketPath: string }> => {
	const installed = existsSync(alwaysCli());
	return { installed, running: installed ? await daemonRunning() : false, socketPath: socketPath() };
};

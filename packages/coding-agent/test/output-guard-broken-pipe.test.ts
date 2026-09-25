import { afterEach, describe, expect, it, vi } from "vitest";
import {
	flushRawStdout,
	isStdoutTakenOver,
	restoreStdout,
	takeOverStdout,
	writeRawStdout,
} from "../src/core/output-guard.js";

/**
 * A broken pipe is what `pi -p "…" | head -1` produces as a matter of course:
 * the reader closes and every subsequent write is undeliverable. Production
 * logs recorded that as a process-level uncaughtException
 * ("EPIPE: broken pipe, write" at output-guard writeRawStdout → print-mode
 * runPrintModeWithConnectionInternal), which is a host crash caused by output
 * nobody was going to read. These tests pin the containment, in both spellings
 * the runtimes use, and pin that non-EPIPE faults still propagate.
 */

/** Bun throws this shape synchronously out of the write call itself. */
function bunBrokenPipe(): Error {
	return new Error("EPIPE: broken pipe, write");
}

/** Node reports this shape, carrying an errno code. */
function nodeBrokenPipe(): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error("write EPIPE");
	error.code = "EPIPE";
	return error;
}

type WriteArgs = [string, ((error?: Error | null) => void)?];

function stubStdoutWrite(impl: (...args: WriteArgs) => boolean) {
	return vi.spyOn(process.stdout, "write").mockImplementation(impl as never);
}

function stubStderrWrite(impl: (...args: WriteArgs) => boolean) {
	return vi.spyOn(process.stderr, "write").mockImplementation(impl as never);
}

afterEach(() => {
	restoreStdout();
	vi.restoreAllMocks();
});

describe("output-guard broken pipe containment", () => {
	it("swallows a synchronously thrown Bun-shape EPIPE from writeRawStdout", () => {
		stubStdoutWrite(() => {
			throw bunBrokenPipe();
		});

		expect(() => writeRawStdout("hello\n")).not.toThrow();
	});

	it("swallows a synchronously thrown Node-shape EPIPE from writeRawStdout", () => {
		stubStdoutWrite(() => {
			throw nodeBrokenPipe();
		});

		expect(() => writeRawStdout("hello\n")).not.toThrow();
	});

	it("still propagates a write failure that is not a broken pipe", () => {
		stubStdoutWrite(() => {
			throw new Error("ENOSPC: no space left on device, write");
		});

		expect(() => writeRawStdout("hello\n")).toThrow(/ENOSPC/);
	});

	it("resolves flushRawStdout when the flush write reports EPIPE", async () => {
		stubStdoutWrite((_chunk, callback) => {
			callback?.(nodeBrokenPipe());
			return true;
		});

		await expect(flushRawStdout()).resolves.toBeUndefined();
	});

	it("resolves flushRawStdout when the flush write throws EPIPE synchronously", async () => {
		stubStdoutWrite(() => {
			throw bunBrokenPipe();
		});

		await expect(flushRawStdout()).resolves.toBeUndefined();
	});

	it("still rejects flushRawStdout on a failure that is not a broken pipe", async () => {
		stubStdoutWrite((_chunk, callback) => {
			callback?.(new Error("EACCES: permission denied, write"));
			return true;
		});

		await expect(flushRawStdout()).rejects.toThrow(/EACCES/);
	});

	it("swallows EPIPE written through the stdout takeover shim", () => {
		stubStderrWrite(() => {
			throw bunBrokenPipe();
		});
		takeOverStdout();

		expect(isStdoutTakenOver()).toBe(true);
		expect(() => process.stdout.write("redirected\n")).not.toThrow();
	});

	it("swallows EPIPE written straight to stderr once stdout is taken over", () => {
		stubStderrWrite(() => {
			throw nodeBrokenPipe();
		});
		takeOverStdout();

		// console.error lands on process.stderr.write, bypassing the stdout
		// shim — it is the path print mode uses for every diagnostic. The call
		// is made directly here because vitest replaces console.* to capture
		// output, so going through console would never reach the stream.
		expect(() => process.stderr.write("diagnostic\n")).not.toThrow();
	});

	it("restores both stdout and stderr writers", () => {
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;

		takeOverStdout();
		expect(process.stdout.write).not.toBe(originalStdoutWrite);
		expect(process.stderr.write).not.toBe(originalStderrWrite);

		restoreStdout();
		expect(process.stdout.write).toBe(originalStdoutWrite);
		expect(process.stderr.write).toBe(originalStderrWrite);
		expect(isStdoutTakenOver()).toBe(false);
	});
});

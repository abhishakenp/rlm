interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
	originalStderrWrite: typeof process.stderr.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

/**
 * True when an error means the pipe on the other end went away.
 *
 * A broken pipe is not a fault in this process and there is nothing to retry:
 * the reader closed, so the bytes are undeliverable no matter what we do. It is
 * also entirely routine — `pi -p "…" | head -1` closes the pipe the moment head
 * has its line, and every headless caller that reads a bounded prefix of our
 * output does the same. The runtimes we run under spell it three different
 * ways: Node reports an `EPIPE` ErrnoException on the async write callback and
 * on the stream ("write EPIPE"), Bun throws "EPIPE: broken pipe, write"
 * synchronously out of the write call itself, and a stream torn down mid-write
 * raises ERR_STREAM_DESTROYED instead. All three mean "the reader is gone", and
 * none of them may reach the process-level uncaughtException handler and take
 * the host down over output nobody was going to read.
 */
function isBrokenPipe(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return true;
	const message = error instanceof Error ? error.message : "";
	return message.includes("EPIPE") || message.includes("broken pipe");
}

/**
 * Streams already taught to survive a broken pipe.
 *
 * Guarding the write *call* is not enough on Node: the call returns cleanly and
 * the EPIPE arrives later on the stream, and a stream with no "error" listener
 * re-raises that as an uncaughtException. One lazily installed listener per
 * stream closes that path. It swallows only broken pipes and re-raises anything
 * else exactly as before, so this does not become a place where real stream
 * faults go to die.
 */
const brokenPipeTolerated = new WeakSet<object>();

function tolerateBrokenPipe(stream: NodeJS.WriteStream): void {
	if (brokenPipeTolerated.has(stream)) return;
	brokenPipeTolerated.add(stream);
	stream.on("error", (error: unknown) => {
		if (isBrokenPipe(error)) return;
		throw error;
	});
}

/**
 * Perform a write that cannot fail on a dead pipe.
 *
 * Reports success when the bytes were accepted *or* were dropped because the
 * reader is gone — to the caller those are the same outcome, since neither
 * leaves anything to do. The callback is always invoked without an error for a
 * broken pipe, so a caller awaiting a flush completes instead of hanging on, or
 * rejecting from, a pipe nobody is reading.
 */
function writeTolerantly(
	write: (chunk: string, callback?: (error?: Error | null) => void) => boolean,
	chunk: string,
	callback?: (error?: Error | null) => void,
): boolean {
	try {
		return write(chunk, (error) => {
			if (error && !isBrokenPipe(error)) {
				callback?.(error);
				return;
			}
			callback?.();
		});
	} catch (error) {
		if (!isBrokenPipe(error)) throw error;
		callback?.();
		return true;
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	tolerateBrokenPipe(process.stdout);
	tolerateBrokenPipe(process.stderr);

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;

	const toStderr = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return writeTolerantly(rawStderrWrite, String(chunk), encodingOrCallback);
		}
		return writeTolerantly(rawStderrWrite, String(chunk), callback);
	}) as typeof process.stdout.write;

	process.stdout.write = toStderr;

	// console.error, and everything else that reaches for stderr directly,
	// bypasses the stdout shim above and so needs the same guard: under Bun a
	// broken pipe throws straight out of process.stderr.write, which is how a
	// routine `pi -p … | head` became a process-level uncaughtException.
	process.stderr.write = toStderr as typeof process.stderr.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
		originalStderrWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	process.stderr.write = stdoutTakeoverState.originalStderrWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (stdoutTakeoverState) {
		writeTolerantly(stdoutTakeoverState.rawStdoutWrite, text);
		return;
	}
	tolerateBrokenPipe(process.stdout);
	writeTolerantly((chunk, callback) => process.stdout.write(chunk, callback), text);
}

export async function flushRawStdout(): Promise<void> {
	if (stdoutTakeoverState) {
		const rawStdoutWrite = stdoutTakeoverState.rawStdoutWrite;
		await new Promise<void>((resolve, reject) => {
			writeTolerantly(rawStdoutWrite, "", (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		return;
	}

	tolerateBrokenPipe(process.stdout);
	await new Promise<void>((resolve, reject) => {
		writeTolerantly(
			(chunk, callback) => process.stdout.write(chunk, callback),
			"",
			(err) => {
				if (err) reject(err);
				else resolve();
			},
		);
	});
}

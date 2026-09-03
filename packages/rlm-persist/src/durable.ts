/**
 * The persistence seam — every durable write in rlm goes through here.
 *
 * ## Why this exists
 *
 * `writeFileSync(path, JSON.stringify(doc))` re-encodes twice. `JSON.stringify`
 * builds a JS string, and because a real document contains one non-ASCII
 * character V8 stores that string as UTF-16 — two bytes per character. `fs`
 * then encodes it a second time into a UTF-8 Buffer. Measured on the live
 * 384,666-byte `lull.json`: a 751 KB string plus a 376 KB buffer, 1.1 MB of
 * transient allocation and 2.3 MB of RSS movement, to persist 376 KB. Every
 * time. Restating a whole document to record one change is the cost, and the
 * fix is to stop restating whole documents — not to stream the restatement.
 * Streaming it was measured too, and it is slower and no cheaper (see below).
 *
 * ## The three primitives, and why they are these three
 *
 * `appendLine` — one held file descriptor per path, `writeSync`, no buffering.
 *   0.007 ms and no measurable allocation, against 1.88 ms and 1.5 MB for a
 *   full rewrite.
 *
 * `writeAtomic` — tmp file, chunked `writeSync`, `fsync`, `rename`. For the
 *   cases that genuinely must restate everything, which after this change means
 *   compaction and nothing else.
 *
 * `DeltaLog` — a snapshot plus an append-only log of changes since it, with
 *   compaction. This is the one that turns O(document) into O(change).
 *
 * ## Why `writeSync` on a held fd and not `createWriteStream`
 *
 * Both were measured; the stream is marginally cheaper per call. It is still
 * the wrong primitive here, for two reasons that are not about speed.
 *
 * A stream buffers in userspace. `appendFileSync` returns with the bytes in the
 * kernel, where another process — or another reader in this one — can see them
 * and a hard exit cannot lose them. `packages/rlm-delegate/src/store.ts` is
 * built on exactly that property: "a process that dies halfway through a graph
 * loses at most the line it was writing". A buffered stream loses everything
 * still in the buffer, and `Store.load()` re-reading a file this process has
 * just written would not see its own writes. `writeSync` on a held fd keeps the
 * synchronous durability and still drops the open/close pair per line.
 *
 * And a stream cannot do an atomic replace at all. `createWriteStream` is
 * asynchronous, so at the instant the last `write()` returns the file may not
 * exist yet; `renameSync` after it throws ENOENT. Verified, not reasoned:
 * that is the literal first error this module's benchmark produced. Every
 * caller here is synchronous — `save()` is called from a Cordis disposer and
 * from other plugins' dispatch, where there is nobody to await — so an async
 * write path would have to either drop the atomicity or drop the callers.
 *
 * ## Holding a descriptor open is not free of hazards
 *
 * A held fd follows the inode, not the name. Rename the file, unlink it, and
 * the writes keep succeeding into something nobody can read. Two defences:
 * a caller that is about to rename or delete calls `closeAppend` first (this
 * is the honest one), and every handle re-checks the inode behind its path
 * every `REVALIDATE_MS` in case somebody outside the process moved it.
 */
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** How stale an inode check may be before the next append re-does it. */
const REVALIDATE_MS = 1000;

/**
 * The pool lives on `globalThis`, not in a module closure.
 *
 * A hot reload replaces the module. A pool held in module scope would leave the
 * old module's descriptors open with nothing able to reach them, and the new
 * module would open a second descriptor onto the same file — a leak and a
 * double writer from one edit. The kernel's own advice, generalised: anything
 * that must outlive the code that made it has to be durably referenced.
 */
const POOL_KEY = "__rlmDurableAppendPool";

/**
 * How much scratch space one append path keeps. Measured, on 20,000 real
 * journal-shaped lines:
 *
 * | approach                          | us/line | heap peak |
 * |-----------------------------------|---------|-----------|
 * | createWriteStream, hwm 4          |  14.17  | +1.14 MB  |
 * | createWriteStream, hwm 65536      |   0.45  | +0.84 MB  |
 * | raw fd + one reused 4 KB buffer   |   0.76  | +0.09 MB  |
 * | raw fd + one reused 64 KB buffer  |   0.46  | +0.02 MB  |
 *
 * Two things fall out of that. A small watermark is the worst of every world —
 * a stream allocates a Buffer per `write()` whatever the watermark is, so 4
 * bytes is 31x slower than 64 KB *and* uses more heap. And the saving is
 * reuse, not size: one buffer written into and flushed costs 40x less heap
 * than the stream at identical speed. 4 KB is the default because a headless
 * child is being measured on residency; 64 KB is for the paths that write
 * constantly and can afford sixteen times the resident scratch to halve the
 * per-line cost.
 */
export const DEFAULT_APPEND_BYTES = 4096;
export const HOT_APPEND_BYTES = 65536;

interface Handle {
	fd: number;
	path: string;
	/** Identity of the inode this fd is attached to, to notice a swap. */
	dev: number;
	ino: number;
	/** Bytes in the file as of the last write, so callers need no `statSync`. */
	size: number;
	checkedAt: number;
	/**
	 * One buffer, written into and flushed, for the life of the descriptor.
	 *
	 * This is the whole memory story of the append path. `writeSync(fd, string)`
	 * looks allocation-free and is not: node encodes the string into a fresh
	 * Buffer on every call, which is the same per-write allocation a stream
	 * makes. Encoding into a buffer that already exists makes the steady state
	 * genuinely zero-allocation — the resident cost is this buffer and nothing
	 * else, however many lines go through it.
	 */
	buf: Buffer;
}

const pool = (): Map<string, Handle> => {
	const g = globalThis as Record<string, unknown>;
	if (!(g[POOL_KEY] instanceof Map)) g[POOL_KEY] = new Map<string, Handle>();
	return g[POOL_KEY] as Map<string, Handle>;
};

/**
 * Open one, healing a torn tail first.
 *
 * A crash can leave a line without its newline. The next append would run onto
 * the end of it and take a second record down with the first, which turns one
 * lost entry into two. `rlm-delegate`'s store discovered this and healed it by
 * hand; doing it here means every caller gets it, including the ones that have
 * not been bitten yet.
 */
const open = (path: string, bufferBytes: number): Handle => {
	mkdirSync(dirname(path), { recursive: true });
	let size = 0;
	try {
		size = statSync(path).size;
		if (size > 0) {
			const fd = openSync(path, "r");
			try {
				const last = Buffer.alloc(1);
				// One byte, at the end. Reading the file to look at its last
				// character is how this check used to cost a megabyte.
				const read = readSync(fd, last, 0, 1, size - 1);
				if (read === 1 && last[0] !== 0x0a) {
					const afd = openSync(path, "a");
					try {
						writeSync(afd, "\n");
						size += 1;
					} finally {
						closeSync(afd);
					}
				}
			} finally {
				closeSync(fd);
			}
		}
	} catch {
		/* the file does not exist yet, which is the normal case */
	}
	const fd = openSync(path, "a");
	const st = fstatSync(fd);
	return {
		fd,
		path,
		dev: st.dev,
		ino: st.ino,
		size: st.size,
		checkedAt: Date.now(),
		buf: Buffer.allocUnsafe(Math.max(256, bufferBytes)),
	};
};

/**
 * The handle for a path, reopening it if the name now points somewhere else.
 *
 * Cheap by design: an inode check is a syscall, and doing one per append would
 * give back most of what holding the descriptor bought. Once a second is enough
 * to notice a log rotation or an `rm` done from outside this process, and the
 * callers that rotate or delete deliberately call `closeAppend` and do not rely
 * on this at all.
 */
const handleFor = (path: string, bufferBytes: number): Handle => {
	const p = pool();
	let h = p.get(path);
	if (h) {
		const now = Date.now();
		if (now - h.checkedAt >= REVALIDATE_MS) {
			h.checkedAt = now;
			let swapped = false;
			try {
				const st = statSync(path);
				swapped = st.dev !== h.dev || st.ino !== h.ino;
			} catch {
				swapped = true; // the name is gone; our fd points at an orphan
			}
			if (swapped) {
				try {
					closeSync(h.fd);
				} catch {}
				p.delete(path);
				h = undefined;
			}
		}
	}
	if (!h) {
		h = open(path, bufferBytes);
		p.set(path, h);
	}
	return h;
};

/**
 * Append one record. Synchronously durable, O(record), no re-encode of anything
 * but the record itself.
 *
 * Returns the file's size afterwards so a caller with a size policy — a log
 * that rotates, a delta log that compacts — needs no `statSync` per write.
 */
export const appendLine = (path: string, line: string, bufferBytes = DEFAULT_APPEND_BYTES): number => {
	const h = handleFor(path, bufferBytes);
	const newline = !line.endsWith("\n");
	// A UTF-16 code unit is at most three UTF-8 bytes (a surrogate pair is two
	// units and four bytes, so the bound holds), which makes this a length
	// comparison in the common case instead of a scan of the string.
	const certain = line.length * 3 + 1 <= h.buf.length;
	if (certain || Buffer.byteLength(line) + (newline ? 1 : 0) <= h.buf.length) {
		let off = h.buf.write(line, 0);
		if (newline) h.buf[off++] = 0x0a;
		h.size += writeSync(h.fd, h.buf, 0, off);
		return h.size;
	}
	// Longer than the scratch space. One allocation for one oversized record is
	// the right trade against sizing every buffer for the worst line anybody
	// might ever write.
	h.size += writeSync(h.fd, newline ? `${line}\n` : line);
	return h.size;
};

/** Bytes in the appended file, from the handle if we have one. */
export const appendedSize = (path: string): number => {
	const h = pool().get(path);
	if (h) return h.size;
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};

/**
 * Release the descriptor for one path.
 *
 * Call this **before** renaming, truncating or unlinking the file. A held fd
 * follows the inode: writes after a rename land in the renamed file, and writes
 * after an unlink land nowhere at all and are lost without an error.
 */
export const closeAppend = (path: string): void => {
	const p = pool();
	const h = p.get(path);
	if (!h) return;
	p.delete(path);
	try {
		closeSync(h.fd);
	} catch {}
};

/** Release every descriptor. For a disposer, or a process winding down. */
export const closeAllAppends = (): void => {
	for (const path of [...pool().keys()]) closeAppend(path);
};

/** What is currently held open, for `persist.stats` and for tests. */
export const openAppends = (): Array<{ path: string; size: number }> =>
	[...pool().values()].map((h) => ({ path: h.path, size: h.size }));

/** Largest string this module will hold at once while writing a document. */
export const CHUNK_BYTES = 65536;

/**
 * Replace a file, atomically, without ever holding the whole document.
 *
 * Stronger than the `writeFileSync(tmp, …); renameSync(tmp, dest)` it replaces:
 * that pair never calls `fsync`, so a rename can be durable while the bytes it
 * points at are not, and a power loss can leave a correctly-named empty file.
 * This fsyncs the data before the rename and fsyncs the directory after it.
 */
export const writeAtomic = (dest: string, chunks: Iterable<string>): void => {
	mkdirSync(dirname(dest), { recursive: true });
	// The scratch name carries this process's pid, and that is not cosmetic.
	// A fixed `${dest}.tmp` is shared by every writer of the same file: two
	// processes rewriting it at once truncate each other's scratch file
	// halfway through, and whichever renames second publishes a torn document.
	// Observed, not imagined — it left a 392 KB store unparseable and got a
	// perfectly good record filed as `.broken`.
	const tmp = `${dest}.tmp.${process.pid}`;
	const fd = openSync(tmp, "w");
	try {
		let buffered = "";
		for (const chunk of chunks) {
			buffered += chunk;
			if (buffered.length >= CHUNK_BYTES) {
				writeSync(fd, buffered);
				buffered = "";
			}
		}
		if (buffered) writeSync(fd, buffered);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, dest);
	// The rename itself needs to reach the disk, or a crash can lose the whole
	// replacement even though every byte of the new file was fsynced.
	try {
		const dfd = openSync(dirname(dest), "r");
		try {
			fsyncSync(dfd);
		} finally {
			closeSync(dfd);
		}
	} catch {
		/* not every filesystem lets you fsync a directory; the rename still stands */
	}
};

/**
 * A snapshot plus the changes since it.
 *
 * The whole point: recording a change costs the size of the change. The
 * document is restated only when the log of changes has grown past
 * `maxDeltaBytes`, which for a store that is written once a minute is hours
 * apart rather than every write.
 *
 * ### Why a crash cannot corrupt this
 *
 * Compaction is: write the new snapshot to a tmp file and fsync it; rename it
 * over the old one; only then discard the delta log. A crash before the rename
 * leaves the old snapshot and the whole delta log — replay is correct. A crash
 * after the rename but before the discard leaves the new snapshot and a delta
 * log whose records are already in it — replay re-applies them, which is
 * correct **provided every record is idempotent**. That is the one obligation
 * this class puts on its callers, and it is why the record vocabulary is
 * upserts and deletes keyed by identity rather than increments.
 */
export interface DeltaLogOptions {
	/** The snapshot. Keeps whatever name the store already had on disk. */
	path: string;
	/** The changes since it. Defaults to `<path>.delta`. */
	deltaPath?: string;
	/** Compact once the delta log passes this. Default 256 KB. */
	maxDeltaBytes?: number;
	/** Scratch space held for appending. See `DEFAULT_APPEND_BYTES`. */
	bufferBytes?: number;
}

export class DeltaLog<Snapshot, Record> {
	readonly path: string;
	readonly deltaPath: string;
	readonly maxDeltaBytes: number;
	readonly bufferBytes: number;

	constructor(options: DeltaLogOptions) {
		this.path = options.path;
		this.deltaPath = options.deltaPath ?? `${options.path}.delta`;
		this.maxDeltaBytes = options.maxDeltaBytes ?? 256 * 1024;
		this.bufferBytes = options.bufferBytes ?? DEFAULT_APPEND_BYTES;
	}

	/**
	 * The snapshot, and every change since it in the order they happened.
	 *
	 * A line that will not parse is skipped rather than fatal: the only line
	 * that can be malformed is one a crash interrupted, and losing the rest of
	 * the history over it would be the original bug wearing a different hat.
	 */
	read(): { snapshot: Snapshot | undefined; deltas: Record[]; brokeOn?: string } {
		let snapshot: Snapshot | undefined;
		let brokeOn: string | undefined;
		if (existsSync(this.path)) {
			try {
				snapshot = JSON.parse(readFileSync(this.path, "utf8")) as Snapshot;
			} catch (error: any) {
				brokeOn = error?.message ?? String(error);
			}
		}
		const deltas: Record[] = [];
		if (existsSync(this.deltaPath)) {
			const text = readFileSync(this.deltaPath, "utf8");
			let from = 0;
			// Indexed scan rather than split("\n"): split materialises an array
			// of every line on top of the string it already read, which for a
			// log that is about to be folded away is pure waste.
			while (from < text.length) {
				let to = text.indexOf("\n", from);
				if (to < 0) to = text.length;
				if (to > from) {
					try {
						deltas.push(JSON.parse(text.slice(from, to)) as Record);
					} catch {
						/* a torn line; everything around it still counts */
					}
				}
				from = to + 1;
			}
		}
		return { snapshot, deltas, brokeOn };
	}

	/** Record one change. Must be idempotent — see the class docblock. */
	push(record: Record): number {
		return appendLine(this.deltaPath, JSON.stringify(record), this.bufferBytes);
	}

	/**
	 * Record several changes in as few writes as the scratch buffer allows.
	 *
	 * The batch is flushed just before it could outgrow the reused buffer, so
	 * a run of small records becomes one syscall and one already-allocated
	 * buffer rather than N of each. The bound is `length * 3` because that is
	 * the most UTF-8 bytes a UTF-16 code unit can become; testing the real
	 * byte length here would scan every batch to save nothing.
	 */
	pushAll(records: Iterable<Record>): number {
		let size = appendedSize(this.deltaPath);
		const room = Math.max(64, Math.floor((this.bufferBytes - 1) / 3));
		let batch = "";
		for (const record of records) {
			const line = `${JSON.stringify(record)}\n`;
			if (batch && batch.length + line.length > room) {
				size = appendLine(this.deltaPath, batch, this.bufferBytes);
				batch = "";
			}
			batch += line;
			if (batch.length >= room) {
				size = appendLine(this.deltaPath, batch, this.bufferBytes);
				batch = "";
			}
		}
		if (batch) size = appendLine(this.deltaPath, batch, this.bufferBytes);
		return size;
	}

	get deltaBytes(): number {
		return appendedSize(this.deltaPath);
	}

	/** Whether the log of changes has grown big enough to be worth folding in. */
	get overgrown(): boolean {
		return this.deltaBytes >= this.maxDeltaBytes;
	}

	/**
	 * Fold the changes into the snapshot and start a fresh log.
	 *
	 * `chunks` yields the new snapshot in pieces so no caller has to build the
	 * whole document as one string. Order is load-bearing: snapshot first, log
	 * discarded second. See the class docblock for what each crash window costs.
	 */
	compact(chunks: Iterable<string>): void {
		writeAtomic(this.path, chunks);
		closeAppend(this.deltaPath);
		// Truncate rather than unlink: `openSync(path, "w")` leaves a zero-length
		// file where an unlink would leave a hole another reader could trip on.
		try {
			closeSync(openSync(this.deltaPath, "w"));
		} catch {}
	}

	/** Let go of the descriptor. For a plugin disposer. */
	close(): void {
		closeAppend(this.deltaPath);
	}
}

/**
 * Serialise a value as chunks, never building more than `CHUNK_BYTES` at once.
 *
 * Arrays are emitted element by element, which is what bounds the peak: the
 * largest string that exists at any moment is one batch plus one element,
 * rather than the whole document.
 */
export function* jsonChunks(value: unknown): Generator<string> {
	if (Array.isArray(value)) {
		yield "[";
		for (let i = 0; i < value.length; i++) {
			if (i) yield ",";
			yield JSON.stringify(value[i]) ?? "null";
		}
		yield "]";
		return;
	}
	if (value && typeof value === "object") {
		yield "{";
		let first = true;
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (v === undefined) continue;
			if (!first) yield ",";
			first = false;
			yield `${JSON.stringify(k)}:`;
			yield* jsonChunks(v);
		}
		yield "}";
		return;
	}
	yield JSON.stringify(value) ?? "null";
}

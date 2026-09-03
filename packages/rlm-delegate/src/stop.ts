/**
 * How this thing is stopped.
 *
 * The drive works a backlog unattended, on his laptop, through an agent that
 * spawns processes and writes files. Something that does that has to be
 * stoppable by somebody who is annoyed, not at a terminal, and not interested
 * in reading documentation first. So the stop is a **file**, and creating it by
 * any means — a command, dragging something onto the Desktop, `touch` — has the
 * same effect. That is `@iris/autonomy`'s design and it is copied here on
 * purpose, down to where the file lives.
 *
 * Three files stop it, and the second is the interesting one:
 *
 *   ~/Desktop/.rlm-drive-off      this drive
 *   ~/Desktop/.iris-autonomy-off  Iris's own kill switch
 *   <delegate dir>/STOP           for a caller with no Desktop
 *
 * Iris's switch counts because the honest question is not "who owns this
 * process" but "did he say stop". A person who puts the stop file on the
 * Desktop at three in the morning means *stop*, and a second daemon carrying on
 * because it was written by somebody else is exactly the behaviour that makes a
 * kill switch worthless. It is one-way: the drive honours Iris's file, and
 * never writes it.
 *
 * Checked with `existsSync` at every decision and never cached, because a
 * cached kill switch is not a kill switch.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DESKTOP_STOP = join(homedir(), "Desktop", ".rlm-drive-off");
export const IRIS_STOP = join(homedir(), "Desktop", ".iris-autonomy-off");

export interface StopOptions {
	/** The file this drive writes and honours. */
	file?: string;
	/** Others that stop it but that it never writes. Iris's, by default. */
	alsoHonour?: string[];
	/** An abort signal, for a caller stopping it in process. */
	signal?: AbortSignal;
}

export class Stop {
	readonly file: string;
	readonly honoured: string[];
	private readonly signal?: AbortSignal;

	constructor(options: StopOptions = {}) {
		this.file = options.file ?? DESKTOP_STOP;
		this.honoured = options.alsoHonour ?? [IRIS_STOP];
		this.signal = options.signal;
	}

	/** Why it should stop, right now, or null. Never cached. */
	reason(): string | null {
		if (this.signal?.aborted) return "the caller stopped it";
		for (const path of [this.file, ...this.honoured]) {
			try {
				if (existsSync(path)) return `${path} is there — delete it to resume`;
			} catch {
				/* an unreadable Desktop is not a reason to keep going, or to crash */
			}
		}
		return null;
	}

	stopped(): boolean {
		return this.reason() !== null;
	}

	/** Put the file there. This is what the command does. */
	raise(why = "stopped by hand"): string {
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, `${new Date().toISOString()} ${why}\n`, "utf8");
		return this.file;
	}

	/** Take only our own file away. Iris's is hers. */
	lower(): boolean {
		if (!existsSync(this.file)) return false;
		rmSync(this.file, { force: true });
		return true;
	}
}

/**
 * One budget, shared by every graph being worked at once.
 *
 * `concurrency` in the scheduler caps a single graph. Six owed graphs of two
 * tasks each, each capped at two, is twelve agents on a laptop that measured
 * room for two — the cap has to be across all of them or it is not a cap. The
 * size is re-read live, because the machine changes while somebody is using it.
 *
 * ## The wedge this shape used to produce
 *
 * The previous version woke waiters from exactly two places, and between them
 * they did not cover the queue:
 *
 *   - `give()` woke **one** waiter, and only if `held < size()` was true at
 *     that instant.
 *   - each waiter polled on its own, and only for `held === 0`.
 *
 * Neither fires in the one state the drive reaches constantly. `capacity()`
 * returns 0 whenever any signal is under its 30% floor, which is routine while
 * the fleet is working. So: a long delegation holds a slot, capacity dips to
 * zero, a short task finishes *during the dip* — `give()` computes
 * `held(1) < size(0)`, which is false, and wakes nobody — and then capacity
 * recovers. Now there is obviously room (`held` 1, `size` 2) and a queue of
 * tasks that will never be woken: `give()` is not called again because the long
 * task is still running, and the self-poll is looking for `held === 0`, which
 * never comes.
 *
 * Nothing is in flight anywhere and every event loop is idle, so from outside
 * it is indistinguishable from work. Measured on the live fleet: 26 sweeps
 * killed at `rc=124` by the external `timeout 3600`, the drive at 0.0% CPU,
 * the journal unwritten for 21 minutes, and the pool's own per-task bound never
 * armed — because the task never got past this gate to reach the pool at all.
 * `/tmp/wedge/gate-lostwake.ts` reproduces it in eight seconds.
 *
 * ## Why this version cannot do that
 *
 * There is one admission test, `room()`, and every path that could make it
 * true re-runs `drain()`, which admits as many waiters as there is room for
 * rather than one. A release drains. A newly queued waiter drains. And while
 * anybody is waiting, a single shared timer drains, testing the same `room()`
 * that `take()` tests rather than a narrower proxy for it — so "capacity came
 * back" needs nothing to have happened at the same moment to be noticed.
 *
 * Two smaller repairs come with it, both of which were live defects:
 *
 *   - The slot is charged in `drain()`, at the moment of admission, instead of
 *     in the woken waiter's continuation. In between those two points `held`
 *     read low, so a second waker could admit against room that was already
 *     spoken for.
 *   - A woken waiter is taken out of the queue when it is woken. It used to
 *     stay in, so a later `give()` could `shift()` a waiter that had already
 *     been resolved by its own poll and hand the slot to nobody — a lost
 *     wakeup with the queue still full behind it.
 *
 * The fast path also yields to the queue rather than barging past it, which is
 * the first-in-first-executed order the capacity rule says it keeps.
 */
export class Gate {
	private held = 0;
	private readonly waiting: Array<{ wake: () => void; settled: boolean }> = [];
	private readonly size: () => number;
	/** Runs only while somebody is waiting. See `watch`. */
	private pump?: ReturnType<typeof setInterval>;

	constructor(size: () => number) {
		this.size = size;
	}

	/**
	 * The one admission test.
	 *
	 * `Math.max(0, …)` and not `Math.max(1, …)`: zero means zero. That used to
	 * be clamped to one here, which let a machine with nothing spare keep one
	 * child running for ever — the same hardcoded "one at a time" the capacity
	 * rule was written to remove, sitting one layer below it and quietly
	 * overruling the measurement.
	 */
	private room(): boolean {
		return this.held < Math.max(0, this.size());
	}

	/**
	 * Admit everyone there is room for, right now.
	 *
	 * Called from every place that can change the answer to `room()`. The slot
	 * is charged here rather than in the woken waiter, so a second pass through
	 * this loop cannot hand out room the first pass already promised.
	 */
	private drain(): void {
		// Anyone who gave up waiting is dropped before room is counted out, so a
		// queue of abandoned waiters cannot hold the pump open or be mistaken
		// for work.
		if (this.waiting.some((w) => w.settled)) {
			const live = this.waiting.filter((w) => !w.settled);
			this.waiting.length = 0;
			this.waiting.push(...live);
		}
		while (this.waiting.length && this.room()) {
			const waiter = this.waiting.shift();
			if (!waiter || waiter.settled) continue; // a corpse costs no room
			waiter.settled = true;
			this.held += 1;
			waiter.wake();
		}
		this.watch();
	}

	/**
	 * Keep re-testing `room()` while anybody is waiting, and not otherwise.
	 *
	 * `size()` is a live measurement of the machine: it can start saying yes
	 * without anything happening in this process, so something has to look. One
	 * timer for the whole gate rather than one per waiter, stopped the moment
	 * the queue empties, and `unref`'d so it can never be the reason a process
	 * stays up.
	 */
	private watch(): void {
		if (!this.waiting.length) {
			if (this.pump) {
				clearInterval(this.pump);
				this.pump = undefined;
			}
			return;
		}
		if (this.pump) return;
		this.pump = setInterval(() => this.drain(), 250);
		this.pump.unref?.();
	}

	/** A release that counts once, however many times it is called. */
	private releaser(): () => void {
		let given = false;
		return () => {
			if (given) return;
			given = true;
			this.held = Math.max(0, this.held - 1);
			this.drain();
		};
	}

	/**
	 * A slot, and the function that gives it back.
	 *
	 * The signal is what makes a stop able to reach a task that is *queued*
	 * rather than running. Without it, aborting the drive unwinds everything
	 * that is watching the signal and leaves everything waiting here exactly
	 * where it was — so a sweep that had decided to end could not, and the only
	 * thing left that could end it was killing the process.
	 *
	 * An abandoned wait resolves with a release that does nothing, rather than
	 * throwing, because the caller's very next line already asks whether it was
	 * stopped and does the right thing. A rejection here would instead travel
	 * out through the scheduler as a task failure and charge an attempt for work
	 * that was never handed to anybody.
	 */
	async take(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return () => {};
		// Yield to anybody already queued: a newcomer taking the slot a waiter
		// has been waiting for is how the queue stops keeping its order.
		if (!this.waiting.length && this.room()) {
			this.held += 1;
			return this.releaser();
		}
		const waiter = { wake: () => {}, settled: false };
		let admitted = false;
		let unlisten = () => {};
		await new Promise<void>((resolve) => {
			waiter.wake = () => {
				admitted = true;
				resolve();
			};
			const abandon = () => {
				// `settled` is what stops `drain` charging a slot to somebody who
				// is no longer going to use it.
				if (waiter.settled) return;
				waiter.settled = true;
				resolve();
			};
			if (signal) {
				signal.addEventListener("abort", abandon, { once: true });
				unlisten = () => signal.removeEventListener("abort", abandon);
			}
			this.waiting.push(waiter);
			// The queue may be stale — every entry ahead of this one already
			// woken — in which case there is room for this one immediately.
			this.drain();
		});
		unlisten();
		// `drain` charged the slot on this waiter's behalf, if it got one.
		return admitted ? this.releaser() : () => {};
	}

	get inFlight(): number {
		return this.held;
	}

	/** Waiters that still want a slot. Anyone who gave up is not one. */
	get queued(): number {
		return this.waiting.reduce((n, w) => n + (w.settled ? 0 : 1), 0);
	}
}

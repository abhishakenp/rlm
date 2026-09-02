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
 * size is re-read on every release, because the machine changes while somebody
 * is using it, and it is never allowed below one.
 */
export class Gate {
	private held = 0;
	private readonly waiting: Array<() => void> = [];

	private readonly size: () => number;

	constructor(size: () => number) {
		this.size = size;
	}

	async take(): Promise<() => void> {
		if (this.held < Math.max(1, this.size())) {
			this.held += 1;
			return () => this.give();
		}
		await new Promise<void>((resolve) => this.waiting.push(resolve));
		this.held += 1;
		return () => this.give();
	}

	private give(): void {
		this.held = Math.max(0, this.held - 1);
		if (this.waiting.length && this.held < Math.max(1, this.size())) {
			// Woken one at a time, and each wakes holding nothing — `take` is what
			// increments, so a woken waiter cannot overshoot the limit it re-reads.
			this.waiting.shift()!();
		}
	}

	get inFlight(): number {
		return this.held;
	}

	get queued(): number {
		return this.waiting.length;
	}
}

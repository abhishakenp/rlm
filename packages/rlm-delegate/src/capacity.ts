/**
 * How much may run at once — measured, not configured.
 *
 * A fixed limit of one is why five of six jobs were turned away at the door
 * last night, and the refusal reached nobody. The fix has two halves and the
 * first is elsewhere in this package: overflow is not a refusal, it is a task
 * that stays `ready` in the journal until there is room. That is already how
 * the scheduler behaves, because "runnable" and "started" were never the same
 * thing. This file supplies the other half — the number.
 *
 * Three signals, because this machine has failed on each of them and on nothing
 * else, and three honest readings beat one clever formula:
 *
 *   - **Open file descriptors.** The one that actually wedged it: fourteen
 *     hours with hot reload silently dead, 380 open against a soft limit of
 *     256, the fiber reporting ACTIVE the whole time. Every delegation is a
 *     Node process loading a large bundle and watching files, so descriptors
 *     are the resource that runs out first and the one whose exhaustion is
 *     invisible.
 *   - **Free memory.** Each child is a real process with a real heap. Note that
 *     on macOS `os.freemem()` understates what is available, because it does
 *     not count purgeable or cached pages — so this signal errs toward caution,
 *     which is the direction to err in.
 *   - **Load average.** The slowest to react of the three and the least
 *     interesting for spawning, but it is what "the laptop will lag" actually
 *     means to someone using it.
 *
 * The scheduler asks for one number and re-asks between tasks, because the
 * machine changes under it while somebody is working on it. That is also the
 * seam for later: when the work goes to a remote pool, this becomes a function
 * that returns a much larger number and nothing else has to change.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";

export interface Reading {
	name: string;
	/** 0 = nothing left, 1 = entirely free. */
	headroom: number;
	detail: string;
}

export interface CapacityVerdict {
	limit: number;
	readings: Reading[];
	/** The binding constraint, in a sentence. */
	why: string;
}

/** Soft limit on open files for this process, when the runtime will say. */
const softFdLimit = (): number | null => {
	try {
		const limits = (process as any).report?.getReport?.()?.userLimits;
		const soft = limits?.open_files?.soft;
		if (typeof soft === "number" && Number.isFinite(soft)) return soft;
		if (soft === "unlimited") return Number.POSITIVE_INFINITY;
	} catch {
		/* not every runtime reports limits */
	}
	return null;
};

/** Descriptors this process currently holds. `/dev/fd` is per-process on macOS and Linux. */
const openFds = (): number | null => {
	try {
		return readdirSync("/dev/fd").length;
	} catch {
		return null;
	}
};

/**
 * Memory actually available, in bytes.
 *
 * `os.freemem()` is close to useless on macOS: it counts only wholly free
 * pages, so a healthy machine reads 1% and every limit collapses to one. What
 * a process can actually get is free + inactive + speculative + purgeable, and
 * only `vm_stat` knows those. It costs about four milliseconds and is asked
 * between tasks, so it is cached briefly rather than avoided.
 */
let memCache: { at: number; free: number } | null = null;
const availableMemory = (): number => {
	if (platform() !== "darwin") return freemem();
	if (memCache && Date.now() - memCache.at < 2000) return memCache.free;
	try {
		const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 2000 });
		const page = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
		const pages = (label: string) => Number(out.match(new RegExp(`Pages ${label}:\\s+(\\d+)`))?.[1] ?? 0);
		const free = (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page;
		memCache = { at: Date.now(), free: free > 0 ? free : freemem() };
		return memCache.free;
	} catch {
		return freemem();
	}
};

export const readings = (): Reading[] => {
	const out: Reading[] = [];

	const limit = softFdLimit();
	const open = openFds();
	if (limit !== null && open !== null && limit > 0) {
		out.push({
			name: "file descriptors",
			headroom: limit === Number.POSITIVE_INFINITY ? 1 : Math.max(0, 1 - open / limit),
			detail: `${open} open of ${limit === Number.POSITIVE_INFINITY ? "unlimited" : limit}`,
		});
	}

	const total = totalmem();
	const free = availableMemory();
	if (total > 0) {
		out.push({
			name: "memory",
			headroom: Math.max(0, Math.min(1, free / total)),
			detail: `${Math.round(free / 1e6)} MB available of ${Math.round(total / 1e6)} MB`,
		});
	}

	const cores = Math.max(1, cpus()?.length ?? 1);
	const load = loadavg()[0] ?? 0;
	out.push({
		name: "cpu",
		headroom: Math.max(0, Math.min(1, 1 - load / cores)),
		detail: `load ${load.toFixed(2)} across ${cores} core(s)`,
	});

	return out;
};

export interface CapacityOptions {
	/** Never start more than this, however idle the machine looks. */
	ceiling?: number;
	/** Below this much headroom on any signal, drop to one at a time. */
	floor?: number;
}

/**
 * One number, with its reasoning attached.
 *
 * Never below one: a limit of zero is a machine that has stopped, and the whole
 * point of this package is that work does not quietly stop.
 */
export const capacity = (options: CapacityOptions = {}): CapacityVerdict => {
	const ceiling = Math.max(1, options.ceiling ?? Math.min(4, Math.max(1, Math.floor((cpus()?.length ?? 2) / 2))));
	const floor = options.floor ?? 0.2;
	const measured = readings();

	const tightest = measured.reduce(
		(worst, r) => (r.headroom < worst.headroom ? r : worst),
		measured[0] ?? { name: "nothing", headroom: 1, detail: "no signal could be read" },
	);

	if (!measured.length) {
		return { limit: 1, readings: measured, why: "no signal could be read, so one at a time" };
	}
	if (tightest.headroom < floor) {
		return {
			limit: 1,
			readings: measured,
			why: `${tightest.name} is down to ${Math.round(tightest.headroom * 100)}% (${tightest.detail}) — one at a time`,
		};
	}

	// Map the headroom that is left above the floor onto [1, ceiling], so the
	// limit rises smoothly with the machine instead of jumping, and only reaches
	// the ceiling on a machine that is genuinely idle.
	const span = Math.max(0.0001, 1 - floor);
	const limit = Math.max(
		1,
		Math.min(ceiling, 1 + Math.round(((tightest.headroom - floor) / span) * (ceiling - 1))),
	);
	return {
		limit,
		readings: measured,
		why: `${limit} at a time; tightest is ${tightest.name} at ${Math.round(tightest.headroom * 100)}% (${tightest.detail})`,
	};
};

export const explain = (verdict = capacity()): string =>
	[`capacity ${verdict.limit} — ${verdict.why}`, ...verdict.readings.map((r) => `  ${r.name}: ${Math.round(r.headroom * 100)}% free — ${r.detail}`)].join("\n");

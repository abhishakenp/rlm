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
 *   - **Memory.** Each child is a real process with a real heap. This one is a
 *     *budget*, not a percentage, and that distinction is the whole of the last
 *     bug here. `free ÷ total` answers "how full is the machine", which is not
 *     the question — what bounds concurrent children is `available ÷ what one
 *     child costs`. On a 17 GB laptop that is also running an assistant, memory
 *     never reads much above 25% free, so a percentage-shaped signal pinned the
 *     limit at one for ever: reaching two needed 25.7% headroom and four needed
 *     54%, on a machine that had 4.3 GB actually available and children that
 *     measured 0.3 GB apiece. Fourteen fit. One ran.
 *   - **CPU, measured as busy cores — not the load average.** This is what "the
 *     laptop will lag" actually means to someone using it, and it is the signal
 *     that was wrong longest. Two corrections, both measured:
 *
 *       The old note here said "a delegated child spends most of its life
 *       blocked on a provider socket using no local CPU at all". It does not:
 *       three live children read 16.2%, 22.6% and 32.2% of a core, because rlm
 *       re-execs under tsx and every child transpiles the composition on the
 *       way up. So CPU does bound the fleet, and it now carries a budget like
 *       memory instead of only a floor.
 *
 *       And the number it read was the wrong number. `loadavg` on macOS counts
 *       work blocked in the kernel, so on a laptop doing any I/O it sits above
 *       the core count permanently: measured here at 9.42 on 8 cores — zero
 *       headroom, floor rule fires, fleet collapses to one — at the same
 *       instant `top` reported 50.5% idle. That is exactly the `free ÷ total`
 *       category error this file was written to fix, left standing in the one
 *       signal nobody re-read. Busy cores are summed from `ps` instead, on the
 *       same pass that already measures per-child memory.
 *
 * A budget needs two numbers and both are measured rather than assumed: how
 * much room there is, and what one child costs. The second is read off `ps`
 * against whatever children are alive right now, so it tracks the agent getting
 * fatter without anybody remembering to edit a constant here.
 *
 * His floor rule sits above all of it and is not a budget: spin while 30% or
 * more of every signal is free, and under that start *nothing* — not one —
 * regardless of how many would "fit"; the queue keeps its order and serves
 * first in, first executed. Zero rather than one is the honest floor, because
 * one-at-a-time on a machine with nothing spare is still work it cannot afford,
 * and a hardcoded one is not a measured answer but a shrug — it read as a real
 * limit for a whole day while the CPU signal underneath it was broken. No
 * amount of arithmetic below is allowed to talk the floor out of firing.
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
	/**
	 * 0 = nothing left, 1 = entirely free.
	 *
	 * This is what the floor rule reads, and only what the floor rule reads. It
	 * answers "is the machine in trouble", which is a different question from
	 * "how many more of these fit" — see `fits`.
	 */
	headroom: number;
	/**
	 * How many more children this resource has room for, when it is the kind of
	 * resource you can divide. Absent means the signal cannot bound the fleet
	 * and only participates in the floor rule.
	 */
	fits?: number;
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

/**
 * What the kernel itself says about memory — the floor rule's signal, and not
 * the same question as `availableMemory()`.
 *
 * These are two different questions and conflating them is the bug this exists
 * to fix. `available ÷ total` answers "how many more children fit", and it is
 * right for that; it is *wrong* as an answer to "is this machine in trouble",
 * which is what his 30% floor is asking. Measured here at the same instant:
 * the arithmetic said 25% free while the kernel said 49%, so the floor fired
 * and the fleet sat at zero on a laptop with 4.3 GB genuinely available, 90%
 * of its cores idle and room measured for thirteen. That is precisely the
 * `free ÷ total` category error this file's header was written about, left
 * standing in the one place nobody re-read — the third time that same mistake
 * has been made in this file, in a third signal.
 *
 * So the floor reads what macOS reads. `memory_pressure` reports the kernel's
 * own system-wide free percentage — the number behind Activity Monitor's
 * pressure graph, which is what a person looking at this machine would call
 * "free" — and `kern.memorystatus_vm_pressure_level` is the kernel's verdict
 * rather than a percentage: 1 normal, 2 warning, 4 critical. Anything above
 * normal is the machine saying it is in trouble in its own words, and that
 * outranks any percentage, because "everything else that matters" was part of
 * his rule too.
 *
 * Both are free to ask: measured at 0.00s real, three runs each. Cached for
 * two seconds anyway, because capacity is re-asked between every task.
 *
 * Off darwin there is no equivalent and the caller falls back to the
 * arithmetic, which is what `freemem()` already means on Linux.
 */
let kernelCache: { at: number; free: number | null; level: number | null } | null = null;
const kernelMemory = (): { free: number | null; level: number | null } => {
	if (platform() !== "darwin") return { free: null, level: null };
	if (kernelCache && Date.now() - kernelCache.at < 2000) return kernelCache;
	let free: number | null = null;
	let level: number | null = null;
	try {
		const out = execFileSync("/usr/bin/memory_pressure", { encoding: "utf8", timeout: 2000 });
		const pct = Number(out.match(/free percentage:\s*(\d+)/)?.[1]);
		if (Number.isFinite(pct)) free = Math.max(0, Math.min(1, pct / 100));
	} catch {
		/* not there, or slow — the arithmetic stands in */
	}
	try {
		const out = execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
			encoding: "utf8",
			timeout: 2000,
		});
		const n = Number(out.trim());
		if (Number.isFinite(n)) level = n;
	} catch {
		/* no verdict claimed */
	}
	kernelCache = { at: Date.now(), free, level };
	return kernelCache;
};

/**
 * What one delegated child actually costs in memory, in bytes.
 *
 * Measured on this machine rather than estimated, because the estimate was
 * wrong in both directions at different times — and the number that stood here
 * longest was wrong by a factor of three in the expensive direction.
 *
 * A child is two node processes: the launcher, which does nothing but re-exec
 * and wait, and the `tsx` re-exec that does the work. The 350 MB that used to
 * be here was read off processes rather than sessions, so it counted the same
 * work twice. Grouped by `--session-id`, four live children measured 116, 123,
 * 127 and 132 MB, and a child driven from boot to answer under a probe peaked
 * at 208 MB while it transpiled the composition and settled back to about 143.
 *
 * 210 MB is that observed peak rounded up. It stays a *floor* on the estimate
 * rather than the estimate itself, for the reason that was always right: a
 * child alive two seconds has not paid for its heap yet, and sizing the fleet
 * off a just-started child would let it grow at exactly the moment it is about
 * to get expensive. So a live reading may push this number up and never down.
 *
 * What it must not do is stay three times above every child ever measured. At
 * 350 MB the budget read "room for 5" on a machine holding children of 123 MB;
 * the constant was not a floor under the measurement, it was a replacement for
 * it, because no real child could ever reach it.
 */
const MEASURED_CHILD_BYTES = 210 * 1024 * 1024;

/**
 * Of the memory that is actually available, the share the fleet may take.
 *
 * The other 30% is not slack for its own sake: `availableMemory()` counts
 * inactive and purgeable pages, which are available in the sense that the
 * kernel will evict them, not in the sense that taking them is free. Handing
 * every last one of them to child processes is how a machine that reads healthy
 * starts swapping. It is also the difference between a laptop somebody is using
 * and a box in a rack, and this is the laptop.
 */
const MEMORY_SHARE = 0.7;

/**
 * What one delegated child actually costs in CPU, in cores.
 *
 * The comment above used to say a child "spends most of its life blocked on a
 * provider socket using no local CPU at all". Measured against live children it
 * is not true: three running at once read 16.2%, 22.6% and 32.2% of a core, and
 * the reason is that rlm re-execs under tsx, so every child transpiles the
 * whole composition on the way up. A third of a core is cheap, but it is not
 * nothing, and a signal that assumes nothing cannot bound anything.
 *
 * 0.35 is the peak of those readings rounded up, and like its memory
 * counterpart it is a *floor* on the estimate: a live reading may push it up
 * and never down.
 */
const MEASURED_CHILD_CORES = 0.35;

/** Of the cores actually idle, the share the fleet may take. */
const CPU_SHARE = 0.7;

/** Descriptors the parent holds per child: two pipes and the handle, plus one. */
const FDS_PER_CHILD = 4;

/**
 * The per-child memory cost, read off the children that are actually running.
 *
 * Both processes in a child's tree carry `--session-id <id>` on their command
 * line, so the session id groups a tree and the sum over a group is what that
 * child is really costing. Costs about six milliseconds and is asked between
 * tasks, so it is cached briefly rather than avoided — same bargain as `vm_stat`.
 */
let costCache: { at: number; bytes: number; cores: number; busyCores: number; seen: number } | null = null;
const childCost = (): { bytes: number; cores: number; busyCores: number; seen: number } => {
	if (costCache && Date.now() - costCache.at < 5000) return costCache;
	let bytes = MEASURED_CHILD_BYTES;
	let cores = MEASURED_CHILD_CORES;
	let busyCores = 0;
	let seen = 0;
	try {
		// One `ps` for all three numbers. It already had to run for memory, and
		// %cpu costs nothing extra on the same pass — which matters, because the
		// alternative signal for "how busy is this machine" is `top -l 2`, and
		// that is a second of wall clock every time the scheduler asks.
		const out = execFileSync("ps", ["-eo", "rss=,%cpu=,command="], {
			encoding: "utf8",
			timeout: 2000,
			maxBuffer: 16e6,
		});
		const perSessionBytes = new Map<string, number>();
		const perSessionCores = new Map<string, number>();
		for (const line of out.split("\n")) {
			const head = line.trim().match(/^(\d+)\s+([\d.]+)\s/);
			if (!head) continue;
			const rss = Number(head[1]);
			const pct = Number(head[2]);
			// Everything on the machine counts toward how busy it is, not just
			// the fleet — a laptop pegged by a browser has no room for children
			// either, and that is the whole point of asking.
			if (Number.isFinite(pct)) busyCores += pct / 100;
			if (!line.includes("--print") || !line.includes("--session-id")) continue;
			const session = line.match(/--session-id\s+(\S+)/)?.[1];
			if (!session) continue;
			if (rss) perSessionBytes.set(session, (perSessionBytes.get(session) ?? 0) + rss * 1024);
			if (Number.isFinite(pct)) perSessionCores.set(session, (perSessionCores.get(session) ?? 0) + pct / 100);
		}
		seen = perSessionBytes.size;
		// The fattest live child, not the average: the fleet has to fit the
		// worst one, and averaging lets a crowd of just-started children vouch
		// for a limit none of them can afford once they warm up.
		// Live readings decide, in both directions — not just upward.
		//
		// This used to seed from the constant and only ever raise it, so a
		// constant of 350 MB survived every child that measured 129, and the
		// only way down was a person editing the source. That is exactly the
		// wasteful pattern he named: a number being maintained by hand when the
		// machine can read it. It was hand-edited 350 → 275 → 210 in one day.
		//
		// The peak of the live sample, not the mean: the fleet has to fit the
		// worst child, and averaging lets a crowd of just-started ones vouch for
		// a limit none of them can afford once warm. The constant survives only
		// as a bootstrap for when nothing is running yet, and a single sample is
		// not enough to overrule it — a child two seconds old has not paid for
		// its heap.
		const liveBytes = [...perSessionBytes.values()];
		const liveCores = [...perSessionCores.values()];
		if (liveBytes.length >= 2) bytes = Math.max(...liveBytes);
		else for (const total of liveBytes) if (total > bytes) bytes = total;
		if (liveCores.length >= 2) cores = Math.max(...liveCores);
		else for (const total of liveCores) if (total > cores) cores = total;
	} catch {
		/* no ps, or it was slow — the measured defaults stand */
	}
	costCache = { at: Date.now(), bytes, cores, busyCores, seen };
	return costCache;
};

/**
 * The other ceiling: what the provider layer will carry at once.
 *
 * There is no point sizing a fleet of twelve against a router that serialises
 * them, so this asks rather than assumes. omniroute reports `maxConcurrent` and
 * its queue depth on `/health`; measured here it answered 64, and it carried
 * seven concurrent children with `queued: 0` on every sample — so on this
 * machine it is not the binding constraint and memory is. That is a fact about
 * today's configuration, not a law, which is why it is read at runtime: turn
 * omniroute down to four and the fleet follows it down without anyone editing
 * this file.
 *
 * Best-effort by design. If omniroute cannot be reached the children were going
 * to fail anyway, and guessing a small number here would only hide that.
 */
let providerCache: { at: number; ceiling: number | null } | null = null;
const providerCeiling = (): number | null => {
	if (providerCache && Date.now() - providerCache.at < 30_000) return providerCache.ceiling;
	let ceiling: number | null = null;
	try {
		const base = process.env.OMNIROUTE_URL ?? "http://localhost:20128";
		const out = execFileSync("curl", ["-s", "--max-time", "1", `${base}/health`], { encoding: "utf8", timeout: 2000 });
		const max = Number(JSON.parse(out)?.maxConcurrent);
		if (Number.isFinite(max) && max > 0) ceiling = Math.floor(max);
	} catch {
		/* not running, not reachable, not JSON — no ceiling claimed */
	}
	providerCache = { at: Date.now(), ceiling };
	return ceiling;
};

export const readings = (): Reading[] => {
	const out: Reading[] = [];
	const cost = childCost();

	const limit = softFdLimit();
	const open = openFds();
	if (limit !== null && open !== null && limit > 0) {
		const unlimited = limit === Number.POSITIVE_INFINITY;
		out.push({
			name: "file descriptors",
			headroom: unlimited ? 1 : Math.max(0, 1 - open / limit),
			fits: unlimited ? undefined : Math.max(0, Math.floor(((limit - open) * MEMORY_SHARE) / FDS_PER_CHILD)),
			detail: `${open} open of ${unlimited ? "unlimited" : limit}`,
		});
	}

	const total = totalmem();
	const free = availableMemory();
	if (total > 0) {
		// The budget, and the whole point of this file: not what fraction is
		// free, but how many children fit in what is actually there.
		const fits = Math.max(0, Math.floor((free * MEMORY_SHARE) / cost.bytes));
		// The floor's number is a different number, from the kernel — see
		// kernelMemory(). The arithmetic only stands in when it cannot answer.
		const kernel = kernelMemory();
		const strained = kernel.level !== null && kernel.level > 1;
		const headroom = strained ? 0 : (kernel.free ?? Math.max(0, Math.min(1, free / total)));
		const source = strained
			? `the kernel reports memory pressure level ${kernel.level} — above normal, so this reads as no headroom at all`
			: kernel.free !== null
				? "kernel-reported free"
				: "available ÷ total, no kernel reading";
		out.push({
			name: "memory",
			headroom,
			fits,
			detail:
				`${Math.round(free / 1e6)} MB available of ${Math.round(total / 1e6)} MB` +
				` — room for ${fits} at ${Math.round(cost.bytes / 1e6)} MB each` +
				` (${cost.seen ? `${cost.seen} live child(ren) measured` : "no children live, measured default"});` +
				` floor reads ${Math.round(headroom * 100)}% free (${source})`,
		});
	}

	const cores = Math.max(1, cpus()?.length ?? 1);
	const load = loadavg()[0] ?? 0;
	// Busy cores, measured — not the load average, which was the last thing in
	// this file still making the category error the rest of it was written to
	// fix. Measured together on this machine: load average 9.42 on 8 cores,
	// which is `1 - 9.42/8` = no headroom at all and collapses the fleet to one
	// by the floor rule — while `top` read 50.5% idle at the same instant. macOS
	// load counts work blocked in the kernel, so on a laptop doing any I/O it
	// sits permanently above the core count and the floor rule never stops
	// firing. The fleet was pinned at one for that reason and no other.
	const busy = Math.max(0, Math.min(cores, cost.busyCores));
	const cpuFits = Math.max(0, Math.floor(((cores - busy) * CPU_SHARE) / Math.max(0.01, cost.cores)));
	out.push({
		name: "cpu",
		headroom: Math.max(0, Math.min(1, 1 - busy / cores)),
		fits: cpuFits,
		detail:
			`${busy.toFixed(2)} of ${cores} core(s) busy` +
			` — room for ${cpuFits} at ${cost.cores.toFixed(2)} core(s) each` +
			` (load average ${load.toFixed(2)}, which counts blocked work and is not what this reads)`,
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
	// The ceiling is whatever the provider layer says it will carry, because
	// that is the one bound this machine cannot argue with. Measured, omniroute
	// answers 64 and queues nothing at seven — so it does not bind here, and the
	// memory budget below is what actually decides. When omniroute cannot be
	// asked, fall back to one per core: not because the work is CPU-bound (it is
	// not), but because it is a number of the right order that nobody has to
	// maintain, and the budget still has to agree with it.
	const ceiling = Math.max(1, options.ceiling ?? providerCeiling() ?? Math.max(1, cpus()?.length ?? 2));
	// 30%, his number. Under it nothing new starts at all.
	const floor = options.floor ?? 0.3;
	const measured = readings();

	const tightest = measured.reduce(
		(worst, r) => (r.headroom < worst.headroom ? r : worst),
		measured[0] ?? { name: "nothing", headroom: 1, detail: "no signal could be read" },
	);

	// His rule, 2026-09-03: spin while 30% or more of every resource that matters
	// is free; below that start nothing and let the queue serve first-in-first-
	// out. No hardcoded "one at a time" — that is not a measured answer, it is a
	// shrug, and it read as a real limit for a whole day while the CPU signal
	// was broken.
	//
	// Zero rather than one is the honest floor. One-at-a-time on a machine with
	// nothing spare is still work it cannot afford, and it is what made a
	// starved fleet look like a working one. Nothing new starts; whatever is in
	// flight finishes; the queue keeps its order.
	if (!measured.length) {
		return {
			limit: 0,
			readings: measured,
			why: "nothing could be measured, so nothing new starts — a limit nobody measured is a guess",
		};
	}

	// His rule, first and unconditional. Below the floor on any single signal
	// the machine is in trouble, and how many children would "fit" stops being
	// the question — nothing further down is allowed to overturn this.
	if (tightest.headroom < floor) {
		return {
			limit: 0,
			readings: measured,
			why: `${tightest.name} is at ${Math.round(tightest.headroom * 100)}% free, under the ${Math.round(floor * 100)}% floor (${tightest.detail}) — nothing new starts, the queue waits its turn`,
		};
	}

	// Above the floor, the number is the budget: how many fit in what is there,
	// according to whichever divisible resource has the least room. No smooth
	// mapping onto headroom, because that was the bug — headroom answers a
	// question about the machine and this one is about the children.
	const budgets = measured.filter((r) => typeof r.fits === "number");
	const binding = budgets.reduce<Reading | null>((worst, r) => (!worst || r.fits! < worst.fits! ? r : worst), null);
	const limit = Math.max(1, Math.min(ceiling, binding ? binding.fits! : 1));

	const why = binding
		? limit === ceiling && (binding.fits ?? 0) > ceiling
			? `${limit} at a time; the ceiling, with ${binding.name} good for ${binding.fits} (${binding.detail})`
			: `${limit} at a time; ${binding.name} is the budget (${binding.detail})`
		: `${limit} at a time; no signal could size the fleet`;

	return { limit, readings: measured, why };
};

export const explain = (verdict = capacity()): string =>
	[
		`capacity ${verdict.limit} — ${verdict.why}`,
		...verdict.readings.map(
			(r) =>
				`  ${r.name}: ${Math.round(r.headroom * 100)}% free` +
				`${typeof r.fits === "number" ? `, fits ${r.fits}` : ""} — ${r.detail}`,
		),
	].join("\n");

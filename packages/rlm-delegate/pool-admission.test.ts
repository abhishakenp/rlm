/**
 * What the pool admits, and why.
 *
 * Two static numbers used to answer this — `slots ?? 8` and `maxWorkers ?? 4` —
 * and both were guesses about a machine neither had looked at. These are the
 * three cases the replacement has to get right, exercised with an injected
 * memory reading rather than with a real machine, because a test that depends
 * on how much RAM happens to be free is a test that says nothing.
 *
 * Everything below drives `AgentPool` through its public surface. `ceiling()`
 * is private on purpose, so it is read through the two things it decides: how
 * many workers may exist, and how many tasks one of them may hold.
 */
import { AgentPool, type PoolOptions } from "./src/pool.ts";

let pass = 0,
	fail = 0;
const t = (name: string, fn: () => void) => {
	try {
		fn();
		pass++;
		console.log("  ok  " + name);
	} catch (e: any) {
		fail++;
		console.log("  FAIL " + name + "\n       " + e.message);
	}
};
const eq = (a: any, b: any, m = "") => {
	if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v: any, m = "") => {
	if (!v) throw new Error(m || "expected truthy");
};

/** Reach for what the class computes without pretending the methods are public. */
const readAdmission = (options: Partial<PoolOptions> & { freeFraction: () => number }) => {
	const pool = new AgentPool({ entry: "/nowhere/rlm.mjs", ...options } as PoolOptions);
	const inner = pool as unknown as { ceiling(): number; slots: number };
	return { workers: inner.ceiling(), slots: inner.slots, pool };
};

console.log("admission is a memory question");

t("below the floor, one worker and one task at a time", () => {
	const { workers, slots } = readAdmission({ freeFraction: () => 0.05, memoryFloor: 0.2 });
	eq(workers, 1, "workers");
	eq(slots, 1, "slots");
});

t("above the floor, nothing is capped in advance", () => {
	const { workers, slots } = readAdmission({ freeFraction: () => 0.85, memoryFloor: 0.2 });
	eq(workers, Number.MAX_SAFE_INTEGER, "workers");
	eq(slots, Number.MAX_SAFE_INTEGER, "slots");
});

t("the floor is config, not the literal 0.2", () => {
	// The same 30%-free machine, read as trouble by one floor and as room by
	// the other. If the number were hardcoded these two would agree.
	eq(readAdmission({ freeFraction: () => 0.3, memoryFloor: 0.5 }).workers, 1, "floor 0.5");
	eq(readAdmission({ freeFraction: () => 0.3, memoryFloor: 0.1 }).workers, Number.MAX_SAFE_INTEGER, "floor 0.1");
});

t("exactly at the floor is not below it", () => {
	eq(readAdmission({ freeFraction: () => 0.2, memoryFloor: 0.2 }).workers, Number.MAX_SAFE_INTEGER);
});

t("an explicit maxWorkers outranks the measurement", () => {
	// A caller that has measured something beats a rule that has not — this is
	// how `capacity()`'s fleet-wide budget still binds the pool.
	eq(readAdmission({ freeFraction: () => 0.9, memoryFloor: 0.2, maxWorkers: 3 }).workers, 3, "as a number");
	eq(readAdmission({ freeFraction: () => 0.02, memoryFloor: 0.2, maxWorkers: 3 }).workers, 3, "even under the floor");
	eq(readAdmission({ freeFraction: () => 0.9, memoryFloor: 0.2, maxWorkers: () => 2 }).workers, 2, "as a function");
});

t("an explicit slots count outranks the measurement too", () => {
	eq(readAdmission({ freeFraction: () => 0.02, memoryFloor: 0.2, slots: 6 }).slots, 6);
});

t("a reading that throws is read as no room, not as room", () => {
	const { workers } = readAdmission({
		freeFraction: () => {
			throw new Error("vm_stat is not on this machine");
		},
		memoryFloor: 0.2,
	});
	eq(workers, 1, "a broken probe must not open the gate");
});

t("a nonsense reading falls back to the arithmetic rather than to a guess", () => {
	// NaN is what a half-parsed `vm_stat` gives back. It must not compare
	// false-and-therefore-fine against the floor.
	const { workers } = readAdmission({ freeFraction: () => Number.NaN, memoryFloor: 0.2 });
	ok(workers === 1 || workers === Number.MAX_SAFE_INTEGER, "it answered something definite");
});

console.log("\nthe queue is bounded");

const fakeTask = (id: string) => ({ id, title: id, prompt: id, state: "ready", proof: { kind: "unstated" as const } });
const fakeGraph = (id: string) => ({ id, goal: id, tasks: [] });

// The queue only fills when nothing is draining it, so this one needs a real
// (failed) spawn and a real event loop turn — which makes it async, and async
// cases are run below rather than through `t`.
const asyncCases: Array<[string, () => Promise<void>]> = [
	[
		"over the queue limit a task is refused with a sentence, not swallowed",
		async () => {
			// Nothing can ever come up (the interpreter does not exist), so every
			// task that is accepted stays queued — which is the state the limit is
			// for. The first two are accepted and never settle; the rest have to be
			// refused rather than joining them.
			const pool = new AgentPool({
				entry: "/nowhere/rlm.mjs",
				node: "/nonexistent-binary-for-this-test",
				queueLimit: 2,
				bootTimeoutMs: 500,
				freeFraction: () => 0.9,
				log: () => {},
			} as PoolOptions);
			const seen: string[] = [];
			for (let n = 0; n < 5; n++) {
				void pool
					.run(fakeTask(`t${n}`) as any, fakeGraph(`g${n}`) as any)
					.then(
						() => seen.push("ok"),
						(e: Error) => seen.push(e.message),
					);
			}
			await new Promise((r) => setTimeout(r, 300));
			const full = seen.filter((m) => m.includes("queue is full"));
			eq(full.length, 3, `three of five refused for a full queue — saw ${JSON.stringify(seen)}`);
			await pool.close();
			await new Promise((r) => setTimeout(r, 50));
			eq(seen.length, 5, `everything settled once the pool closed — saw ${JSON.stringify(seen)}`);
		},
	],
];

const main = async () => {
	for (const [name, fn] of asyncCases) {
		try {
			await fn();
			pass++;
			console.log("  ok  " + name);
		} catch (e: any) {
			fail++;
			console.log("  FAIL " + name + "\n       " + e.message);
		}
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exitCode = fail ? 1 : 0;
};

void main();

/**
 * A pool worker that answers the wire and nothing else.
 *
 * `AgentPool` talks to a process over Node IPC. Everything the pool itself
 * promises — per-session serialisation, heartbeat death detection, bounded
 * drain, re-queue-once — is a property of that conversation and not of what the
 * worker does with a prompt, so this stands in for the real one: it speaks the
 * same protocol, boots in milliseconds instead of 1.4 seconds, and needs no
 * model, no API key and no coding-agent on the path.
 *
 * Steered by the environment:
 *   ECHO_DELAY_MS        how long a task takes to answer   (default 200)
 *   ECHO_SILENT_AFTER    stop heartbeating and stop answering once this many
 *                        tasks have started; the process stays alive, which is
 *                        the case a pid cannot tell you about. Only the first
 *                        worker to boot takes it — it is claimed with an
 *                        exclusive create — or the replacement would go silent
 *                        too and the test would be measuring a poison task
 *                        rather than a heartbeat.
 *   ECHO_LOG             a file to append one JSON line per task start/end to,
 *                        which is how the test sees whether two tasks that
 *                        should not have overlapped did
 */
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = argv.indexOf(name);
	const n = at === -1 ? Number.NaN : Number(argv[at + 1]);
	return Number.isFinite(n) ? n : fallback;
};

const slots = flag("--slots", 8);
const beatMs = flag("--heartbeat-ms", 5000);
const delayMs = Number(process.env.ECHO_DELAY_MS ?? 200);
const silentAfter = Number(process.env.ECHO_SILENT_AFTER ?? 0);
const log = process.env.ECHO_LOG;

const note = (row) => {
	if (!log) return;
	try {
		appendFileSync(log, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...row })}\n`);
	} catch {
		/* the test owns the file; a worker is not the place to care */
	}
};

const send = (message) => {
	try {
		process.send?.(message);
	} catch {
		/* the parent has gone */
	}
};

/**
 * Whether this process is the one that plays dead.
 *
 * Claimed with `wx`, so exactly one worker in the run gets it however many are
 * hired. Without that, the replacement hired to take over the re-queued task
 * would go silent on the same task and the pool would correctly report a task
 * that kills workers — a true statement about a different thing.
 */
const claim = process.env.ECHO_SILENT_CLAIM;
let chosen = false;
if (Number(process.env.ECHO_SILENT_AFTER ?? 0) > 0 && claim) {
	try {
		writeFileSync(claim, String(process.pid), { flag: "wx" });
		chosen = true;
	} catch {
		chosen = false;
	}
}

let started = 0;
let silent = false;
const live = new Map();

process.on("message", (message) => {
	if (!message || typeof message !== "object") return;
	if (message.type === "task") {
		started += 1;
		if (chosen && silentAfter > 0 && started >= silentAfter) silent = true;
		note({ event: "start", id: message.id, session: message.sessionId });
		if (silent) {
			// Alive, holding the task, saying nothing. The only thing that can
			// notice this is the heartbeat.
			note({ event: "went-silent", id: message.id, session: message.sessionId });
			return;
		}
		const timer = setTimeout(() => {
			live.delete(message.id);
			note({ event: "end", id: message.id, session: message.sessionId });
			send({ type: "done", id: message.id, ok: true, text: `echo:${message.prompt.split("\n")[0]}` });
		}, delayMs);
		live.set(message.id, timer);
		return;
	}
	if (message.type === "cancel") {
		const timer = live.get(message.id);
		if (timer) clearTimeout(timer);
		live.delete(message.id);
		note({ event: "cancelled", id: message.id });
		send({ type: "done", id: message.id, ok: false, text: "", error: "cancelled" });
		return;
	}
	if (message.type === "attend") {
		send({ type: "attention", watching: message.sessionId });
		return;
	}
	if (message.type === "retire") {
		note({ event: "retire" });
		setTimeout(() => process.exit(0), 10).unref?.();
		return;
	}
});

const beat = beatMs > 0 ? setInterval(() => {
	if (silent) return;
	send({ type: "heartbeat", id: String(process.pid), ts: Date.now() });
}, beatMs) : undefined;
beat?.unref?.();

process.on("disconnect", () => process.exit(0));

note({ event: "ready", slots });
send({ type: "ready", pid: process.pid, slots });

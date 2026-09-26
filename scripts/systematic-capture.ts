#!/usr/bin/env node
/**
 * systematic-capture.ts — Ensure ALL tasks are captured in the delegate graph.
 *
 * This script provides automatic task capture by writing directly to the
 * delegate store. It can be used as:
 *
 * 1. CLI submission:   npx tsx scripts/systematic-capture.ts submit "fix the bug"
 * 2. Pipe input:       echo "deploy v2" | npx tsx scripts/systematic-capture.ts submit
 * 3. Scripting:        import { capture, audit } from './scripts/systematic-capture'
 *
 * The key guarantee: tasks submitted here are written to the same store
 * that rlm-delegate reads from, so nothing is ever lost or forgotten.
 */

import { Store, defaultDir, mintId, outstanding } from "../packages/rlm-delegate/src/index.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaskSpec {
	id?: string;
	title: string;
	prompt?: string;
	needs?: string[];
	proof: {
		kind: "shell" | "file" | "row" | "command" | "unstated";
		run?: string;
		path?: string;
		contains?: string;
		id?: string;
		state?: string;
		name?: string;
		note?: string;
	};
	priority?: number;
}

interface CaptureResult {
	graphId: string;
	taskId: string;
	recorded: boolean;
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Capture a task in the delegate graph.
 *
 * This is the main entry point. Call this for every task that should be
 * tracked, and it will be written to the delegate graph immediately.
 */
export function capture(spec: TaskSpec, options: { storeDir?: string } = {}): CaptureResult {
	const store = new Store(options.storeDir ?? defaultDir());

	const taskId = spec.id ?? mintId().slice(0, 20);
	const title = spec.title;
	const prompt = spec.prompt ?? spec.title;

	const tasks = [{
		id: taskId,
		title,
		prompt,
		needs: spec.needs ?? [],
		proof: spec.proof,
		priority: spec.priority,
	}];

	try {
		const graphId = mintId();
		store.create(`task: ${title}`, tasks, graphId);

		return {
			graphId,
			taskId,
			recorded: true,
		};
	} catch (error) {
		console.error(`Failed to capture: ${error}`);
		return {
			graphId: "",
			taskId,
			recorded: false,
		};
	}
}

/**
 * Capture multiple tasks in one graph.
 */
export function captureMany(tasks: TaskSpec[], goal: string, options: { storeDir?: string } = {}): CaptureResult[] {
	const store = new Store(options.storeDir ?? defaultDir());

	const graphId = mintId();
	const results: CaptureResult[] = [];

	const validated = tasks.map((t, i) => ({
		id: t.id ?? `task-${i}`,
		title: t.title,
		prompt: t.prompt ?? t.title,
		needs: t.needs ?? [],
		proof: t.proof,
		priority: t.priority,
	}));

	try {
		store.create(goal, validated, graphId);

		for (const task of validated) {
			results.push({
				graphId,
				taskId: task.id,
				recorded: true,
			});
		}
	} catch (error) {
		console.error(`Failed to capture tasks: ${error}`);
		return tasks.map((t, i) => ({
			graphId: "",
			taskId: t.id ?? `task-${i}`,
			recorded: false,
		}));
	}

	return results;
}

/**
 * Audit the delegate graph for any work.
 */
export function audit(options: { storeDir?: string } = {}): {
	total: number;
	byState: Record<string, number>;
	graphs: Array<{ id: string; goal: string; owed: number; tasks: number }>;
} {
	const store = new Store(options.storeDir ?? defaultDir());
	const graphIds = store.ids();

	const byState: Record<string, number> = {};
	const graphs: Array<{ id: string; goal: string; owed: number; tasks: number }> = [];
	let total = 0;

	for (const id of graphIds) {
		const graph = store.load(id);
		if (!graph) continue;

		const owed = outstanding(graph.tasks);
		graphs.push({
			id: graph.id,
			goal: graph.goal,
			owed: owed.length,
			tasks: graph.tasks.length,
		});

		for (const task of graph.tasks) {
			total++;
			byState[task.state] = (byState[task.state] ?? 0) + 1;
		}
	}

	return { total, byState, graphs };
}

/**
 * List all open (unfinished) tasks across all graphs.
 */
export function openTasks(options: { storeDir?: string } = {}): Array<{
	graphId: string;
	taskId: string;
	title: string;
	state: string;
}> {
	const store = new Store(options.storeDir ?? defaultDir());
	const results: Array<{ graphId: string; taskId: string; title: string; state: string }> = [];

	for (const id of store.ids()) {
		const graph = store.load(id);
		if (!graph) continue;

		for (const task of graph.tasks) {
			if (task.state !== "done" && task.state !== "rejected") {
				results.push({
					graphId: id,
					taskId: task.id,
					title: task.title,
					state: task.state,
				});
			}
		}
	}

	return results.sort((a, b) => {
		const stateOrder: Record<string, number> = { running: 0, ready: 1, blocked: 2, unproven: 3, failed: 4 };
		return (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9);
	});
}

/**
 * Get the store directory path.
 */
export function storePath(options: { storeDir?: string } = {}): string {
	return options.storeDir ?? defaultDir();
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

type Command = "submit" | "audit" | "status" | "open" | "path" | "help";

function parseArgs(argv: string[]): { cmd: Command; args: string[]; id?: string } {
	const raw = argv.slice(2);
	const [cmd, ...rest] = raw;

	const commands: Command[] = ["submit", "audit", "status", "open", "path", "help"];

	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
		return { cmd: "help", args: [] };
	}

	if (!commands.includes(cmd as Command) && !cmd.startsWith("-")) {
		const idMatch = raw.find(arg => arg === "--id" || arg.startsWith("--id="));
		const idValue = idMatch ? (idMatch.startsWith("--id=") ? idMatch.slice(5) : undefined) : undefined;
		return { cmd: "submit", args: raw, id: idValue };
	}

	return { cmd: cmd as Command, args: rest };
}
function printHelp() {
	const store = defaultDir();
	console.log(`
systematic-capture — Ensure ALL tasks are captured in the delegate graph

USAGE
  npx tsx scripts/systematic-capture.ts <command> [options]

  # Submit a single task
  npx tsx scripts/systematic-capture.ts submit "fix the login bug"

  # Submit from stdin (piped)
  echo "deploy to production" | npx tsx scripts/systematic-capture.ts submit

  # Submit with proof criterion
  npx tsx scripts/systematic-capture.ts submit "install plugin" --proof "row:rlm-plugin:ACTIVE"

  # Audit what's in the graph
  npx tsx scripts/systematic-capture.ts audit

  # Show open tasks
  npx tsx scripts/systematic-capture.ts open

  # Show status summary
  npx tsx scripts/systematic-capture.ts status

  # Show store path
  npx tsx scripts/systematic-capture.ts path

COMMANDS
  submit [text]     Record a task. Reads from stdin if no text given.
  audit             Show summary of all graphs and task states.
  status            Brief status: how many tasks are owed.
  open              List all open (non-done) tasks.
  path              Show the delegate store directory path.
  help              Show this message.

PROOF CRITERIA (--proof)
  shell:<command>   Task is done when command exits 0
  file:<path>       Task is done when file exists
  row:<id>:<state>   Task is done when row reaches state (e.g., row:rlm-plugin:ACTIVE)
  command:<name>     Task is done when command exists in registry

EXAMPLES
  # Track a bug fix
  npx tsx scripts/systematic-capture.ts submit "fix memory leak in cache" --proof "shell:npm test"

  # Track a deployment
  npx tsx scripts/systematic-capture.ts submit "deploy v2.1" --proof "row:production:ACTIVE"

  # Audit for missing work
  npx tsx scripts/systematic-capture.ts audit

STORE LOCATION
  ${store}

For programmatic use, import from this file:
  import { capture, audit } from './scripts/systematic-capture'
`);
}

async function handleSubmit(args: string[], stdin: string): Promise<number> {
	// Parse --proof arguments first
	let proof: TaskSpec["proof"] = { kind: "unstated", note: "no criterion provided" };
	
	// Filter out --proof args and extract proof value
	const cleanArgs: string[] = [];
	let proofValue: string | null = null;
	let idValue: string | undefined;
	
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--proof" && i + 1 < args.length) {
			proofValue = args[i + 1];
			i++; // skip the proof value
		} else if (arg.startsWith("--proof=")) {
			proofValue = arg.replace("--proof=", "");
		} else if (arg === "--id" && i + 1 < args.length) {
			idValue = args[i + 1];
			i++; // skip the id value
		} else if (arg.startsWith("--id=")) {
			idValue = arg.replace("--id=", "");
		} else {
			cleanArgs.push(arg);
		}
	}
	
	// Parse proof value
	if (proofValue) {
		if (proofValue.startsWith("shell:")) {
			proof = { kind: "shell", run: proofValue.slice(6) };
		} else if (proofValue.startsWith("file:")) {
			proof = { kind: "file", path: proofValue.slice(5) };
		} else if (proofValue.startsWith("row:")) {
			const parts = proofValue.slice(4).split(":");
			proof = { kind: "row", id: parts[0], state: parts[1] };
		} else if (proofValue.startsWith("command:")) {
			proof = { kind: "command", name: proofValue.slice(8) };
		}
	}
	
	let text = cleanArgs.join(" ").trim();

	if (!text && stdin) {
		text = stdin.trim();
	}

	if (!text) {
		console.error("Error: No task text provided. Use 'submit <text>' or pipe input.");
		return 1;
	}

	const title = text.split("\n")[0].slice(0, 120);

	const result = capture({ id: idValue, title, prompt: text, proof });

	if (result.recorded) {
		console.log(`Captured: ${result.graphId}/${result.taskId}`);
		console.log(`  ${title.slice(0, 80)}`);
		return 0;
	} else {
		console.error("Failed to capture task");
		return 1;
	}
}
function handleAudit(): number {
	const result = audit();

	console.log(`\n=== Delegate Graph Audit ===\n`);
	console.log(`Total tasks: ${result.total}`);

	const stateLabels: Record<string, string> = {
		done: "done",
		running: "running",
		ready: "ready",
		blocked: "blocked",
		failed: "failed",
		unproven: "unproven",
		rejected: "rejected",
		unreachable: "unreachable",
	};

	console.log(`\nBy state:`);
	for (const [state, count] of Object.entries(result.byState)) {
		const label = stateLabels[state] ?? state;
		console.log(`  ${label.padEnd(12)} ${count}`);
	}

	console.log(`\nGraphs (${result.graphs.length}):`);
	for (const g of result.graphs.slice(0, 20)) {
		console.log(`  ${g.id}  ${g.owed}/${g.tasks} owed  ${g.goal.slice(0, 60)}`);
	}

	if (result.graphs.length > 20) {
		console.log(`  ... and ${result.graphs.length - 20} more`);
	}

	return 0;
}

function handleStatus(): number {
	const result = audit();
	const owed = Object.entries(result.byState)
		.filter(([s]) => !["done", "rejected"].includes(s))
		.reduce((n, [, c]) => n + c, 0);

	if (owed === 0) {
		console.log("Nothing owed — all tasks are done or rejected.");
	} else {
		console.log(`${owed} task(s) still owed across ${result.graphs.length} graph(s).`);
	}

	return owed === 0 ? 0 : 1;
}

function handleOpen(): number {
	const tasks = openTasks();

	if (tasks.length === 0) {
		console.log("No open tasks.");
		return 0;
	}

	console.log(`\n=== Open Tasks (${tasks.length}) ===\n`);

	const marks: Record<string, string> = {
		running: "RUNNING",
		ready: "ready",
		blocked: "blocked",
		failed: "FAILED",
		unproven: "UNPROVEN",
		unreachable: "stuck",
	};

	for (const t of tasks) {
		const mark = marks[t.state] ?? t.state;
		console.log(`  ${mark.padEnd(8)} ${t.graphId}/${t.taskId}`);
		console.log(`  ${" ".repeat(8)} ${t.title.slice(0, 70)}`);
		console.log();
	}

	return 0;
}

function handlePath(): number {
	console.log(storePath());
	return 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const { cmd, args } = parseArgs(process.argv);

	let stdin = "";
	if (!process.stdin.isTTY) {
		try {
			stdin = await new Promise<string>((resolve) => {
				let data = "";
				process.stdin.on("data", (chunk) => (data += chunk));
				process.stdin.on("end", () => resolve(data));
			});
		} catch {
			// stdin not available
		}
	}

	switch (cmd) {
		case "submit":
			return handleSubmit(args, stdin);
		case "audit":
			return handleAudit();
		case "status":
			return handleStatus();
		case "open":
			return handleOpen();
		case "path":
			return handlePath();
		default:
			printHelp();
			return 0;
	}
}

main().then((code) => process.exit(code)).catch((err) => {
	console.error(err);
	process.exit(1);
});

export { main };

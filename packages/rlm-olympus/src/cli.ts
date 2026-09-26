/**
 * `rlm olympus <stage>` — the pipeline in `stages.ts`, as one command.
 *
 * `stages.ts` is the source of truth for what the stages are, what each proves,
 * what it costs and whether it blocks; this file only runs the scripts in
 * `tools/` in that order. It adds no check of its own: a gate that lives here
 * instead of in `tools/` is a gate the scripts and `rubrics/` do not agree on.
 *
 * `submit` never sends. `stages.ts` names `tools/oly.py` as its tool, but no
 * script records which platform mutation submits a candidate, and a guessed one
 * spends shipd tokens — the one thing this package exists to avoid. It runs the
 * free gates and the measured criteria against the factory's own bar
 * (`CRITERIA`, 20% even for the tutorial) and says whether the candidate is
 * ready; sending stays a deliberate act.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CRITERIA, PIPELINE } from "./stages.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Commands that run one script directly, beyond the stage list. */
const COMMANDS: Record<string, { script: string; usage: string }> = {
	mine: { script: "tools/mine.sh", usage: "mine <owner/repo>…" },
	gates: { script: "tools/run_gates.sh", usage: "gates <dir>" },
	pipeline: { script: "tools/pipeline.sh", usage: "pipeline <dir> [runs]" },
	refine: { script: "tools/refine.sh", usage: "refine <dir> [max]" },
	criteria: { script: "tools/criteria.py", usage: "criteria <dir> [target-pct] [--action]" },
	readiness: { script: "tools/readiness.py", usage: "readiness <dir>" },
	difficulty: { script: "tools/difficulty.sh", usage: "difficulty <dir> [n]" },
	factory: { script: "tools/factory.sh", usage: "factory <dir>" },
};

const run = (script: string, args: string[]): Promise<number> =>
	new Promise((done) => {
		const path = join(ROOT, script);
		if (!existsSync(path)) {
			console.error(`olympus: missing ${script}`);
			done(2);
			return;
		}
		const cmd = script.endsWith(".py") ? "python3" : "bash";
		const child = spawn(cmd, [path, ...args], { stdio: "inherit" });
		child.on("error", (error) => {
			console.error(`olympus: could not run ${cmd}: ${error.message}`);
			done(127);
		});
		child.on("close", (code) => done(code ?? 1));
	});

const status = (): number => {
	console.log("olympus — the pipeline, cheapest first (stages.ts):\n");
	for (const s of PIPELINE) {
		console.log(`  ${s.id.padEnd(14)} ${s.cost.padEnd(13)} ${s.blocking ? "blocks " : "advises"}  ${s.proves}`);
	}
	console.log("\ncommands:");
	for (const c of Object.values(COMMANDS)) console.log(`  rlm olympus ${c.usage}`);
	console.log("  rlm olympus submit <dir> [--live]      checks readiness against the bar; never sends");
	const t = CRITERIA.tutorial;
	const o = CRITERIA.olympus;
	console.log(
		`\nbars: tutorial pass rate ≤ ${t.maxPassRatePct}% (platform allows ${t.platformBarPct}%), ≥ ${t.minRuns} runs;` +
			` live ≤ ${o.maxPassRatePct}%, ≥ ${o.minRuns} runs`,
	);
	return 0;
};

/** Free gates, then the measured criteria against the factory's bar. Never sends. */
const submit = async (args: string[]): Promise<number> => {
	const dir = args.find((a) => !a.startsWith("--"));
	if (!dir) {
		console.error("usage: rlm olympus submit <dir> [--live]");
		return 2;
	}
	const abs = resolve(dir);
	const target = (args.includes("--live") ? CRITERIA.olympus : CRITERIA.tutorial).maxPassRatePct;
	console.log("== free gates ==");
	if ((await run(COMMANDS.gates.script, [abs])) !== 0) {
		console.log("\nNOT READY — a free gate failed; fix it before spending anything.");
		return 1;
	}
	console.log(`\n== criteria (bar ${target}%) ==`);
	if ((await run(COMMANDS.criteria.script, [abs, String(target), "--action"])) !== 0) {
		console.log("\nNOT READY — a submission criterion does not hold (remedy above).");
		return 1;
	}
	console.log("\n== readiness ==");
	await run(COMMANDS.readiness.script, [abs]);
	console.log(
		"\nREADY by every local check. Sending spends shipd tokens and is not wired here:" +
			" no script records the platform's submit mutation (tools/oly.py is a generic client).",
	);
	if (args.includes("--confirm")) console.log("--confirm ignored: sending is not wired, deliberately.");
	return 0;
};

export const runOlympus = async (argv: string[]): Promise<number> => {
	const [stage, ...rest] = argv;
	if (!stage || stage === "status" || stage === "help" || stage === "--help") return status();
	if (stage === "submit") return submit(rest);
	const command = COMMANDS[stage];
	if (!command) {
		console.error(`olympus: unknown command "${stage}"`);
		status();
		return 2;
	}
	return run(command.script, rest);
};

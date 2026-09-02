/**
 * One-time repair for tasks that were given up on before the drive knew how to
 * ask for a different criterion.
 *
 * Four `agent-browser … search …` criteria exited non-zero no matter what,
 * because there is no `search` subcommand. Each was charged its attempts and
 * left `failed`, and twenty-three tasks went `unreachable` behind them. The
 * drive now hands such a task back for a new criterion when it exhausts, but
 * only as it runs — a task already sitting in `failed` is not runnable and
 * never gets there.
 *
 * So this clears exactly those: state `failed`, criterion a shell command.
 * Nothing is judged done, nothing is weakened — the proof becomes `unstated`
 * and the planner has to write one that can move, which is refused if it
 * already passes and refused again if it cannot.
 */
import { Store } from "../packages/rlm-delegate/src/store.ts";

const dry = process.argv.includes("--dry-run");
const store = new Store();
let cleared = 0;
let left = 0;

for (const id of store.ids()) {
	const graph = store.load(id);
	if (!graph) continue;
	for (const task of graph.tasks) {
		if (task.state !== "failed") continue;
		if (task.proof?.kind !== "shell") {
			left += 1;
			console.log(`  left   ${id}/${task.id} — ${task.proof?.kind} criterion, not a shell dead end`);
			continue;
		}
		console.log(`  clear  ${id}/${task.id} — ${task.title}`);
		console.log(`         was: ${task.proof.run}`);
		if (!dry) store.answered(id, task.id, { kind: "unstated" }, "a one-time repair, because this check never moved");
		cleared += 1;
	}
}

console.log(`\n${dry ? "would clear" : "cleared"} ${cleared}, left ${left} alone`);

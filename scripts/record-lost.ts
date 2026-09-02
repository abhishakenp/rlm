/**
 * The ideas that were spoken and never written down.
 *
 * They were acted on in conversation at the time and nothing tracked them, so
 * when the session ended they were gone — not owed, not failed, not questions.
 * Absent. That is worse than failing, because nothing can notice absence.
 */
import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";

const store = new Store();
const IRIS = "/Users/abhi/proj/sensei/iris-mama";

const graph = store.create(
	"The ideas he spoke the night of 2026-09-01 that were never recorded as work. " +
		"Each one is his, in his words, with what is already true about it.",
	[
		{
			id: "default-browser",
			title: "Open things in HIS default browser, not a random one",
			prompt:
				"His words: \"when i tell her to open browser or open anything else she should know what my " +
				"default one is and open that not anything random\". Nothing in iris-mama mentions a default " +
				"browser anywhere — grep for defaultBrowser across packages/ returns nothing. Read the system's " +
				"LSHandlerRoleAll for the http scheme (defaults read com.apple.LaunchServices/com.apple.launchservices.secure) " +
				"and make control.open use it. The same rule applies to any 'open X' where the system has a " +
				"registered default.",
			proof: {
				kind: "shell",
				run: `cd ${IRIS} && grep -rIl "LSHandlerRoleAll\\|defaultBrowser" --include=*.ts packages/ | head -1 | grep -q .`,
			},
		},
		{
			id: "slot-datatypes",
			title: "Slot datatypes far richer than string|number|boolean|enum",
			prompt:
				"His words: \"datatypes arent just enums, they can be strings too... hats off this works well. " +
				"it has to be made more powerful far more\". SlotType in packages/iris-recall/src/slots.ts is " +
				"currently exactly 'string' | 'number' | 'boolean' | 'enum'. String already works; what is asked " +
				"for is more kinds — at least date, duration, path, url, app and person — each with its own " +
				"parsing and validation, so a slot knows what it is holding rather than taking any words at all. " +
				"This is what stops a trigger from swallowing things it should not.",
			proof: {
				kind: "shell",
				run: `cd ${IRIS} && grep -q "'date'" packages/iris-recall/src/slots.ts && grep -q "'path'" packages/iris-recall/src/slots.ts`,
			},
		},
		{
			id: "micro-task-replay",
			title: "A micro task, once done, replays with no model at all",
			prompt:
				"His words: \"for micro tasks we can just spin new acpx... task->exec->verify->save iris " +
				"embeddings and tool calls so it can instantly be done later\". The cycle is: spin an acpx " +
				"session for the small thing, execute, VERIFY it worked, then save both the embedding of the " +
				"request and the exact tool calls that succeeded. An identical or near-identical request later " +
				"replays the saved calls directly. This is the difference between her being fast and her being " +
				"a wrapper round a model.",
			needs: ["slot-datatypes"],
			proof: { kind: "unstated", note: "needs a criterion naming where the saved calls live and how a replay is observed" },
		},
		{
			id: "no-embeddings-for-big-tasks",
			title: "Do not embed big tasks — only the small repeatable ones",
			prompt:
				"His words: \"for bigger tasks, we shouldnt store the embeddings\". A big task is never going to " +
				"recur in the same shape, so embedding it is storage that can only produce false matches. " +
				"Decide the boundary explicitly and enforce it where the embedding is written, not where it is " +
				"read.",
			needs: ["micro-task-replay"],
			proof: { kind: "unstated", note: "needs a criterion for what counts as big and where the refusal happens" },
		},
		{
			id: "first-hand-embeddings",
			title: "She remembers through her own embeddings, first hand",
			prompt:
				"His words: \"she must remember through first hand embedding support, that is how advanced " +
				"embedding must be\". Today recall matches trigger templates written into skills. First hand " +
				"means she embeds what actually happened — the request, what she did, whether it worked — and " +
				"recalls from that directly, so a thing she did once is findable even when nobody wrote a " +
				"trigger for it.",
			needs: ["micro-task-replay"],
			proof: { kind: "unstated", note: "needs a criterion: something she did once, recalled later without a trigger existing for it" },
		},
	],
);

console.log(`recorded ${graph.id} with ${graph.tasks.length} tasks`);
for (const task of graph.tasks) console.log(`  ${task.state.padEnd(9)} ${task.id} — ${task.title}`);

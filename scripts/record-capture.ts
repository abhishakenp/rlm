import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";
const store = new Store();
const graph = store.create(
	"Why the ideas were lost: nothing Iris hears becomes recorded work unless a person types it into the graph by hand.",
	[
		{
			id: "capture-what-he-says",
			title: "Everything he asks for is recorded as owed before it is answered",
			prompt:
				"`intake(request)` exists in packages/rlm-delegate/src/index.ts and nothing in iris-mama calls " +
				"it — grep the whole of packages/ there for a link between speech, delegation and a task graph " +
				"and it returns nothing. So a request he speaks is answered conversationally and never written " +
				"down. It is not owed, not failed, not a question: absent, and nothing can notice absence. " +
				"That is how better embeddings, richer slot datatypes, micro-task replay and the default " +
				"browser were all lost on the night of 2026-09-01 — every one of them was spoken, acted on in " +
				"the conversation, and gone when the session ended.\n\n" +
				"Wire the ears to intake. Anything he says that is a request for work is recorded in the graph " +
				"BEFORE it is answered, with the source marked, so answering it and finishing it are separate " +
				"facts. Chit-chat is not recorded — but when in doubt, record: an extra row he can close is " +
				"nothing, and a lost idea is what this is about.",
			proof: {
				kind: "shell",
				run:
					"cd /Users/abhi/proj/sensei/iris-mama && grep -rIl 'intake' --include=*.ts packages/ | grep -v test | head -1 | grep -q .",
			},
		},
	],
);
console.log(`recorded ${graph.id}: ${graph.tasks[0].title} [${graph.tasks[0].state}]`);

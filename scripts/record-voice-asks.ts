/**
 * Things he said out loud that never reached a keyboard.
 *
 * Found by reading ~/.always/transcripts.jsonl across the session window
 * rather than anybody's memory of it. None of these is in the task graph.
 */
import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";
const store = new Store();

const graph = store.create(
	"What he asked for by voice on 2026-09-01/02 that never became recorded work. Sourced from " +
		"~/.always/transcripts.jsonl, not from anybody's recollection.",
	[
		{
			id: "nepali-dictation",
			title: "Let him dictate in Nepali, and learn it rather than rule-match it",
			prompt:
				"[09-01 02:36] \"this model supports Hindi, which means it supports already\" and \"build the thing " +
				"that does the Nepali thing\". [02:37] \"If I could naturally speak in Nepali... it would save me " +
				"a lot of time\". He dictates in mixed Nepali/Hindi/English and the transcription mangles it — " +
				"[02:33] \"I spoke something, it understood something else, absolutely unusable\".\n\n" +
				"And the constraint on how, [02:35]: \"There must not be a stupid rule fallback like this, " +
				"absolutely shit and looks hardwired... it must be learned weights, not hardcoded\". So: no " +
				"language-detection heuristics, no phrase tables. Find whether the model already handles it, and " +
				"if it does not, the fix is a model or its weights, not a rule.",
			proof: { kind: "unstated", note: "needs a criterion: an utterance in Nepali transcribed correctly, named in advance" },
		},
		{
			id: "dictation-latency-constraint",
			title: "Latency is the absolute constraint, and nothing may be injected mid-flow",
			prompt:
				"[09-01 02:39] \"that is a huge problem and that should be the absolute constraint, and also " +
				"deterministically injecting shit — like I just tested, it makes it look uneven... that is not " +
				"matching with the rest of the generation and it just sucks really hard\". Measured by him " +
				"repeatedly that night: [01:52] \"this was like seven seconds\", [01:56] \"six to seven seconds, " +
				"which is absolutely unusable\", [01:58] \"that still took like five to six seconds\".\n\n" +
				"Two separate things. One: dictation latency is a hard budget, not a nice-to-have. Two: nothing " +
				"deterministic may be spliced into generated text — it reads as a seam and is worse than not " +
				"doing it.",
			proof: { kind: "unstated", note: "needs the number he will accept, and where the seam is being injected" },
		},
		{
			id: "kaggle-training-status",
			title: "Say what happened to the Kaggle training",
			prompt:
				"[09-01 02:35] \"You were doing something in Kaggle right, is that working, I mean is that done, " +
				"what's the status of that Kaggle training thing\". He asked and never got an answer. Find what " +
				"was running, whether it finished, and what came of it — or say plainly that it was dropped.",
			proof: { kind: "unstated", note: "needs whoever knows what the Kaggle run was; nothing in this repo names it" },
		},
		{
			id: "youtube-by-voice",
			title: "Open and play what he names on YouTube, by voice",
			prompt:
				"Three real commands he gave her out loud and that are not recorded anywhere: [09-01 19:36] " +
				"\"Iris open YouTube and the latest video from Theo GG\", [19:39] \"open the latest video from " +
				"Matt Pocock\", [19:40] \"play a South Indian movie on YouTube\". [19:18] sets the bar: \"when I " +
				"tell her to open the browser and play YouTube she should be able to when I come back\".\n\n" +
				"Not three skills — one capability: name a channel or a thing, get the right video playing, in " +
				"his default browser.",
			needs: ["default-browser-known"],
			proof: { kind: "unstated", note: "needs a criterion that can tell the right video from any video" },
		},
		{
			id: "default-browser-known",
			title: "She knows his default browser and terminal without being told again",
			prompt:
				"[09-02 00:53] \"Always remember that when I tell you to open terminal, I mean Ghostty is my " +
				"default terminal, so open that now, and always remember that\" — later corrected in her notes to " +
				"cmux, which is the current answer. The browser half has no answer at all: nothing in iris-mama " +
				"reads the system's default handler.\n\n" +
				"The pattern is the point, not the two apps: when he names a kind of thing, she opens the one he " +
				"actually uses. Read it from the system where the system knows, and from a standing preference " +
				"where it does not.",
			proof: {
				kind: "shell",
				run: "cd /Users/abhi/proj/sensei/iris-mama && grep -rIl 'LSHandlerRoleAll' --include=*.ts packages/ | head -1 | grep -q .",
			},
		},
		{
			id: "raycast-shortcuts",
			title: "Know the Raycast shortcuts he has configured",
			prompt:
				"[09-02 02:34] \"do you know the Raycast shortcuts that I've configured? Can you tell the Raycast " +
				"shortcuts that I've configured currently\". She could not. Read them from wherever Raycast keeps " +
				"them and be able to answer.",
			proof: { kind: "unstated", note: "needs to know where Raycast stores its configured shortcuts on this machine" },
		},
		{
			id: "fix-root-cause-not-report",
			title: "Never report a problem without also fixing its root cause",
			prompt:
				"[09-01 02:03] \"We should not just be straight about a problem and report it to me, you must also " +
				"completely solve the root cause of the problem\". A standing rule about how she works, not a " +
				"feature. It belongs in her prompt and in the gate that judges whether a turn is finished.",
			proof: { kind: "unstated", note: "needs deciding whether this is prompt, gate, or both — and how a violation is detected" },
		},
	],
);
console.log(`recorded ${graph.id} with ${graph.tasks.length} tasks`);
for (const t of graph.tasks) console.log(`  ${t.state.padEnd(9)} ${t.id} — ${t.title}`);

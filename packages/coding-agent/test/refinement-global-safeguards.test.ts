import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyRefinementProposal,
	hostCausedFailure,
	listGlobalLessons,
	loadHarnessState,
	removeGlobalLessons,
	saveHarnessState,
	screenGlobalProposal,
	type HarnessState,
	type RefinementProposal,
} from "../src/core/refinement/refinement.js";
import { KERNEL_HOST_APIS } from "../src/core/tools/code.js";

/**
 * The global store is loaded into every session's prompt. On 2026-09-25 a
 * kernel mid-hot-reload produced errors that auto-refine promoted to a global
 * lesson: "rlm.spawn / context.set / agent_message are not available in the
 * code tool" — false, and enough to stop subagent spawning everywhere.
 */

const WRONG_LESSON =
	"RLM harness APIs (agent_message, rlm, rlm.run, rlm.spawn, context.set) are only available in agent thinking/response context — not inside code tool sandbox. Never attempt agent_message.send(), rlm.spawn(), context.set() inside a code tool call.";
const TRUE_LESSON =
	"The code tool is a vm context, not a module: __dirname, __filename and module are NOT defined (use cwd, process.cwd(), path.resolve).";

const proposal = (...edits: RefinementProposal["edits"]): RefinementProposal => ({
	summary: "s",
	rationale: "r",
	expectedOutcome: "e",
	edits,
});

const emptyState = (): HarnessState => loadHarnessState(mkdtempSync(join(tmpdir(), "harness-")), "global");

describe("global lesson safeguards", () => {
	it("refuses a lesson claiming a host API is unavailable", () => {
		const { proposal: kept, rejected } = screenGlobalProposal(
			proposal({ action: "create", kind: "prompt", id: "no-harness-apis", title: "t", content: WRONG_LESSON }),
			emptyState(),
			{ hostGlobals: KERNEL_HOST_APIS },
		);
		expect(kept.edits).toEqual([]);
		expect(rejected[0]?.error).toMatch(/the code kernel binds/);
	});

	it("keeps a true lesson that only mentions a host API in passing", () => {
		const { proposal: kept, rejected } = screenGlobalProposal(
			proposal({ action: "create", kind: "memory", id: "sandbox", title: "sandbox", content: TRUE_LESSON }),
			emptyState(),
			{ hostGlobals: KERNEL_HOST_APIS },
		);
		expect(rejected).toEqual([]);
		expect(kept.edits).toHaveLength(1);
	});

	it("caps the store by entries and by content size", () => {
		const state = emptyState();
		const edits = Array.from({ length: 4 }, (_, i) => ({
			action: "create" as const,
			kind: "memory" as const,
			id: `m${i}`,
			title: `m${i}`,
			content: "x".repeat(10),
		}));
		const byEntries = screenGlobalProposal(proposal(...edits), state, { maxEntries: 2 });
		expect(byEntries.proposal.edits.map((e) => e.id)).toEqual(["m0", "m1"]);
		expect(byEntries.rejected.map((e) => e.error)).toEqual([expect.stringMatching(/full/), expect.stringMatching(/full/)]);
		const byChars = screenGlobalProposal(proposal(...edits), state, { maxChars: 25 });
		expect(byChars.proposal.edits).toHaveLength(2);
		expect(byChars.rejected[0]?.error).toMatch(/content limit/);
	});

	it.each([
		["Error: Code kernel provisioner disposed", /disposed/],
		["ReferenceError: agent_message is not defined", /agent_message/],
		["SyntaxError: Unexpected token in /Users/abhi/proj/rlm/packages/rlm-host/src/shell.ts", /own source/],
		["agent_message.send exists in the code tool, but this session does not provide it: …", /capability/],
	])("treats %s as rlm's own fault", (text, cause) => {
		expect(hostCausedFailure(text, KERNEL_HOST_APIS)).toMatch(cause);
	});

	it.each(["ENOENT: no such file or directory, open './packages/x.ts'", "ReferenceError: __dirname is not defined"])(
		"treats %s as an ordinary tool error",
		(text) => {
			expect(hostCausedFailure(text, KERNEL_HOST_APIS)).toBeUndefined();
		},
	);

	it("lists and removes global lessons through the store", () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-"));
		const state = loadHarnessState(dir, "global");
		applyRefinementProposal(
			state,
			proposal(
				{ action: "create", kind: "prompt", id: "bad", title: "bad", content: "wrong" },
				{ action: "create", kind: "memory", id: "good", title: "good", content: "right" },
			),
			{ id: "r1", scope: "global" },
		);
		saveHarnessState(dir, state);
		expect(listGlobalLessons(dir).map((l) => l.id).sort()).toEqual(["bad", "good"]);
		const removed = removeGlobalLessons(["bad", "nope"], "test", dir);
		expect(removed.appliedEdits.filter((e) => e.applied).map((e) => e.id)).toEqual(["bad"]);
		expect(listGlobalLessons(dir).map((l) => l.id)).toEqual(["good"]);
	});
});

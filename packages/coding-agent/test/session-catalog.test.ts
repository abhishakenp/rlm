import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessionCatalog, listSessionFiles, scopeToCwd } from "../src/core/session-catalog.js";

let root: string;
let sessions: string;
let artifacts: string;
let cachePath: string;

const header = (id: string, cwd: string, parent?: string, depth = 0) =>
	JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2026-09-25T10:00:00.000Z",
		cwd,
		...(parent ? { parentSession: parent } : {}),
		rlmDepth: depth,
	});

const turn = (text: string, input = 100, output = 10) =>
	[
		JSON.stringify({
			type: "message",
			id: `u-${text}`,
			parentId: null,
			timestamp: "2026-09-25T10:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
		}),
		JSON.stringify({
			type: "message",
			id: `a-${text}`,
			parentId: `u-${text}`,
			timestamp: "2026-09-25T10:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `re: ${text}` }],
				usage: {
					input,
					output,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input + output,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
				},
				timestamp: 2,
			},
		}),
	].join("\n");

const write = (path: string, lines: string[]) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`);
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "rlm-catalog-"));
	sessions = join(root, "sessions");
	artifacts = join(root, "session-artifacts");
	cachePath = join(root, "session-catalog.json");
	const rootFile = join(sessions, "r1.jsonl");
	const childFile = join(artifacts, "r1", "sub-aaaa", "c1.jsonl");
	const grandFile = join(artifacts, "r1", "session-artifacts", "c1", "sub-bbbb", "g1.jsonl");
	const greatFile = join(artifacts, "r1", "session-artifacts", "c1", "session-artifacts", "g1", "sub-cccc", "gg1.jsonl");
	write(rootFile, [header("r1", "/proj/a"), JSON.stringify({ type: "model_change", id: "m", parentId: null, timestamp: "2026-09-25T10:00:00.500Z", provider: "omniroute", modelId: "auto/best-free" }), turn("root")]);
	write(childFile, [header("c1", "/proj/a", rootFile, 1), turn("child", 200, 20)]);
	write(grandFile, [header("g1", "/elsewhere", childFile, 2), turn("grand", 300, 30)]);
	write(greatFile, [header("gg1", "/elsewhere", grandFile, 3), turn("great")]);
	// The layout rlm writes today: a grandchild's sub-* inside its parent's sub-*.
	write(join(artifacts, "r1", "sub-aaaa", "sub-dddd", "g2.jsonl"), [header("g2", "/proj/a", childFile, 2), turn("g2")]);
	write(join(sessions, "r2.jsonl"), [header("r2", "/proj/b"), turn("other project")]);
	write(join(sessions, "rlm-delegate-g1-t1.jsonl"), [header("d1", "/proj/a"), turn("delegated")]);
	// Not a session: tool output under an artifact dir must not be picked up.
	write(join(artifacts, "r1", "harness", "state.jsonl"), [header("noise", "/proj/a")]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("session catalog", () => {
	it("finds subagents at every depth under session-artifacts, and nothing else there", async () => {
		const files = (await listSessionFiles(sessions, artifacts)).map((f) => f.slice(root.length));
		expect(files.sort()).toEqual(
			[
				"/sessions/r1.jsonl",
				"/sessions/r2.jsonl",
				"/sessions/rlm-delegate-g1-t1.jsonl",
				"/session-artifacts/r1/sub-aaaa/c1.jsonl",
				"/session-artifacts/r1/sub-aaaa/sub-dddd/g2.jsonl",
				"/session-artifacts/r1/session-artifacts/c1/sub-bbbb/g1.jsonl",
				"/session-artifacts/r1/session-artifacts/c1/session-artifacts/g1/sub-cccc/gg1.jsonl",
			].sort(),
		);
	});

	it("links each child to its parent's file and carries depth, model and usage", async () => {
		const rows = await listSessionCatalog({ sessionsDir: sessions, cachePath });
		const byId = new Map(rows.map((r) => [r.id, r]));
		expect([...byId.keys()].sort()).toEqual(["c1", "g1", "g2", "gg1", "r1", "r2"]);
		expect(byId.get("c1")?.parentSessionPath).toBe(byId.get("r1")?.path);
		expect(byId.get("g2")?.parentSessionPath).toBe(byId.get("c1")?.path);
		expect(byId.get("g1")?.parentSessionPath).toBe(byId.get("c1")?.path);
		expect(byId.get("gg1")?.parentSessionPath).toBe(byId.get("g1")?.path);
		expect(byId.get("gg1")?.rlmDepth).toBe(3);
		expect(byId.get("r1")?.model).toEqual({ provider: "omniroute", modelId: "auto/best-free" });
		expect(byId.get("g1")?.usage).toEqual({ inputTokens: 300, outputTokens: 30, cost: 0.5 });
	});

	it("leaves delegated task sessions out unless asked", async () => {
		const without = await listSessionCatalog({ sessionsDir: sessions, cachePath });
		expect(without.some((r) => r.id === "d1")).toBe(false);
		const withThem = await listSessionCatalog({ sessionsDir: sessions, cachePath, includeDelegated: true });
		expect(withThem.some((r) => r.id === "d1")).toBe(true);
	});

	it("paints from the index first, then re-reads only what changed", async () => {
		await listSessionCatalog({ sessionsDir: sessions, cachePath });
		expect(JSON.parse(readFileSync(cachePath, "utf8")).rows).toBeTruthy();

		// Change the child on disk; its cached row is emitted first, the fresh one after.
		const childFile = join(artifacts, "r1", "sub-aaaa", "c1.jsonl");
		write(childFile, [header("c1", "/proj/a", join(sessions, "r1.jsonl"), 1), turn("child", 200, 20), turn("again", 1, 1)]);
		utimesSync(childFile, new Date(), new Date(Date.now() + 5_000));

		const seen: Array<{ id: string; messages: number }> = [];
		const rows = await listSessionCatalog({
			sessionsDir: sessions,
			cachePath,
			onSession: (s) => seen.push({ id: s.id, messages: s.messageCount }),
		});
		const childEmits = seen.filter((s) => s.id === "c1");
		expect(childEmits).toEqual([
			{ id: "c1", messages: 2 },
			{ id: "c1", messages: 4 },
		]);
		// Unchanged rows are emitted once (from the index), not re-read.
		expect(seen.filter((s) => s.id === "r1")).toHaveLength(1);
		expect(rows.find((r) => r.id === "c1")?.messageCount).toBe(4);
	});

	it("drops a deleted file from the settled catalog and the index", async () => {
		await listSessionCatalog({ sessionsDir: sessions, cachePath });
		rmSync(join(sessions, "r2.jsonl"));
		const rows = await listSessionCatalog({ sessionsDir: sessions, cachePath });
		expect(rows.some((r) => r.id === "r2")).toBe(false);
		expect(Object.keys(JSON.parse(readFileSync(cachePath, "utf8")).rows).some((p) => p.endsWith("r2.jsonl"))).toBe(
			false,
		);
	});

	it("scopes to a folder but keeps descendants that recorded another cwd", async () => {
		const rows = await listSessionCatalog({ sessionsDir: sessions, cachePath, cwd: "/proj/a" });
		expect(rows.map((r) => r.id).sort()).toEqual(["c1", "g1", "g2", "gg1", "r1"]);
		expect(scopeToCwd(rows, "/proj/b")).toEqual([]);
	});
});

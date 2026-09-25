import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { irisLaunchArgs } from "../../rlm-iris/src/index.js";
import { parseArgs } from "../src/cli/args.js";
import { opensAgentsViewForResume, sessionManagerFromArgs } from "../src/cli/session-startup.js";

/**
 * The Cordis launch path (rlm-modes → renderer / print rows) reads the session
 * flags through these. Before, nothing on that path read them: `rlm -r` opened a
 * fresh chat and `rlm --resume <id>` started a new session file.
 */
describe("session flags on the plugin launch path", () => {
	let home: string;
	let cwd: string;
	let sessionDir: string;
	const savedHome = process.env.HOME;
	const savedAgentDir = process.env.RLM_CODING_AGENT_DIR;

	const writeSession = (id: string, sessionCwd: string, text: string, dir = sessionDir): string => {
		const file = join(dir, `${id}.jsonl`);
		const lines = [
			{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: sessionCwd, rlmDepth: 0 },
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
			},
		];
		writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		return file;
	};

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "rlm-session-startup-"));
		cwd = join(home, "project");
		sessionDir = join(home, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		process.env.HOME = home;
		process.env.RLM_CODING_AGENT_DIR = join(home, ".rlm", "agent");
	});

	afterEach(() => {
		process.env.HOME = savedHome;
		if (savedAgentDir === undefined) delete process.env.RLM_CODING_AGENT_DIR;
		else process.env.RLM_CODING_AGENT_DIR = savedAgentDir;
		rmSync(home, { recursive: true, force: true });
	});

	test("no session flag leaves the session row's fresh session in place", async () => {
		expect(await sessionManagerFromArgs(parseArgs([]), cwd)).toBeUndefined();
		expect(await sessionManagerFromArgs(parseArgs(["--print", "--session-id", "x", "--", "hi"]), cwd)).toBeUndefined();
	});

	test("bare -r opens the agents view instead of a chat, and names no session", async () => {
		const parsed = parseArgs(["-r"]);
		expect(opensAgentsViewForResume(parsed)).toBe(true);
		expect(await sessionManagerFromArgs(parsed, cwd)).toBeUndefined();
		// A selector, --continue or --fork opens its target directly.
		expect(opensAgentsViewForResume(parseArgs(["-r", "abc"]))).toBe(false);
		expect(opensAgentsViewForResume(parseArgs(["-c"]))).toBe(false);
		expect(opensAgentsViewForResume(parseArgs(["--resume=abc"]))).toBe(false);
	});

	test("--resume <id>, --resume=<id> and -r <prefix> open the same saved session", async () => {
		const id = "01a0d9dc-327b-7330-82b4-52695c917707";
		const file = writeSession(id, cwd, "remember ZEBRA");
		for (const argv of [
			["--resume", id, "--session-dir", sessionDir],
			[`--resume=${id}`, `--session-dir=${sessionDir}`],
			["-r", "01a0d9dc", "--session-dir", sessionDir],
		]) {
			const manager = await sessionManagerFromArgs(parseArgs(argv), cwd);
			expect(manager?.getSessionFile(), argv.join(" ")).toBe(file);
			expect(manager?.getSessionId()).toBe(id);
		}
	});

	test("-c continues the most recent session for this directory, not the newest anywhere", async () => {
		const mine = writeSession("01a0aaaa-0000-7000-8000-000000000001", cwd, "mine");
		writeSession("01a0aaaa-0000-7000-8000-000000000002", join(home, "elsewhere"), "newer, other project");
		const manager = await sessionManagerFromArgs(parseArgs(["-c", "--session-dir", sessionDir]), cwd);
		expect(manager?.getSessionFile()).toBe(mine);
	});

	test("the Iris launch: --resume=~/… and --session-dir=~/… expand ~, and a missing file is created there", async () => {
		const argv = irisLaunchArgs([]);
		expect(argv).toEqual(["--resume=~/.iris/mind/sessions/iris.jsonl", "--session-dir=~/.iris/mind/sessions"]);
		const parsed = parseArgs(argv);
		expect(parsed.resume).toBe("~/.iris/mind/sessions/iris.jsonl");
		expect(parsed.sessionDir).toBe("~/.iris/mind/sessions");

		const irisDir = join(home, ".iris", "mind", "sessions");
		mkdirSync(irisDir, { recursive: true });
		const manager = await sessionManagerFromArgs(parsed, cwd);
		const expected = join(irisDir, "iris.jsonl");
		expect(manager?.getSessionFile()).toBe(expected);
		expect(manager?.getSessionDir()).toBe(irisDir);

		// Written where it was asked for, on the first flush.
		manager!.appendMessage({ role: "user", content: [{ type: "text", text: "hello iris" }], timestamp: Date.now() });
		manager!.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
		expect(readFileSync(expected, "utf8")).toContain("hello iris");

		// And the next Iris launch reopens that same file.
		const again = await sessionManagerFromArgs(parseArgs(irisLaunchArgs([])), cwd);
		expect(again?.getSessionFile()).toBe(expected);
		expect(again?.getSessionId()).toBe(manager!.getSessionId());
	});

	test("the Iris flags are not added over a caller's own choice", () => {
		expect(irisLaunchArgs(["--resume", "abc"])).toEqual(["--resume", "abc", "--session-dir=~/.iris/mind/sessions"]);
		expect(irisLaunchArgs(["--session-dir", "/x"])).toEqual(["--resume=~/.iris/mind/sessions/iris.jsonl", "--session-dir", "/x"]);
	});
});

/**
 * rlm-iris mounts ACTIVE whatever else is mounted (the Sep 6 rewrite injected
 * services that do not exist and parked PENDING for ever), registers `rlm iris`,
 * `/rlm status` and `/iris` on the real service names, takes them back when the
 * row goes, and launches Iris with its one fixed session.
 * Run: `bun test packages/rlm-iris/test/rlm-iris.test.ts`.
 */
import { expect, test } from "bun:test";
import { Context, Service } from "@deepseek-ai/cordis";

process.env.IRIS_BIN = "/bin/echo";
const { default: RlmIris, irisLaunchArgs, irisBinary } = await import("../src/index.ts");

const settle = async (pred: () => boolean) => {
	for (let i = 0; i < 200 && !pred(); i++) await Bun.sleep(5);
};

test("launch args add the fixed session unless the caller chose one", () => {
	expect(irisLaunchArgs([])).toEqual(["--resume=~/.iris/mind/sessions/iris.jsonl", "--session-dir=~/.iris/mind/sessions"]);
	expect(irisLaunchArgs(["--resume", "x.jsonl"])).toEqual(["--resume", "x.jsonl", "--session-dir=~/.iris/mind/sessions"]);
	expect(irisLaunchArgs(["--resume=y", "--session-dir=/d"])).toEqual(["--resume=y", "--session-dir=/d"]);
	expect(irisLaunchArgs(["-r"])).toEqual(["-r", "--session-dir=~/.iris/mind/sessions"]);
	expect(irisBinary("/nonexistent/iris")).toBe("/nonexistent/iris");
});

test("mounts ACTIVE with nothing else mounted, and says rlm-delegate is missing", async () => {
	const root: any = new Context();
	root.plugin(RlmIris, {});
	await settle(() => !!root.get("iris"));
	const iris = root.get("iris");
	expect(iris).toBeTruthy();
	await expect(iris.iris()).rejects.toThrow("rlm-delegate is not mounted");
	expect(await iris.status()).toEqual({ recent: [] });
});

test("registers on the real service names and takes it all back on removal", async () => {
	const modes = new Map<string, any>();
	const slash = new Map<string, any>();
	const shown: string[] = [];
	class Modes extends Service {
		static provide = "rlmModes";
		register(m: any) {
			modes.set(m.id, m);
			return { dispose: () => modes.delete(m.id) };
		}
	}
	class Tui extends Service {
		static provide = "rlmTui";
		registerSlashCommand(_id: string, ext: any) {
			slash.set(ext.name, ext);
			return { dispose: () => slash.delete(ext.name) };
		}
	}
	class Delegate extends Service {
		static provide = "rlmDelegate";
		open() {
			return [{ id: "g1", goal: "goal", createdAt: "t", tasks: [{ id: "a", title: "A", state: "ready" }] }];
		}
	}
	class Sdk extends Service {
		static provide = "rlmSdk";
		listSubagents() {
			return [{ id: "s1", name: "n", status: "running", sessionName: "sn" }];
		}
		recentSubagents() {
			return [{ id: "s0", name: "done", completedAt: "t2" }];
		}
	}
	const root: any = new Context();
	const modesFiber = root.plugin(Modes);
	root.plugin(Tui);
	root.plugin(Delegate);
	root.plugin(Sdk);
	const fiber = root.plugin(RlmIris, {});
	await settle(() => modes.has("iris") && slash.has("rlm") && slash.has("iris"));

	expect(modes.get("iris").claims(["iris", "x"])).toBe(true);
	expect(modes.get("iris").claims(["--print", "x"])).toBe(false);

	await slash.get("rlm").handler("status", { showMessage: (t: string) => shown.push(t) });
	const status = JSON.parse(shown[0].replace(/^```json\n|\n```$/g, ""));
	expect(status.graphs[0].tasks[0].id).toBe("a");
	expect(status.subagents[0].id).toBe("s1");
	expect(status.recent[0].id).toBe("s0");

	// `rlm iris --flag` runs the binary with the session flags (echo exits 0).
	expect(await modes.get("iris").run(["iris", "--flag"])).toBe(0);

	// A hot swap of rlm-modes: the mode comes back on the new instance.
	modesFiber.dispose();
	await settle(() => !modes.has("iris"));
	expect(modes.has("iris")).toBe(false);
	root.plugin(Modes);
	await settle(() => modes.has("iris"));
	expect(modes.has("iris")).toBe(true);

	fiber.dispose();
	await settle(() => !modes.has("iris") && slash.size === 0);
	expect(modes.has("iris")).toBe(false);
	expect(slash.size).toBe(0);
});

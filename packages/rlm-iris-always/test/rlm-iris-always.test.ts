/**
 * rlm-iris-always against a stub `always` service and a fake `iris` binary that
 * records its argv. Nothing here types into the real desktop or runs Iris.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import IrisAlways, { decide, stripWakeWord } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "iris-always-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await sleep(25);
	return cond();
};

describe("routing rules", () => {
	test("wake word is matched like the daemon: exact, then space or comma, any case", () => {
		expect(stripWakeWord("Iris, open mail")).toEqual({ led: true, rest: "open mail" });
		expect(stripWakeWord("iris lock")).toEqual({ led: true, rest: "lock" });
		expect(stripWakeWord("iris")).toEqual({ led: true, rest: "" });
		expect(stripWakeWord("irises bloom")).toEqual({ led: false, rest: "irises bloom" });
	});

	test("focused: type unless wake-word-led; not focused: only wake-word-led runs", () => {
		expect(decide("dear diary", true)).toEqual({ action: "type", text: "dear diary" });
		expect(decide("iris open safari", true)).toEqual({ action: "command", text: "open safari" });
		expect(decide("iris open safari", false)).toEqual({ action: "command", text: "open safari" });
		expect(decide("just talking", false)).toEqual({ action: "ignore", text: "" });
		expect(decide("   ", true)).toEqual({ action: "ignore", text: "" });
	});
});

/** A stand-in for the `always` row: tests push transcripts through it. */
class StubAlways extends Service {
	static provide = "always" as const;
	handlers = new Set<(t: any) => void>();
	constructor(ctx: any) {
		super(ctx, undefined as any);
	}
	onTranscript(h: (t: any) => void) {
		this.handlers.add(h);
		return () => this.handlers.delete(h);
	}
	onFocusChange() {
		return () => {};
	}
	push(t: any) {
		for (const h of this.handlers) h(t);
	}
}

describe("row", () => {
	test("hands final Iris speech to `iris <words>` as argv (never a shell), ignores partials, unsubscribes on dispose", async () => {
		const log = join(dir, "argv.log");
		const bin = join(dir, "iris");
		writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n`);
		chmodSync(bin, 0o755);
		writeFileSync(log, "");

		const root: any = new Context();
		root.plugin(StubAlways);
		await sleep(50);
		const fiber = root.plugin(IrisAlways, { irisBin: bin });
		await until(() => !!root.alwaysMode);
		const stub = root.always as StubAlways;
		expect(stub.handlers.size).toBe(1);

		stub.push({ text: "iris what's on; rm -rf /tmp/x", partial: false, source: "always", ts: "" });
		stub.push({ text: "preview only", partial: true, source: "always", ts: "" });
		expect(await until(() => readFileSync(log, "utf8").length > 0, 10_000)).toBe(true);
		await sleep(200);
		expect(readFileSync(log, "utf8")).toBe("what's on; rm -rf /tmp/x\n");

		fiber.dispose();
		await sleep(50);
		expect(stub.handlers.size).toBe(0);
	}, 20_000);

	test("provides alwaysMode, not always — it must coexist with the Always row", () => {
		expect(IrisAlways.provide).toBe("alwaysMode");
		expect(IrisAlways.inject).toEqual(["always"]);
	});
});

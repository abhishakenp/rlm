import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// rlm runs the TypeScript sources under bun. There, extensions loaded by jiti
// used to get a second, jiti-transformed copy of every pi package (aliases),
// so an extension's CustomEditor / Container were not the classes the TUI
// renders with, and a changed file came back stale on reload. The probe runs
// the real loader under bun and reports what the extension actually got.
describe("extension loader under bun", () => {
	it("serves the live pi package instances and re-reads changed files", () => {
		const probe = join(__dirname, "fixtures", "extension-live-modules", "probe.ts");
		const result = spawnSync("bun", [probe], {
			cwd: join(__dirname, ".."),
			encoding: "utf8",
			timeout: 120_000,
		});
		expect(result.status, result.stderr).toBe(0);
		const line = result.stdout.trim().split("\n").at(-1) ?? "";
		const report = JSON.parse(line);
		expect(report.errors).toEqual([]);
		expect(report.commands).toContain("probe");
		expect(report.customEditorShared).toBe(true);
		expect(report.earendilAliasShared).toBe(true);
		expect(report.tuiShared).toBe(true);
		expect(report.reload).toEqual(["one", "two"]);
	}, 150_000);
});

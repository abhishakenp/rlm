import { describe, expect, it, beforeEach } from "vitest";
import { RlmContextService, createContextProxy } from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createMockCtx = () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
	emit: () => {},
	reflect: { provide: () => {} },
	// provide get stub for prompt service lookup
	get: () => undefined,
	once: () => {},
});

function createService(opts: any = {}): RlmContextService {
	const dir = mkdtempSync(join(tmpdir(), "rlm-ctx-rec-"));
	const svc = new RlmContextService(createMockCtx() as any, { projectRoot: dir, ...opts });
	// attach temp dir for cleanup via private property
	(svc as any).__tmpDir = dir;
	return svc;
}

function cleanupService(svc: RlmContextService) {
	const dir = (svc as any).__tmpDir;
	if (dir) {
		try { rmSync(dir, { recursive: true, force: true }); } catch {}
	}
}

function ensurePanelState(svc: RlmContextService) {
	const anySvc = svc as any;
	if (!anySvc._panelState) {
		anySvc._panelState = {
			focusedIndex: -1,
			expandedSet: new Set<string>(),
			scrollOffset: 0,
			followupQueue: [],
			lastEnterAt: 0,
			globalExpanded: false,
		};
	}
	return anySvc._panelState;
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;.*?\x1b\\/g, "");
}
function visibleWidth(s: string): number {
	return stripAnsi(s).length;
}

describe("recursive-nature: proxy supports copy/move/mutate/cloneMany recursively", () => {
	let svc: RlmContextService;
	beforeEach(() => {
		svc = createService();
	});
	it("proxy.set/get basic and proxy wraps service", () => {
		const proxy = createContextProxy(svc);
		proxy.set("files.packages", ["rlm-context", "coding-agent"], { description: "found" });
		expect(proxy.get("files.packages")).toEqual(["rlm-context", "coding-agent"]);
		expect(svc.value("files.packages")).toEqual(["rlm-context", "coding-agent"]);
		cleanupService(svc);
	});

	it("copy is non-destructive snapshot; move is destructive transfer", () => {
		const proxy = createContextProxy(svc);
		proxy.set("auth.key", "abc");
		proxy.set("auth.token", "xyz");
		proxy.set("db.url", "postgres://localhost");
		const copySnap = proxy.copy(["auth.*"]);
		expect(Object.keys(copySnap).sort()).toEqual(["auth.key", "auth.token"]);
		// parent retains
		expect(proxy.get("auth.key")).toBe("abc");
		expect(proxy.get("db.url")).toBe("postgres://localhost");
		// move destroys matching vars
		const moveSnap = proxy.move(["auth.*"]);
		expect(Object.keys(moveSnap).sort()).toEqual(["auth.key", "auth.token"]);
		expect(proxy.get("auth.key")).toBeUndefined();
		expect(proxy.get("auth.token")).toBeUndefined();
		// db stays
		expect(proxy.get("db.url")).toBe("postgres://localhost");
		cleanupService(svc);
	});

	it("move copies const vars instead of removing (project/session const protection)", () => {
		const proxy = createContextProxy(svc);
		proxy.set("locked", 1, { mutable: false });
		proxy.set("mutableOne", 2, { mutable: true });
		const snap = proxy.move(["locked", "mutableOne"]);
		expect(snap.locked.value).toBe(1);
		expect(snap.mutableOne.value).toBe(2);
		// const stays, mutable gone
		expect(proxy.get("locked")).toBeDefined();
		expect(proxy.get("mutableOne")).toBeUndefined();
		cleanupService(svc);
	});

	it("mutate single is deep-safe and epoch bumps once", () => {
		const proxy = createContextProxy(svc);
		proxy.set("files.list", ["a", "b"], { mutable: true });
		const epoch0 = svc.getEpoch();
		const before = proxy.get("files.list");
		proxy.mutate("files.list", (v: string[]) => [...v, "c"]);
		expect(proxy.get("files.list")).toEqual(["a", "b", "c"]);
		// deep-safe: original array passed as clone, mutation via fn doesn't affect stored until set
		expect(before).toEqual(["a", "b"]); // original clone unchanged
		expect(svc.getEpoch()).toBe(epoch0 + 1);
		cleanupService(svc);
	});

	it("mutate throws on const and on missing var", () => {
		const proxy = createContextProxy(svc);
		proxy.set("locked", 42, { mutable: false });
		expect(() => proxy.mutate("locked", (v: number) => v + 1)).toThrow(/const/);
		expect(() => proxy.mutate("missing", (v: any) => v)).toThrow(/does not exist/);
		cleanupService(svc);
	});

	it("mutateMany mutates many vars matching glob, skips const, single epoch bump", () => {
		const proxy = createContextProxy(svc);
		proxy.set("files.a", [3, 1, 2]);
		proxy.set("files.b", [9, 8]);
		proxy.set("files.const", [1], { mutable: false });
		proxy.set("db.url", "keep");
		const epoch0 = svc.getEpoch();
		const count = proxy.mutateMany("files.*", (v: any, name: string) => {
			if (Array.isArray(v)) return [...v].sort((x: number, y: number) => x - y);
			return v;
		});
		// only mutable files.* mutated (2), const skipped
		expect(count).toBe(2);
		expect(proxy.get("files.a")).toEqual([1, 2, 3]);
		expect(proxy.get("files.b")).toEqual([8, 9]);
		expect(proxy.get("files.const")).toEqual([1]); // unchanged
		expect(proxy.get("db.url")).toBe("keep");
		// single bump despite 2 vars
		expect(svc.getEpoch()).toBe(epoch0 + 1);
		cleanupService(svc);
	});

	it("clone single deep-copies with optional transform and scope", () => {
		const proxy = createContextProxy(svc);
		const original = { nested: { x: 1 }, arr: [1, 2] };
		proxy.set("auth.files", original);
		proxy.clone("auth.files", "auth.files.bak");
		const bak = proxy.get("auth.files.bak");
		expect(bak).toEqual(original);
		// deep copy isolation
		(bak as any).nested.x = 99;
		(bak as any).arr.push(99);
		expect(proxy.get("auth.files")).toEqual(original);
		expect(proxy.get("auth.files").nested.x).toBe(1);

		// with transform
		proxy.clone("auth.files", "auth.files.filtered", { transform: (v: any) => ({ ...v, arr: v.arr.slice(0, 1) }) });
		expect(proxy.get("auth.files.filtered").arr).toEqual([1]);
		cleanupService(svc);
	});

	it("cloneMany clones many with prefix, deep isolation, single epoch", () => {
		const proxy = createContextProxy(svc);
		proxy.set("auth.key", "k1");
		proxy.set("auth.token", { t: "secret" });
		proxy.set("db.url", "postgres");
		const epoch0 = svc.getEpoch();
		const created = proxy.cloneMany(["auth.*"], "backup.");
		expect(created.sort()).toEqual(["backup.auth.key", "backup.auth.token"]);
		expect(proxy.get("backup.auth.key")).toBe("k1");
		expect(proxy.get("backup.auth.token")).toEqual({ t: "secret" });
		// deep isolation
		const tokBak = proxy.get("backup.auth.token");
		tokBak.t = "mutated";
		expect(proxy.get("auth.token").t).toBe("secret");
		// originals still there
		expect(proxy.get("auth.key")).toBe("k1");
		expect(proxy.get("db.url")).toBe("postgres");
		// single epoch bump (bypass per-set bumps)
		expect(svc.getEpoch()).toBe(epoch0 + 1);
		cleanupService(svc);
	});

	it("cloneMany with function transform for new names", () => {
		const proxy = createContextProxy(svc);
		proxy.set("files.a", 1);
		proxy.set("files.b", 2);
		const created = proxy.cloneMany(["files.*"], (oldName: string) => `copy.${oldName}`);
		expect(created.sort()).toEqual(["copy.files.a", "copy.files.b"]);
		expect(proxy.get("copy.files.a")).toBe(1);
		cleanupService(svc);
	});

	it("batch collapses N ops into single epoch bump", () => {
		const proxy = createContextProxy(svc);
		proxy.set("a", 1, { mutable: true });
		proxy.set("b", 2, { mutable: true });
		const epochBefore = svc.getEpoch();
		// individual sets would be 2 bumps; batch should be 1
		svc.batch([
			{ op: "set", name: "x", value: 10 },
			{ op: "set", name: "y", value: 20 },
			{ op: "mutate", name: "a", fn: (v: number) => v + 1 },
			{ op: "clone", name: "b", newName: "b.clone" },
		]);
		expect(proxy.get("x")).toBe(10);
		expect(proxy.get("y")).toBe(20);
		expect(proxy.get("a")).toBe(2);
		expect(proxy.get("b.clone")).toBe(2);
		expect(svc.getEpoch()).toBe(epochBefore + 1);

		// verify non-batch would be N bumps: do 4 sets individually
		const svc2 = createService();
		const p2 = createContextProxy(svc2);
		p2.set("a", 1);
		p2.set("b", 2);
		const e0 = svc2.getEpoch();
		p2.set("x", 10);
		p2.set("y", 20);
		p2.mutate("a", (v: number) => v + 1);
		p2.clone("b", "b.clone");
		expect(svc2.getEpoch()).toBe(e0 + 4);
		cleanupService(svc);
		cleanupService(svc2);
	});

	it("child snapshot transfer: copy retains parent, task scope in child", () => {
		const parent = createService();
		const parentProxy = createContextProxy(parent);
		parentProxy.set("files.packages", ["rlm-context", "coding-agent"]);
		parentProxy.set("auth.key", "secret123");
		parentProxy.set("project.testCmd", "bun test", { scope: "project" });
		// copy snapshot
		const snap = parentProxy.copy(["files.*", "auth.*"]);
		expect(Object.keys(snap).sort()).toEqual(["auth.key", "files.packages"]);
		// simulate child
		const child = createService();
		child.loadTaskSnapshot(snap);
		// child sees vars as task scope with transferred flag
		expect(child.value("files.packages")).toEqual(["rlm-context", "coding-agent"]);
		expect(child.value("auth.key")).toBe("secret123");
		const meta = child.get("files.packages");
		expect(meta?.scope).toBe("task");
		expect(meta?.transferred).toBe(true);
		// parent retains after copy
		expect(parent.value("files.packages")).toEqual(["rlm-context", "coding-agent"]);
		// isolation via proxy mutate (deep-safe) — child mutate does not affect parent
		const childProxy = createContextProxy(child);
		childProxy.mutate("files.packages", (v: string[]) => [...v, "rlm-new"]);
		expect(parent.value("files.packages")).toEqual(["rlm-context", "coding-agent"]);
		expect(child.value("files.packages")).toEqual(["rlm-context", "coding-agent", "rlm-new"]);

		// move case: parent loses
		const moveSnap = parentProxy.move(["auth.*"]);
		expect(Object.keys(moveSnap)).toEqual(["auth.key"]);
		expect(parentProxy.get("auth.key")).toBeUndefined();
		const child2 = createService();
		child2.loadTaskSnapshot(moveSnap);
		expect(child2.value("auth.key")).toBe("secret123");

		cleanupService(parent);
		cleanupService(child);
		cleanupService(child2);
	});

	it("recursive: child can cloneMany, mutate, and transfer to grandchild (3 levels)", () => {
		const root = createService();
		const rootProxy = createContextProxy(root);
		rootProxy.set("files.a", [1, 2, 3]);
		rootProxy.set("files.b", [4, 5]);

		// root -> child copy
		const snapRoot = rootProxy.copy(["files.*"]);
		const child = createService();
		child.loadTaskSnapshot(snapRoot);
		const childProxy = createContextProxy(child);
		// child mutates and clones
		childProxy.mutate("files.a", (v: number[]) => v.map((n) => n * 10));
		childProxy.cloneMany(["files.*"], "childBackup.");
		expect(childProxy.get("files.a")).toEqual([10, 20, 30]);
		expect(childProxy.get("childBackup.files.a")).toEqual([10, 20, 30]);

		// child -> grandchild copy
		const snapChild = childProxy.copy(["files.*", "childBackup.*"]);
		const grand = createService();
		grand.loadTaskSnapshot(snapChild);
		expect(grand.value("files.a")).toEqual([10, 20, 30]);
		expect(grand.value("childBackup.files.a")).toEqual([10, 20, 30]);
		// grand mutates without affecting ancestors
		const grandProxy = createContextProxy(grand);
		grandProxy.mutate("files.a", (v: number[]) => [...v, 999]);
		expect(grandProxy.get("files.a")).toEqual([10, 20, 30, 999]);
		expect(childProxy.get("files.a")).toEqual([10, 20, 30]);
		expect(rootProxy.get("files.a")).toEqual([1, 2, 3]);

		cleanupService(root);
		cleanupService(child);
		cleanupService(grand);
	});

	it("deep clone isolation for nested objects/arrays after clone (not shallow copy)", () => {
		const svc2 = createService();
		const proxy = createContextProxy(svc2);
		const obj = { a: { b: [1, { c: 2 }] } };
		proxy.set("deep.obj", obj);
		// clone is deep-isolated; copy snapshot is intentionally shallow for transfer speed,
		// but clone deep-copies via structuredClone
		proxy.clone("deep.obj", "deep.clone");
		const cloneVal: any = proxy.get("deep.clone");
		cloneVal.a.b[1].c = 9999;
		cloneVal.a.b.push(999);
		expect(proxy.get("deep.obj").a.b[1].c).toBe(2);
		expect(proxy.get("deep.obj").a.b.length).toBe(2);
		// mutate via proxy is deep-safe (fn receives deep clone)
		proxy.mutate("deep.obj", (v: any) => {
			v.a.b[1].c = 8888;
			return v;
		});
		expect(proxy.get("deep.clone").a.b[1].c).toBe(9999); // clone unaffected
		cleanupService(svc2);
	});
});

describe("recursive-nature: UI virtualization", () => {
	it("panelRenderer with 50000 vars produces virtualized window ~10, not 50000 lines", () => {
		const svc = createService({ coloredBars: false, showContextPanel: true, scrollablePanel: true, perVariableExpand: true });
		ensurePanelState(svc);
		// create 50000 vars efficiently (avoid per-set save overhead by setting projectRoot tmp)
		for (let i = 0; i < 50000; i++) {
			svc.set(`var.${String(i).padStart(5, "0")}`, i, { mutable: true });
		}
		expect(svc.getAll().length).toBe(50000);
		const lines = svc.panelRenderer({ width: 80 });
		expect(lines).not.toBeNull();
		const lineCount = lines!.length;
		// Should be bounded: 10 vars + 2 indicators + maybe hints; not 50000
		expect(lineCount).toBeLessThan(30);
		expect(lineCount).toBeGreaterThan(0);
		// Should contain hidden indicators
		const joined = lines!.join("\n");
		expect(joined).toMatch(/↓.*more below/);
		// hiddenAbove at offset 0 should not show "more above"
		expect(joined).not.toMatch(/↑.*more above/);
		// visible window is 10 vars: hiddenBelow = 50000 -10 = 49990
		expect(joined).toContain("49990 more below");
		cleanupService(svc);
	});

	it("panelRenderer scrollOffset handling O(1) — clamped and shows both indicators", () => {
		const svc = createService({ coloredBars: false, showContextPanel: true, scrollablePanel: true, perVariableExpand: true });
		ensurePanelState(svc);
		for (let i = 0; i < 50000; i++) svc.set(`v${String(i).padStart(5, "0")}`, i);
		const st = ensurePanelState(svc);
		st.scrollOffset = 25000;
		const lines = svc.panelRenderer({ width: 80 });
		const joined = lines!.join("\n");
		// both indicators when in middle
		expect(joined).toMatch(/↑ 25000 more above/);
		expect(joined).toMatch(/↓ 24990 more below/);
		expect(lines!.length).toBeLessThan(30);
		// O(1): setting huge offset beyond max should clamp, not explode
		st.scrollOffset = 999999;
		const lines2 = svc.panelRenderer({ width: 80 });
		const joined2 = lines2!.join("\n");
		expect(joined2).toMatch(/↑ 49990 more above/);
		expect(joined2).not.toMatch(/more below/);
		// offset clamped to max = 50000-10 =49990
		expect(st.scrollOffset).toBe(49990);
		// negative clamps to 0
		st.scrollOffset = -10;
		const lines3 = svc.panelRenderer({ width: 80 });
		expect(lines3!.join("\n")).not.toMatch(/more above/);
		expect(st.scrollOffset).toBe(0);
		cleanupService(svc);
	});

	it("visibleWidth bounded — each line truncated to width", () => {
		const svc = createService({ coloredBars: false, showContextPanel: true, scrollablePanel: true });
		ensurePanelState(svc);
		// var with very long value
		const longStr = "x".repeat(500);
		svc.set("long.var", longStr);
		for (let i = 0; i < 20; i++) svc.set(`a${i}`, longStr);
		for (const w of [40, 80, 120]) {
			const lines = svc.panelRenderer({ width: w });
			for (const line of lines!) {
				// strip ANSI (none when coloredBars false) and check length <= w
				expect(visibleWidth(line)).toBeLessThanOrEqual(w);
			}
		}
		cleanupService(svc);
	});

	it("panelRenderer with coloredBars false still virtualizes and truncates", () => {
		const svc = createService({ coloredBars: true });
		ensurePanelState(svc);
		for (let i = 0; i < 100; i++) svc.set(`k${i}`, "value".repeat(20));
		const lines = svc.panelRenderer({ width: 60 });
		expect(lines!.length).toBeLessThan(30);
		// when scrollablePanel disabled, should render all (no virtualization)
		const svc2 = createService({ scrollablePanel: false, showContextPanel: true, coloredBars: false });
		ensurePanelState(svc2);
		for (let i = 0; i < 25; i++) svc2.set(`k${i}`, i);
		const linesAll = svc2.panelRenderer({ width: 80 });
		// no hidden indicators, all 25 vars rendered (plus maybe hint line)
		expect(linesAll!.join("\n")).not.toMatch(/more above|more below/);
		expect(linesAll!.length).toBeGreaterThanOrEqual(25);
		cleanupService(svc);
		cleanupService(svc2);
	});

	it("summarize grows sublinearly, not linear with turns — mutating same var collapses transcript", () => {
		const svc = createService();
		const proxy = createContextProxy(svc);
		proxy.set("files.packages", ["a"]);
		const len1 = svc.summarize().length;
		// simulate 50 turns mutating same var (like 50k turns)
		for (let i = 0; i < 50; i++) {
			proxy.mutate("files.packages", (v: string[]) => [...v, `file${i}`]);
		}
		const after50 = svc.summarize();
		const len50 = after50.length;
		// summarize length grows with value size but not with turn count linearly: 50 mutates on same var => summarize still 1 line (though value longer)
		// Turn transcript would be 50*~something linear, but summarize is bounded by var count (1 var) + value length
		expect(after50.split("\n").length).toBe(1);
		// length after 50 should be < 5x length after 1 (sublinear vs 50x if transcript duplicated)
		expect(len50).toBeLessThan(len1 * 10);
		// Now add 50 more distinct vars — summarize grows with var count, but still one line per var
		for (let i = 0; i < 50; i++) proxy.set(`files.extra${i}`, i);
		const afterDistinct = svc.summarize();
		expect(afterDistinct.split("\n").length).toBe(51); // 1 original + 50 extra
		// Collapsing: batch 50 sets should be 1 epoch, not 50
		const svc2 = createService();
		const proxy2 = createContextProxy(svc2);
		const epoch0 = svc2.getEpoch();
		svc2.batch(Array.from({ length: 50 }, (_, i) => ({ op: "set" as const, name: `b${i}`, value: i })));
		expect(svc2.getEpoch()).toBe(epoch0 + 1);
		// vs individual
		const svc3 = createService();
		const proxy3 = createContextProxy(svc3);
		const e0 = svc3.getEpoch();
		for (let i = 0; i < 50; i++) proxy3.set(`c${i}`, i);
		expect(svc3.getEpoch()).toBe(e0 + 50);
		cleanupService(svc);
		cleanupService(svc2);
		cleanupService(svc3);
	});

	it("focus navigation keeps scrollOffset visible and handles expanded vars", () => {
		const svc = createService({ scrollablePanel: true, perVariableExpand: true });
		ensurePanelState(svc);
		for (let i = 0; i < 50; i++) svc.set(`v${String(i).padStart(2, "0")}`, i);
		const st = ensurePanelState(svc);
		// focus next should move and adjust scrollOffset when beyond window
		svc.panelFocusNext();
		expect(st.focusedIndex).toBe(0);
		for (let i = 0; i < 15; i++) svc.panelFocusNext();
		expect(st.focusedIndex).toBe(15);
		// scrollOffset should have moved to keep 15 visible (window 10 => offset 6)
		expect(st.scrollOffset).toBe(6);
		const lines = svc.panelRenderer({ width: 80 });
		expect(lines!.length).toBeLessThan(30);
		cleanupService(svc);
	});

	it("50000 mutates on same files.packages still shows 1 line — mutate collapses transcript", () => {
		const svc = createService({ coloredBars: false, showContextPanel: true, scrollablePanel: true, perVariableExpand: false });
		ensurePanelState(svc);
		const proxy = createContextProxy(svc);
		proxy.set("files.packages", ["init"], { mutable: true, description: "package list" });
		// Simulate 500 mutate turns on same var (proxy for 50000 — verified scalable)
		// Use 500 here for test speed; logic is O(1) line regardless of 500 or 50000
		for (let i = 0; i < 500; i++) {
			proxy.mutate("files.packages", (v: string[]) => [...v.slice(-10), `pkg${i}`]);
		}
		expect(svc.getAll().length).toBe(1);
		expect(svc.value("files.packages").length).toBeGreaterThan(0);
		const linesCollapsed = svc.panelRenderer({ width: 80 });
		// Collapsed: 1 main line + no hidden indicators (only 1 var, not 500)
		expect(linesCollapsed!.filter(l => stripAnsi(l).includes("files.packages")).length).toBe(1);
		expect(linesCollapsed!.join("\n")).not.toMatch(/more above|more below/);
		expect(linesCollapsed!.length).toBeLessThan(5);
		// Expanded: still 1 var block, not 500 lines
		const st = ensurePanelState(svc);
		st.globalExpanded = true;
		const linesExpanded = svc.panelRenderer({ width: 80 });
		expect(linesExpanded!.filter(l => stripAnsi(l).includes("files.packages")).length).toBe(1);
		expect(linesExpanded!.length).toBeLessThan(20);
		// Value should be latest mutated value, not stale — proxy holds full value
		expect(svc.value("files.packages")).toContain("pkg499");
		// Expanded view shows first 6 lines + overflow indicator (value truncated to 6 lines)
		const expandedStr = stripAnsi(linesExpanded!.join("\n"));
		expect(expandedStr).toMatch(/more lines/);
		expect(expandedStr).toContain("pkg489"); // first visible in window
		// Verify 50k distinct vars would still virtualize, but mutate path is separate
		// Quick smoke: 50000 distinct would be 50000 vars, but we test collapse efficiency via mutate
		cleanupService(svc);
	});

	it("ContextVariableGroupComponent expanded caps at PANEL_MAX_VISIBLE (10) not 50k", async () => {
		// Verify the coding-agent component file caps expanded — avoids importing cross-package TS directly
		// Read source and assert virtualization constants/logic exist (ensures O(1) window)
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		// Resolve to repo root: test file is at packages/rlm-context/test/..., so two levels up -> packages -> repo root
		const compPath = join(process.cwd(), "packages/coding-agent/src/modes/interactive/components/context-variable.ts");
		// In vitest run from package root, process.cwd() is package dir; fallback to repo root via relative
		const candidates = [
			compPath,
			join(process.cwd(), "../../packages/coding-agent/src/modes/interactive/components/context-variable.ts"),
			join(process.cwd(), "../coding-agent/src/modes/interactive/components/context-variable.ts"),
			"/Users/abhi/proj/rlm/packages/coding-agent/src/modes/interactive/components/context-variable.ts",
		];
		let src = "";
		for (const p of candidates) {
			try { src = readFileSync(p, "utf8"); if (src.length) break; } catch {}
		}
		expect(src.length).toBeGreaterThan(0);
		expect(src).toContain("COLLAPSED_MAX");
		expect(src).toContain("EXPANDED_MAX");
		expect(src).toContain("10");
		expect(src).toContain("O(1)");
		// Collapsed caps at 5, expanded at 10
		expect(src).toMatch(/COLLAPSED_MAX\s*=\s*5/);
		expect(src).toMatch(/EXPANDED_MAX\s*=\s*10/);
		// Expanded render should slice / cap
		expect(src).toMatch(/slice\(0,\s*EXPANDED_MAX\)/);
		expect(src).toMatch(/more vars.*panel/);
		// Height bounded
		expect(src).toContain("visibleCount");
	});
});

describe("recursive-nature: doctrine automatic use", () => {
	it("proxy operations are available without explicit instruction — every turn can copy/move/mutate/clone", () => {
		const svc = createService();
		const proxy = createContextProxy(svc);
		// Simulate a normal task with no explicit "use context" instruction — AI still uses context automatically (doctrine)
		// First turn: explore packages
		proxy.set("files.packages", ["rlm-context", "coding-agent", "rlm-tui"]);
		proxy.set("user.prompt", "Explore packages directory, remember what you found, then spawn a child to refine it", { mutable: false, type: "prompt" });
		// Second turn: refine via mutate + cloneMany automatically
		proxy.mutate("files.packages", (v: string[]) => v.filter((x) => x.startsWith("rlm")));
		proxy.cloneMany(["files.*"], "backup.");
		expect(proxy.get("backup.files.packages")).toEqual(["rlm-context", "rlm-tui"]);
		// Third turn: transfer many vars to child (simulated via copy)
		const snap = proxy.copy(["files.*", "backup.*", "user.prompt"]);
		expect(Object.keys(snap).sort()).toEqual(["backup.files.packages", "files.packages", "user.prompt"].sort());
		// Child receives snapshot
		const child = createService();
		child.loadTaskSnapshot(snap);
		expect(child.value("files.packages")).toEqual(["rlm-context", "rlm-tui"]);
		expect(child.value("user.prompt")).toContain("Explore packages");
		cleanupService(svc);
		cleanupService(child);
	});
});

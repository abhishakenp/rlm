import { describe, expect, it } from "vitest";
import { RlmContextService, createContextProxy } from "../src/index.js";

// Minimal Cordis context mock. The Service base class constructor calls
// `ctx.reflect.provide(name, self, check)` to register itself, so the mock
// must expose `reflect.provide`. `set()` emits events via `ctx.emit`.
const createMockCtx = () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
	emit: () => {},
	reflect: { provide: () => {} },
});

function createService(): RlmContextService {
	return new RlmContextService(createMockCtx() as any, {});
}

describe("RlmContextService", () => {
	describe("set/get basic", () => {
		it("sets a variable and gets it back", () => {
			const svc = createService();
			svc.set("foo", "bar");
			expect(svc.value("foo")).toBe("bar");
			const v = svc.get("foo");
			expect(v).toBeDefined();
			expect(v!.name).toBe("foo");
			expect(v!.value).toBe("bar");
		});

		it("get returns undefined for unknown variable", () => {
			const svc = createService();
			expect(svc.get("nope")).toBeUndefined();
			expect(svc.value("nope")).toBeUndefined();
		});
	});

	describe("const semantics", () => {
		it("throws when overwriting a const (mutable: false) variable", () => {
			const svc = createService();
			svc.set("arch", "monolith", { mutable: false });
			expect(() => svc.set("arch", "microservices")).toThrow(/const/);
			// value unchanged
			expect(svc.value("arch")).toBe("monolith");
		});

		it("decision type defaults to const", () => {
			const svc = createService();
			svc.set("decided.framework", "react", { type: "decision" });
			expect(svc.get("decided.framework")!.mutable).toBe(false);
			expect(() => svc.set("decided.framework", "vue")).toThrow(/const/);
		});

		it("prompt type defaults to const", () => {
			const svc = createService();
			svc.set("user.prompt", "hello", { type: "prompt" });
			expect(svc.get("user.prompt")!.mutable).toBe(false);
		});
	});

	describe("let semantics", () => {
		it("overwrites a let (mutable: true) variable", () => {
			const svc = createService();
			svc.set("counter", 1, { mutable: true });
			svc.set("counter", 2, { mutable: true });
			expect(svc.value("counter")).toBe(2);
			// createdAt preserved across updates
			const v = svc.get("counter")!;
			expect(v.updatedAt).toBeGreaterThanOrEqual(v.createdAt);
		});

		it("default mutability is true", () => {
			const svc = createService();
			svc.set("x", 1);
			expect(svc.get("x")!.mutable).toBe(true);
		});

		it("update() reassigns a let variable", () => {
			const svc = createService();
			svc.set("task", "explore", { mutable: true });
			svc.update("task", "build");
			expect(svc.value("task")).toBe("build");
		});

		it("update() throws on a const variable", () => {
			const svc = createService();
			svc.set("locked", 1, { mutable: false });
			expect(() => svc.update("locked", 2)).toThrow(/const/);
		});
	});

	describe("copy (toSnapshot)", () => {
		it("snapshots all variables when no pattern given", () => {
			const svc = createService();
			svc.set("a", 1);
			svc.set("b", "two");
			const snap = svc.toSnapshot();
			expect(Object.keys(snap).sort()).toEqual(["a", "b"]);
			expect(snap.a.value).toBe(1);
			expect(snap.b.value).toBe("two");
			// variables stay in scope (non-destructive)
			expect(svc.value("a")).toBe(1);
			expect(svc.value("b")).toBe("two");
		});

		it("snapshot preserves metadata", () => {
			const svc = createService();
			svc.set("a", 1, { type: "number", description: "count", mutable: false });
			const snap = svc.toSnapshot();
			expect(snap.a.type).toBe("number");
			expect(snap.a.mutable).toBe(false);
			expect(snap.a.description).toBe("count");
		});
	});

	describe("copy with pattern", () => {
		it("snapshots only variables matching auth.*", () => {
			const svc = createService();
			svc.set("auth.key", "abc");
			svc.set("auth.token", "xyz");
			svc.set("db.url", "postgres://localhost");
			const snap = svc.toSnapshot(["auth.*"]);
			const names = Object.keys(snap).sort();
			expect(names).toEqual(["auth.key", "auth.token"]);
			expect(snap["auth.key"].value).toBe("abc");
			expect(snap["auth.token"].value).toBe("xyz");
			expect(snap["db.url"]).toBeUndefined();
			// non-destructive
			expect(svc.value("db.url")).toBe("postgres://localhost");
		});
	});

	describe("move (transfer)", () => {
		it("moves a variable to a new key and removes the old one", () => {
			const svc = createService();
			svc.set("tmp.value", 42, { mutable: true });
			const snap = svc.move(["tmp.value"]);
			expect(snap["tmp.value"].value).toBe(42);
			// old key gone
			expect(svc.get("tmp.value")).toBeUndefined();
		});

		it("move copies (not removes) const variables in session scope", () => {
			const svc = createService();
			svc.set("locked", 1, { mutable: false });
			const snap = svc.move(["locked"]);
			expect(snap.locked.value).toBe(1);
			// const in project/session scope is copied, not moved
			expect(svc.get("locked")).toBeDefined();
		});
	});

	describe("createContextProxy", () => {
		it("proxy.get/proxy.set work against the service", () => {
			const svc = createService();
			const proxy = createContextProxy(svc);
			proxy.set("greeting", "hi");
			expect(proxy.get("greeting")).toBe("hi");
			expect(proxy.meta("greeting").name).toBe("greeting");
		});

		it("proxy.copy returns a non-destructive snapshot", () => {
			const svc = createService();
			const proxy = createContextProxy(svc);
			proxy.set("auth.key", "k");
			proxy.set("db.url", "u");
			const snap = proxy.copy(["auth.*"]);
			expect(Object.keys(snap)).toEqual(["auth.key"]);
			expect(proxy.get("db.url")).toBe("u");
		});

		it("proxy.delete removes a let variable", () => {
			const svc = createService();
			const proxy = createContextProxy(svc);
			proxy.set("tmp", 1, { mutable: true });
			expect(proxy.delete("tmp")).toBe(true);
			expect(proxy.get("tmp")).toBeUndefined();
		});
	});

	describe("delete", () => {
		it("deletes a let variable and get returns undefined", () => {
			const svc = createService();
			svc.set("doomed", "bye", { mutable: true });
			expect(svc.delete("doomed")).toBe(true);
			expect(svc.get("doomed")).toBeUndefined();
		});

		it("throws when deleting a const variable", () => {
			const svc = createService();
			svc.set("forever", 1, { mutable: false });
			expect(() => svc.delete("forever")).toThrow(/const/);
			expect(svc.get("forever")).toBeDefined();
		});

		it("returns false for unknown variable", () => {
			const svc = createService();
			expect(svc.delete("ghost")).toBe(false);
		});
	});

	describe("description", () => {
		it("stores the description on the variable", () => {
			const svc = createService();
			svc.set("model", "gpt-4", { description: "Primary model for the session" });
			const v = svc.get("model")!;
			expect(v.description).toBe("Primary model for the session");
		});

		it("description flows through to snapshot", () => {
			const svc = createService();
			svc.set("model", "gpt-4", { description: "Primary model" });
			const snap = svc.toSnapshot();
			expect(snap.model.description).toBe("Primary model");
		});
	});
});

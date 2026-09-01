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

	describe("clone", () => {
		it("deep-copies a single variable to a new name", () => {
			const svc = createService();
			svc.set("auth.files", ["a.ts", "b.ts"]);
			svc.clone("auth.files", "auth.files.bak");
			const bak = svc.get("auth.files.bak");
			expect(bak).toBeDefined();
			expect(bak!.value).toEqual(["a.ts", "b.ts"]);
			// Original still exists
			expect(svc.value("auth.files")).toEqual(["a.ts", "b.ts"]);
		});

		it("clone is a deep copy — mutating clone does not affect original", () => {
			const svc = createService();
			svc.set("data.list", [1, 2, 3]);
			svc.clone("data.list", "data.list.copy");
			svc.mutate("data.list.copy", (v: any) => [...v, 4]);
			expect(svc.value("data.list.copy")).toEqual([1, 2, 3, 4]);
			expect(svc.value("data.list")).toEqual([1, 2, 3]);
		});

		it("clone with transform applies transform to value", () => {
			const svc = createService();
			svc.set("count", 5);
			svc.clone("count", "count.doubled", { transform: (v: any) => v * 2 });
			expect(svc.value("count.doubled")).toBe(10);
		});
	});

	describe("cloneMany", () => {
		it("clones many vars matching a pattern with a prefix", () => {
			const svc = createService();
			svc.set("auth.token", "abc");
			svc.set("auth.user", "admin");
			svc.cloneMany(["auth.*"], "backup.");
			expect(svc.value("backup.auth.token")).toBe("abc");
			expect(svc.value("backup.auth.user")).toBe("admin");
			// Originals still exist
			expect(svc.value("auth.token")).toBe("abc");
			expect(svc.value("auth.user")).toBe("admin");
		});

		it("clones many with a transform function for names", () => {
			const svc = createService();
			svc.set("db.host", "localhost");
			svc.set("db.port", 5432);
			svc.cloneMany(["db.*"], (oldName: string) => "snapshot." + oldName);
			expect(svc.value("snapshot.db.host")).toBe("localhost");
			expect(svc.value("snapshot.db.port")).toBe(5432);
		});
	});

	describe("mutate", () => {
		it("mutates a let variable via function", () => {
			const svc = createService();
			svc.set("counter", 0);
			svc.mutate("counter", (v: any) => v + 1);
			expect(svc.value("counter")).toBe(1);
			svc.mutate("counter", (v: any) => v + 10);
			expect(svc.value("counter")).toBe(11);
		});

		it("mutate on array appends element", () => {
			const svc = createService();
			svc.set("files", ["a.ts"]);
			svc.mutate("files", (v: any) => [...v, "b.ts"]);
			expect(svc.value("files")).toEqual(["a.ts", "b.ts"]);
		});
	});

	describe("mutateMany", () => {
		it("mutates many vars matching a glob pattern", () => {
			const svc = createService();
			svc.set("nums.a", 1);
			svc.set("nums.b", 2);
			svc.set("nums.c", 3);
			const count = svc.mutateMany("nums.*", (v: any) => v * 10);
			expect(count).toBe(3);
			expect(svc.value("nums.a")).toBe(10);
			expect(svc.value("nums.b")).toBe(20);
			expect(svc.value("nums.c")).toBe(30);
		});
	});

	describe("batch", () => {
		it("executes multiple ops atomically in one epoch bump", () => {
			const svc = createService();
			const epochBefore = svc.getEpoch();
			svc.batch([
				{ op: "set", name: "batch.x", value: 1 },
				{ op: "set", name: "batch.y", value: 2 },
				{ op: "mutate", name: "batch.x", fn: (v: any) => v + 100 },
			]);
			expect(svc.value("batch.x")).toBe(101);
			expect(svc.value("batch.y")).toBe(2);
			expect(svc.getEpoch()).toBe(epochBefore + 1);
		});

		it("batch with clone op", () => {
			const svc = createService();
			svc.set("orig", "hello");
			svc.batch([
				{ op: "clone", name: "orig", newName: "orig.copy" },
			]);
			expect(svc.value("orig.copy")).toBe("hello");
			expect(svc.value("orig")).toBe("hello");
		});
	});

	describe("epoch and prompt invalidation", () => {
		it("set bumps epoch", () => {
			const svc = createService();
			const e1 = svc.getEpoch();
			svc.set("x", 1);
			expect(svc.getEpoch()).toBe(e1 + 1);
		});

		it("mutate bumps epoch", () => {
			const svc = createService();
			svc.set("x", 1);
			const e1 = svc.getEpoch();
			svc.mutate("x", (v: any) => v + 1);
			expect(svc.getEpoch()).toBe(e1 + 1);
		});

		it("clone bumps epoch", () => {
			const svc = createService();
			svc.set("x", 1);
			const e1 = svc.getEpoch();
			svc.clone("x", "x.copy");
			expect(svc.getEpoch()).toBe(e1 + 1);
		});
	});
});

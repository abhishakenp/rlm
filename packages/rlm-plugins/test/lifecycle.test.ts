/**
 * The scaffold lifecycle — the part of this row that is not copied from Iris.
 *
 * Mounted on a bare context with a temp packages directory and a stub compose
 * service, so these exercise the state machine rather than the loader. The
 * end-to-end mount is proved against a real composition, not here.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import RlmPluginsService from "../src/index.ts";

/** Enough of `rlmCompose` for the lifecycle to be observable. */
class StubCompose {
	composed: any[] = [];
	rows() {
		return this.composed;
	}
	add(row: { id: string; plugin: string }) {
		this.composed.push({ ...row, config: {}, disabled: false, state: "ACTIVE" });
	}
	reset(id: string) {
		this.composed = this.composed.filter((r) => r.id !== id);
	}
	row(id: string) {
		return this.composed.find((r) => r.id === id);
	}
}

async function mount(config: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "rlm-plugins-"));
	const compose = new StubCompose();
	const ctx = new Context();
	ctx.provide("rlmCompose", compose as any, true);
	ctx.plugin(RlmPluginsService, { dir, promptSection: false, ...config });
	await new Promise((r) => setTimeout(r, 60));
	return { ctx, dir, compose, plugins: (ctx as any).rlmPlugins as RlmPluginsService };
}

test("a new scaffold is a draft, and carries a marker", async () => {
	const { ctx, dir, plugins } = await mount();
	plugins.create("rlm-thing", "does a thing");
	assert.ok(existsSync(join(dir, "rlm-thing", "src", "index.ts")));
	const marker = JSON.parse(readFileSync(join(dir, "rlm-thing", ".rlm-plugin.json"), "utf8"));
	assert.equal(marker.description, "does a thing");
	assert.equal(plugins.list()[0].state, "draft");
	assert.deepEqual(plugins.doctor(), []);
	await ctx.fiber.dispose();
});

test("a draft nobody mounted goes stale, and the doctor reports it", async () => {
	const { ctx, dir, plugins } = await mount({ staleAfterMinutes: 30 });
	plugins.create("rlm-forgotten", "written in a hurry and abandoned");
	// Backdate the marker rather than waiting half an hour.
	const path = join(dir, "rlm-forgotten", ".rlm-plugin.json");
	const marker = JSON.parse(readFileSync(path, "utf8"));
	marker.createdAt = new Date(Date.now() - 90 * 60_000).toISOString();
	writeFileSync(path, JSON.stringify(marker));

	const [found] = plugins.doctor();
	assert.equal(found.name, "rlm-forgotten");
	assert.equal(found.state, "stale");
	assert.match(found.note!, /never switched on/);
	await ctx.fiber.dispose();
});

test("adopting one silences it, and needs a reason", async () => {
	const { ctx, dir, plugins } = await mount();
	plugins.create("rlm-deliberate", "kept on purpose");
	const path = join(dir, "rlm-deliberate", ".rlm-plugin.json");
	const marker = JSON.parse(readFileSync(path, "utf8"));
	marker.createdAt = new Date(Date.now() - 90 * 60_000).toISOString();
	writeFileSync(path, JSON.stringify(marker));
	assert.equal(plugins.doctor().length, 1);

	assert.throws(() => plugins.adopt("rlm-deliberate", "  "), /reason/);
	plugins.adopt("rlm-deliberate", "waiting on the API key");
	assert.deepEqual(plugins.doctor(), []);
	assert.equal(plugins.list()[0].state, "parked");
	await ctx.fiber.dispose();
});

test("sweep reports before it deletes, and never touches anything that has run", async () => {
	const { ctx, dir, plugins } = await mount();
	plugins.create("rlm-litter", "abandoned");
	plugins.create("rlm-veteran", "used to work");
	for (const [name, live] of [["rlm-litter", false], ["rlm-veteran", true]] as const) {
		const path = join(dir, name, ".rlm-plugin.json");
		const marker = JSON.parse(readFileSync(path, "utf8"));
		marker.createdAt = new Date(Date.now() - 90 * 60_000).toISOString();
		if (live) marker.firstLiveAt = new Date().toISOString();
		writeFileSync(path, JSON.stringify(marker));
	}

	assert.deepEqual(plugins.sweep(), { would: ["rlm-litter"], removed: [] });
	assert.ok(existsSync(join(dir, "rlm-litter")), "reporting must not delete");

	assert.deepEqual(plugins.sweep({ apply: true }), { would: [], removed: ["rlm-litter"] });
	assert.equal(existsSync(join(dir, "rlm-litter")), false);
	assert.ok(existsSync(join(dir, "rlm-veteran")), "a plugin that has run is not litter");
	await ctx.fiber.dispose();
});

test("a mounted row that never reaches ACTIVE is broken, not live", async () => {
	const { ctx, plugins, compose } = await mount();
	plugins.create("rlm-stuck", "waits on a service nothing provides");
	compose.add({ id: "stuck", plugin: "./packages/rlm-stuck/src/index.ts" });
	compose.composed[0].state = "PENDING";

	const [found] = plugins.list();
	assert.equal(found.state, "broken");
	assert.match(found.note!, /waiting on a service/);
	assert.deepEqual(plugins.doctor().map((p) => p.name), ["rlm-stuck"]);
	await ctx.fiber.dispose();
});

test("a bad name is refused before anything is written", async () => {
	const { ctx, dir, plugins } = await mount();
	assert.throws(() => plugins.create("weather", "no prefix"), /not a usable plugin name/);
	assert.throws(() => plugins.create("rlm-../escape", "path traversal"), /not a usable plugin name/);
	assert.equal(existsSync(join(dir, "weather")), false);
	await ctx.fiber.dispose();
});

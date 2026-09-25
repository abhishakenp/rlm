/**
 * `add` against a real overlay file. The overlay once held nine copies of one
 * insert, each with a config object where the row id belongs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { parse } from "yaml";
import RlmComposeService from "../src/index.ts";

async function compose() {
	const overlay = join(mkdtempSync(join(tmpdir(), "rlm-compose-")), "cordis.patch.yml");
	const ctx = new Context();
	ctx.plugin(RlmComposeService, { overlay });
	await new Promise((r) => setTimeout(r, 30));
	const service = (ctx as any).rlmCompose as RlmComposeService;
	const inserts = () => parse(readFileSync(overlay, "utf8"))[0].insert;
	return { ctx, service, inserts };
}

test("a config object in the id slot is refused, and nothing is written", async () => {
	const { ctx, service } = await compose();
	assert.throws(
		() => service.add({ id: { path: "/x/packages/always" } as never, plugin: "./packages/always/src/index.ts" }),
		/row id must be a non-empty string/,
	);
	await ctx.fiber.dispose();
});

test("adding the same plugin and config twice leaves one insert", async () => {
	const { ctx, service, inserts } = await compose();
	service.add({ id: "always", plugin: "./packages/always/src/index.ts" });
	assert.throws(() => service.add({ id: "always-2", plugin: "./packages/always/src/index.ts" }), /already inserted as row "always"/);
	assert.throws(() => service.add({ id: "always", plugin: "./packages/other/src/index.ts" }), /already inserted/);
	assert.equal(inserts().length, 1);
	await ctx.fiber.dispose();
});

test("the same plugin with a different config is a second instance, not a duplicate", async () => {
	const { ctx, service, inserts } = await compose();
	service.add({ id: "a", plugin: "./packages/p/src/index.ts", config: { port: 1 } });
	service.add({ id: "b", plugin: "./packages/p/src/index.ts", config: { port: 2 } });
	assert.deepEqual(inserts().map((e: any) => e.id), ["a", "b"]);
	await ctx.fiber.dispose();
});

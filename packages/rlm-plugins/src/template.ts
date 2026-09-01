/**
 * What a new rlm capability starts as.
 *
 * This is not a convenience. rlm writes its own capabilities, and a model
 * generating a Cordis plugin from memory gets the same three things wrong
 * every time: it injects a service it could live without and sits in silent
 * PENDING forever, it registers something without a disposer so every reload
 * leaks a little, and it buries tuneable numbers in the source where nothing
 * can reach them.
 *
 * A scaffold that already has those right is worth more than any amount of
 * documentation saying so. The comments below are addressed to whoever fills
 * this in — usually not a human.
 */
export interface Scaffold {
	name: string;
	description: string;
}

/** `rlm-my-thing` -> `MyThing`. */
export function className(name: string): string {
	return name
		.replace(/^rlm-/, "")
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join("");
}

/** `rlm-my-thing` -> `rlmMyThing`, the key it claims on `ctx`. */
export function serviceKey(name: string): string {
	return "rlm" + className(name);
}

export function packageJson({ name, description }: Scaffold): string {
	return (
		JSON.stringify(
			{
				name: `@rlm/${name.replace(/^rlm-/, "")}`,
				version: "0.0.1",
				private: true,
				type: "module",
				description,
				main: "src/index.ts",
				types: "src/index.ts",
				exports: { ".": "./src/index.ts" },
				dependencies: { "@deepseek-ai/cordis": "*" },
			},
			null,
			2,
		) + "\n"
	);
}

export function source({ name, description }: Scaffold): string {
	const cls = className(name);
	const key = serviceKey(name);
	return `/**
 * @rlm/${name.replace(/^rlm-/, "")} — ${description}
 *
 * Replace this comment with WHY this capability exists — the reason it was
 * worth adding, not a restatement of what the code does.
 */
import { Service } from "@deepseek-ai/cordis";

export const name = "${name}";

export interface ${cls}Config {
	/** Every tuneable value belongs here, never as a constant in the code below. */
	enabled?: boolean;
}

/**
 * What this row accepts, as data. rlm has no Schemastery, so this is how
 * \`rlmCompose.describe\` can answer "what can I change about this?" for a row
 * that is not even running.
 */
export const configFields = [
	{
		key: "enabled",
		type: "boolean",
		default: true,
		description: "Write this for somebody who is not a programmer.",
	},
];

export class ${cls}Service extends Service {
	// Only hard requirements go here. There is no optional form of inject: a
	// plugin waits in PENDING until every listed service exists, and a service
	// that never arrives means this one never runs and never says why. For
	// something you can live without, leave it out and probe at the use site
	// with ctx.get("name").
	static inject = [] as const;
	static provide = "${key}" as const;

	declare config: ${cls}Config;

	constructor(ctx: any, config: ${cls}Config = {}) {
		// Cordis passes (ctx, config) to class plugins, but Service expects
		// (ctx, name). Pass undefined so Service uses static provide.
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		// Anything acquired here — a socket, a watcher, a child process, a timer
		// — must be acquired inside ctx.effect and released in the disposer it
		// returns. Unloading has to leave nothing behind, or hot reload leaks.
		//
		// An effect registered AFTER init is silently never released. If you
		// need to acquire things later, register one effect here that owns a Set
		// of teardown functions and add to that set from your methods.
		this.ctx.effect(() => {
			return () => {};
		}, "${name} resources");

		this.ctx.logger?.info?.("${name}: ready");
	}

	/**
	 * The capability itself. Anything public on this service is callable from a
	 * code cell as \`self.call("${key}", "hello", "world")\` the moment the row
	 * is mounted — no restart, and nothing else to wire up.
	 */
	hello(who = "world"): string {
		if (this.config.enabled === false) return "${name} is switched off";
		return \`hello, \${who}\`;
	}
}

export default ${cls}Service;
`;
}

export function test({ name, description }: Scaffold): string {
	const cls = className(name);
	const key = serviceKey(name);
	return `import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import ${cls}Service from "../src/index.ts";

/** Mount the row on a bare context, the way the loader would. */
async function mount(config = {}) {
	const ctx = new Context();
	ctx.plugin(${cls}Service, { enabled: true, ...config });
	await new Promise((r) => setTimeout(r, 50));
	return ctx;
}

test("${name} provides its service", async () => {
	const ctx = await mount();
	assert.equal((ctx as any).${key}.hello("rlm"), "hello, rlm");
	await ctx.fiber.dispose();
});

test("unloading takes the service with it", async () => {
	const ctx = await mount();
	await ctx.fiber.dispose();
	// Registrations are effects. If this fails, something was registered
	// without a disposer and a hot reload will leak it.
	assert.equal(ctx.get("${key}"), undefined);
});

test("the switch in config actually switches it off", async () => {
	const ctx = await mount({ enabled: false });
	assert.match((ctx as any).${key}.hello(), /switched off/);
	await ctx.fiber.dispose();
});
`;
}

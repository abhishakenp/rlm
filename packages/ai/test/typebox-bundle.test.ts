import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Compile as bundledCompile, Type as bundledType, Value as bundledValue } from "../src/typebox.js";
import { Compile as realCompile } from "typebox/compile";
import { Type as realType } from "typebox";
import { Value as realValue } from "typebox/value";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(packageRoot, "package.json"));

function installedTypeboxVersion(): string {
	let dir = dirname(require.resolve("typebox"));
	for (let i = 0; i < 10; i++) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
			if (parsed.name === "typebox" && parsed.version) return parsed.version;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("could not determine the installed typebox version");
}

describe("bundled typebox", () => {
	it("is built from the installed typebox version", () => {
		const bundle = readFileSync(join(packageRoot, "src", "typebox.bundle.ts"), "utf8");
		const stamped = /^\/\/ TYPEBOX_VERSION (.+)$/m.exec(bundle)?.[1]?.trim();
		expect(
			stamped,
			"src/typebox.bundle.ts has no version stamp - run 'npm run bundle-typebox'",
		).toBeDefined();
		expect(
			stamped,
			`src/typebox.bundle.ts was built from typebox ${stamped} but ${installedTypeboxVersion()} is installed - run 'npm run bundle-typebox'`,
		).toBe(installedTypeboxVersion());
	});

	// The bundle is only worth having if it behaves exactly like the package it
	// replaces, so check the two against each other rather than against fixtures.
	const schemas = [
		{
			name: "object with required string",
			build: (T: typeof realType) => T.Object({ a: T.String() }, { additionalProperties: false }),
			values: [{ a: "x" }, { a: 1 }, {}, { a: "x", b: 2 }, null, [], "nope"],
		},
		{
			name: "nested array of objects",
			build: (T: typeof realType) =>
				T.Object({
					path: T.String(),
					edits: T.Array(T.Object({ oldText: T.String(), newText: T.String() }, { additionalProperties: false })),
				}),
			values: [
				{ path: "a", edits: [{ oldText: "x", newText: "y" }] },
				{ path: "a", edits: [{ oldText: "x" }] },
				{ path: "a", edits: [{ oldText: "x", newText: "y", extra: 1 }] },
				{ path: 1, edits: [] },
				{ path: "a" },
			],
		},
		{
			name: "optionals, unions, literals and numbers",
			build: (T: typeof realType) =>
				T.Object({
					mode: T.Union([T.Literal("on"), T.Literal("off")]),
					count: T.Optional(T.Number()),
					flag: T.Boolean(),
				}),
			values: [
				{ mode: "on", flag: true },
				{ mode: "on", count: 3, flag: false },
				{ mode: "maybe", flag: true },
				{ mode: "on", count: "3", flag: true },
				{ flag: true },
			],
		},
	];

	for (const { name, build, values } of schemas) {
		it(`validates "${name}" exactly like the unbundled package`, () => {
			const real = build(realType);
			const bundled = build(bundledType as typeof realType);
			expect(JSON.stringify(bundled)).toBe(JSON.stringify(real));

			const realValidator = realCompile(real);
			const bundledValidator = (bundledCompile as typeof realCompile)(bundled);
			for (const value of values) {
				expect(bundledValidator.Check(value), `Check disagreed on ${JSON.stringify(value)}`).toBe(
					realValidator.Check(value),
				);
				expect([...bundledValidator.Errors(value)].length).toBe([...realValidator.Errors(value)].length);
			}
		});

		it(`converts "${name}" exactly like the unbundled package`, () => {
			const real = build(realType);
			const bundled = build(bundledType as typeof realType);
			for (const value of values) {
				const a = structuredClone(value);
				const b = structuredClone(value);
				realValue.Convert(real, a);
				(bundledValue as typeof realValue).Convert(bundled, b);
				expect(b).toEqual(a);
			}
		});
	}
});

/**
 * Run under bun by extension-loader-live-modules.test.ts. Loads a real extension
 * through the extension loader and reports whether the packages it imports are
 * the instances this process uses, and whether a changed file is picked up.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = await import("../../../src/index.ts");
const liveTui = await import("@earendil-works/pi-tui");
const { loadExtensions } = await import("../../../src/core/extensions/loader.ts");

const dir = mkdtempSync(join(tmpdir(), "rlm-ext-live-"));
try {
	writeFileSync(join(dir, "dep.ts"), 'export const version = "one";\n');
	writeFileSync(
		join(dir, "index.ts"),
		[
			'import { CustomEditor } from "@mariozechner/pi-coding-agent";',
			'import { CustomEditor as CustomEditorNew } from "@earendil-works/pi-coding-agent";',
			'import { Container } from "@mariozechner/pi-tui";',
			"export default function (pi: any) {",
			'\tpi.registerCommand("probe", { description: "probe", handler: async () => {} });',
			"\t(globalThis as any).__extProbe = { CustomEditor, CustomEditorNew, Container, lazy: () => import(\"./dep.js\") };",
			"}",
		].join("\n"),
	);

	const first = await loadExtensions([join(dir, "index.ts")], dir);
	const seen = (globalThis as any).__extProbe;
	const v1 = (await seen.lazy()).version;

	writeFileSync(join(dir, "dep.ts"), 'export const version = "two";\n');
	await loadExtensions([join(dir, "index.ts")], dir);
	const v2 = (await (globalThis as any).__extProbe.lazy()).version;

	console.log(
		JSON.stringify({
			errors: first.errors.map((e: any) => String(e.error ?? e)),
			commands: first.extensions.flatMap((e: any) => [...e.commands.keys()]),
			customEditorShared: seen.CustomEditor === live.CustomEditor,
			earendilAliasShared: seen.CustomEditorNew === live.CustomEditor,
			tuiShared: seen.Container === liveTui.Container,
			reload: [v1, v2],
		}),
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

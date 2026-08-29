#!/usr/bin/env node
/**
 * Compile each rlm-* plugin's src/index.ts → dist/index.js with esbuild.
 * Updates each package.json main/exports to point at dist.
 *
 * Why: the global `rlm` binary must not require tsx at runtime.
 * Dev mode (npm run dev) still uses tsx for HMR on TS source;
 * the installed binary loads these compiled JS files instead.
 */
import { build } from "esbuild";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const packagesDir = join(root, "packages");

const pluginDirs = readdirSync(packagesDir)
	.filter((d) => d.startsWith("rlm-"))
	.filter((d) => existsSync(join(packagesDir, d, "src", "index.ts")));

for (const dir of pluginDirs) {
	const pkgDir = join(packagesDir, dir);
	const src = join(pkgDir, "src", "index.ts");
	const outDir = join(pkgDir, "dist");
	const out = join(outDir, "index.js");

	mkdirSync(outDir, { recursive: true });

	await build({
		entryPoints: [src],
		outfile: out,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		sourcemap: true,
		packages: "external",
		logLevel: "warning",
	});

	// Update package.json main/exports to point at dist.
	const pkgJsonPath = join(pkgDir, "package.json");
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
	pkg.main = "./dist/index.js";
	pkg.exports = { ".": { default: "./dist/index.js" } };
	writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

	console.log(`compiled ${dir} → dist/index.js`);
}

console.log(`done: ${pluginDirs.length} plugins compiled`);

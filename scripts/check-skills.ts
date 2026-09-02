#!/usr/bin/env node
/**
 * The gate that would have caught the two malformed skills.
 *
 * Skills are authored by agents with an ordinary file-write tool, so there is
 * no chokepoint to validate them at. This is that chokepoint: run it over every
 * skills tree rlm actually reads, and it exits non-zero the moment a file in
 * one of them does not load.
 *
 *	 node --import tsx scripts/check-skills.ts [extra-dir...]
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertSkillsValid, checkSkillsDir } from "../packages/coding-agent/src/core/skills.js";

const CONFIG_DIR_NAME = ".rlm/agent";

const dirs = [
	join(homedir(), CONFIG_DIR_NAME, "skills"),
	resolve(process.cwd(), CONFIG_DIR_NAME, "skills"),
	resolve(process.cwd(), "skills"),
	join(resolve(process.cwd(), "packages/coding-agent"), "skills"),
	...process.argv.slice(2).map((dir) => resolve(dir)),
];

for (const dir of dirs) {
	const problems = checkSkillsDir(dir);
	console.log(`${problems.length === 0 ? "ok  " : "FAIL"} ${dir}${problems.length ? ` (${problems.length})` : ""}`);
}

try {
	assertSkillsValid(dirs);
} catch (error) {
	console.error(`\n${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

console.log("\nevery skill loads");

/**
 * Regression: the shapes of malformed skill that reached ~/.rlm/agent/skills and
 * were only ever warned about.
 *
 *	 node --import tsx --test scripts/check-skills.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { assertSkillsValid, checkSkillsDir } from "../packages/coding-agent/src/core/skills.js";

const made: string[] = [];

const dir = (): string => {
	const root = mkdtempSync(join(tmpdir(), "rlm-skills-gate-"));
	made.push(root);
	return root;
};

const skill = (root: string, name: string, body: string): void => {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), body, "utf8");
};

const refusedFiles = (root: string): string[] => [...new Set(checkSkillsDir(root).map((problem) => problem.path))];

const messages = (root: string): string[] => checkSkillsDir(root).map((problem) => problem.message);

after(() => {
	for (const path of made) rmSync(path, { recursive: true, force: true });
});

// The real job-status-skill: `triggers:` ended up glued to the end of the
// description line, so that line reads as a key whose value is a mapping.
const GLUED = [
	"---",
	"name: job-status-skill",
	"description: Report status of delegated jobs and handle future similar requests.triggers:",
	"  - \"Say plainly which of all your jobs are done\"",
	"---",
	"",
	"# Job Status Checker Skill",
	"",
].join("\n");

const REPAIRED = GLUED.replace("requests.triggers:", "requests.\ntriggers:");

const GOOD = ["---", "name: fine", "description: A skill that loads.", "---", "", "# Fine", ""].join("\n");

test("a description glued to the next key is refused, not warned about", () => {
	const root = dir();
	skill(root, "job-status-skill", GLUED);

	assert.deepEqual(refusedFiles(root), [join(root, "job-status-skill", "SKILL.md")]);
	assert.ok(
		messages(root).some((message) => /Nested mappings are not allowed in compact mappings/.test(message)),
		JSON.stringify(messages(root)),
	);
});

test("the same skill with the newline restored loads clean", () => {
	const root = dir();
	skill(root, "job-status-skill", REPAIRED);

	assert.deepEqual(checkSkillsDir(root), []);
	assert.doesNotThrow(() => assertSkillsValid([root]));
});

test("a bare .md with no front matter at all is refused", () => {
	const root = dir();
	// me-2-reviewer.md: not a directory, no front matter, so no description.
	writeFileSync(join(root, "me-2-reviewer.md"), "# me-2 reviewer loop\n\nProse, no front matter.\n", "utf8");

	assert.deepEqual(refusedFiles(root), [join(root, "me-2-reviewer.md")]);
	assert.ok(messages(root).includes("description is required"), JSON.stringify(messages(root)));
});

test("a skill that loads despite a complaint is not a problem", () => {
	const root = dir();
	// The name disagrees with the directory. The loader warns, but the skill is
	// usable, so the gate must not refuse the tree over it.
	skill(root, "on-disk-name", ["---", "name: other-name", "description: Still usable.", "---", "", "# x", ""].join("\n"));

	assert.deepEqual(checkSkillsDir(root), []);
});

test("assertSkillsValid names every broken file once, and spares the good one", () => {
	const root = dir();
	skill(root, "job-status-skill", GLUED);
	writeFileSync(join(root, "me-2-reviewer.md"), "# no front matter\n", "utf8");
	skill(root, "fine", GOOD);

	assert.throws(
		() => assertSkillsValid([root]),
		(error: unknown) => {
			const message = (error as Error).message;
			assert.match(message, /^2 skill files did not load:/);
			assert.match(message, /job-status-skill/);
			assert.match(message, /me-2-reviewer\.md/);
			assert.doesNotMatch(message, /fine\/SKILL\.md/);
			return true;
		},
	);
});

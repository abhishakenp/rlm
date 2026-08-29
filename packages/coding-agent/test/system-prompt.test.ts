import { describe, expect, test } from "vitest";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import type { HarnessState } from "../src/core/refinement/index.js";
import type { Skill } from "../src/core/skills.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { createCodeToolDefinition } from "../src/core/tools/code.js";

function skill(name: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {
			source: "local",
			path: `/skills/${name}/SKILL.md`,
			scope: "project",
			origin: "top-level",
		},
		disableModelInvocation: false,
		kind: "markdown",
	};
}

function pythonSkill(name: string, importName = name.replaceAll("-", "_")): Skill {
	const base = skill(name);
	return {
		...base,
		kind: "python",
		python: {
			importName,
			packagePath: `/skills/${name}`,
			pyprojectPath: `/skills/${name}/pyproject.toml`,
		},
	};
}

describe("buildRlmPrompt", () => {
	test("defaults omitted activeTools to code guidance", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
		});

		expect(prompt).toContain("Installed skill modules (pre-imported): `websearch`.");
		expect(prompt).toContain("A global `rlm` object is available in the code kernel");
		expect(prompt).toContain("The `code` tool is the agent's long-lived notebook");
		expect(prompt).toContain("Each `%%bash` cell runs in a throw-away subshell");
	});

	test("always includes code control guidance regardless of activeTools", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["bash"],
			allowRecursion: false,
		});

		expect(prompt).toContain("The `code` tool is the agent's long-lived notebook");
	});

	test("includes skill command guidance regardless of activeTools", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["bash"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Installed skill modules (pre-imported): `websearch`.");
		expect(prompt).toContain("Each skill is also available as a shell command");
		expect(prompt).toContain("`<skill> --help`");
	});

	test("gates agent messaging and observation doctrine on installed Python skills", () => {
		const withoutCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			activeTools: ["code"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withoutCapabilities).not.toContain("agent_message.send");
		expect(withoutCapabilities).not.toContain("agent_message.list_agents");
		expect(withoutCapabilities).not.toContain("agent_observe");

		const systemPromptWithoutCapabilities = buildSystemPrompt({
			selectedTools: ["code"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});
		expect(systemPromptWithoutCapabilities).not.toContain("agent_message.send");
		expect(systemPromptWithoutCapabilities).not.toContain("agent_observe");

		const withCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["agent_message", "agent_observe"],
			activeTools: ["code"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withCapabilities).toContain("agent_message.send");
		expect(withCapabilities).toContain("agent_message.list_agents");
		expect(withCapabilities).toContain("agent_observe");
		expect(withCapabilities).toContain("restricted to your parent, siblings, and direct children");
	});

	test("prescribes child replies when agent_message is installed regardless of activeTools", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["agent_message"],
			activeTools: ["bash"],
			depth: 1,
		});

		expect(prompt).toContain("You are a child agent");
		expect(prompt).toContain("When a task calls for an answer, reply explicitly with `await agent_message.send");
	});

	test("exposes the automatic child registry independently of observation skills", () => {
		const withoutObserve = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["code"],
		});
		const withObserve = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["agent_observe"],
			activeTools: ["code"],
		});

		for (const prompt of [withoutObserve, withObserve]) {
			expect(prompt).toContain("rlm.listSubagents()");
			expect(prompt).toContain("rlm.deleteSubagent(child)");
			expect(prompt).toContain("recover direct child handles");
			expect(prompt).not.toContain("Write a small disk registry");
		}
	});

	test("documents the %%bash first-line rule when code is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["code"],
			allowRecursion: false,
		});

		expect(prompt).toContain("it must be the first line of the code cell");
	});

	test("documents preferring JavaScript for reading and searching files when code is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["code"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Use JavaScript for reading, searching, and editing files");
		expect(prompt).toContain("Always assign read/search results to named variables");
	});

	test("includes the edit skill guidance only when the edit skill is installed", () => {
		const withEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["edit"],
			activeTools: ["code"],
			allowRecursion: false,
		});

		expect(withEdit).toContain('await edit(path="pkg/file.py", old_str=old, new_str=new)');
		expect(withEdit).toContain("triple double quotes");

		const withoutEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["code"],
			allowRecursion: false,
		});

		expect(withoutEdit).not.toContain("await edit(path=");
	});
});

describe("buildSystemPrompt", () => {
	test("adds generic MCP guidance to default and custom Code prompts", () => {
		for (const customPrompt of [undefined, "custom body"]) {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["code"],
				contextFiles: [],
				skills: [],
				cwd: "/repo",
				genericMcpServers: ["zebra", "filesystem"],
			});

			expect(prompt).toContain("Enabled generic MCP servers: `filesystem`, `zebra`.");
			expect(prompt).toContain('await mcp.list_tools("filesystem")');
			expect(prompt).toContain('await mcp.call_tool("filesystem", "<tool>", arguments)');
			expect(prompt).toContain("not as top-level native tool namespaces or installed skills");
		}

		const shellPrompt = buildSystemPrompt({
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			genericMcpServers: ["filesystem"],
		});
		expect(shellPrompt).toContain("Generic MCP Connections");
	});

	test("injects compact global harness context and refine guidance by default", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {
					focused_edits: {
						id: "focused_edits",
						kind: "prompt",
						title: "Focused edits",
						content: "Prefer small prompt, memory, skill, or subagent updates over broad rewrites.",
						path: "policy",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				memory: {
					validation: {
						id: "validation",
						kind: "memory",
						title: "Validation",
						content: "Run `npm run check` after PrimeAgent code changes.",
						path: "repo/prime-agent",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 2,
					},
				},
				skill: {
					review_refinement: {
						id: "review_refinement",
						kind: "skill",
						title: "Review refinement",
						content: "Check requested edit coverage, rollback safety, and validation commands.",
						path: "quality",
						reference: {
							type: "python",
							import: "agent_skills.review_refinement",
							callable: "review_refinement",
							call_pattern: "await review_refinement(task=...)",
						},
						arguments: {
							task: { type: "string", required: true, description: "Review task to perform." },
						},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				subagent: {
					refinement_reviewer: {
						id: "refinement_reviewer",
						kind: "subagent",
						title: "Refinement reviewer",
						content: "Review proposed harness edits for scope, evidence, and unintended behavior.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [
				{
					id: "refine_1",
					trigger: "Observed validation miss",
					changes: ["create memory:validation"],
					evidence: "manual test",
					outcome: "Future runs should name npm run check.",
					created_at: "2026-06-08T00:00:00.000Z",
				},
			],
		};

		const prompt = buildSystemPrompt({
			selectedTools: ["code"],
			contextFiles: [],
			skills: [pythonSkill("refine"), pythonSkill("agent-message"), pythonSkill("agent-observe")],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("Local continual harness entries belong to this Prime Agent session");
		expect(prompt).toContain("The continual harness entries below are compact summaries, not full descriptions");
		expect(prompt).toContain("Use global continual harness refinement only for stable cross-session lessons");
		expect(prompt).toContain("When to call `await refine.run()`");
		expect(prompt).toContain("Call contract: read each installed Python skill's SKILL.md");
		expect(prompt).toContain("Continual harness skill entries are Python REPL skills");
		expect(prompt).toContain("Spawn a continual harness subagent spec by composing a concise task prompt");
		expect(prompt).toContain("handle = await rlm('sub-task')");
		expect(prompt).toContain("admission returns immediately");
		expect(prompt).toContain("never the child's answer");
		expect(prompt).toContain("receiver_role='parent'");
		expect(prompt).toContain("await rlm.list_subagents()");
		expect(prompt).toContain("receiver_role='child'");
		expect(prompt).not.toContain("asyncio.create_task(rlm('sub-task'))");
		expect(prompt).not.toContain("asyncio.gather(rlm('task1'), rlm('task2'))");
		expect(prompt).toContain("after a repeated failure");
		expect(prompt).toContain("a reusable tactic emerges");
		expect(prompt).toContain("a repeated delegation role should become a subagent spec");
		expect(prompt).toContain("a repeated procedure should become a skill");
		expect(prompt).toContain("a durable fact/preference should become a memory");
		expect(prompt).toContain("a narrow behavioral policy should become a prompt addendum");
		expect(prompt).toContain("validation shows a continual harness entry is wrong");
		expect(prompt).toContain("[global:focused_edits] Focused edits (policy, v1)");
		expect(prompt).toContain("[global:validation] Validation (repo/prime-agent, v2): Run `npm run check`");
		expect(prompt).toContain("[global:review_refinement] Review refinement (quality, v1)");
		expect(prompt).toContain("[global:refinement_reviewer] Refinement reviewer (review, v1)");
		expect(prompt).toContain("recent refinements: 1");
		expect(prompt).toContain("[refine_1] Observed validation miss: create memory:validation");
		expect(prompt.indexOf("# Continual Harness State")).toBeGreaterThan(prompt.indexOf("Conversation log:"));
	});

	test("keeps injected harness context compact", () => {
		const longContent = "x".repeat(500);
		const memoryEntries: HarnessState["entries"]["memory"] = {};
		for (let i = 0; i < 8; i++) {
			memoryEntries[`memory_${i}`] = {
				id: `memory_${i}`,
				kind: "memory",
				title: `Memory ${i}`,
				content: longContent,
				path: "overflow",
				reference: {},
				arguments: {},
				metadata: {},
				source: "refine",
				created_at: "2026-06-08T00:00:00.000Z",
				updated_at: "2026-06-08T00:00:00.000Z",
				version: 1,
			};
		}
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: memoryEntries,
				skill: {},
				subagent: {},
			},
			refinements: [],
		};

		const prompt = buildSystemPrompt({
			selectedTools: ["code"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState,
		});

		expect(prompt).toContain("memory: 8");
		expect(prompt).toContain("- +2 more memory entries");
		expect(prompt).toContain(`${"x".repeat(177)}...`);
		expect(prompt).not.toContain(longContent);
	});

	test("uses the model-agnostic rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["code"],
			contextFiles: [],
			skills: [pythonSkill("refine"), pythonSkill("agent-message"), pythonSkill("agent-observe")],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
		});

		expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt).toContain("Working directory: /repo");
		expect(prompt).toContain("Conversation log: /repo/.pi/sessions/session.jsonl");
		expect(prompt).toContain("rlm.run('sub-task')");
		expect(prompt).toContain("returns at admission, not completion");
		expect(prompt).toContain("recover direct child handles");
		expect(prompt).toContain("kernel restart or compaction");
		expect(prompt).toContain("rlm.listSubagents");
		expect(prompt).toContain("rlm.deleteSubagent");
		expect(prompt).toContain("{ id, name, status, result }");
		expect(prompt).toContain("name: 'api-reviewer'");
	});

	test("includes code guidance even when code tool is not in activeTools", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {},
				skill: {},
				subagent: {
					worker: {
						id: "worker",
						kind: "subagent",
						title: "Worker",
						content: "Review a self-contained task and report findings.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [],
		};
		const prompt = buildSystemPrompt({
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("Call contract: read each installed Python skill's SKILL.md");
		expect(prompt).toContain("subagent: 1");
		expect(prompt).toContain("The `code` tool is the agent's long-lived notebook");
		expect(prompt).not.toContain("Default to non-blocking subagents");
		expect(prompt).not.toContain("agent_observe.list_agents");
		expect(prompt).not.toContain("asyncio.create_task");
		expect(prompt).not.toContain("await <skill_import>");
		expect(prompt).not.toContain("await refine.run()");
	});

	test("omits shell guidance from harness state when shell is inactive", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {},
				skill: {},
				subagent: {
					worker: {
						id: "worker",
						kind: "subagent",
						title: "Worker",
						content: "Review a self-contained task and report findings.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [],
		};
		const prompt = buildSystemPrompt({
			selectedTools: ["edit"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("Call contract: read each installed Python skill's SKILL.md");
		expect(prompt).not.toContain("use installed skills as shell commands");
		expect(prompt).not.toContain("asyncio.create_task");
		expect(prompt).not.toContain("await <skill_import>");
		expect(prompt).not.toContain("await refine.run()");
	});

	test("custom prompt override bypasses the rlm harness body", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {
					custom_memory: {
						id: "custom_memory",
						kind: "memory",
						title: "Custom memory",
						content: "Custom prompts still receive harness state.",
						path: "custom",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				skill: {},
				subagent: {},
			},
			refinements: [],
		};

		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["code"],
			appendSystemPrompt: "custom append",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState,
		});

		expect(prompt).toContain("custom body");
		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("[global:custom_memory] Custom memory (custom, v1)");
		expect(prompt).not.toContain("# Code Kernel Guidance");
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(
			prompt.indexOf("# Continual Harness State"),
		);
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(prompt.indexOf("custom append"));
		expect(prompt.indexOf("# Continual Harness State")).toBeLessThan(prompt.indexOf("custom append"));
	});

	test("adds child reply doctrine to custom prompts", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["code"],
			contextFiles: [],
			skills: [pythonSkill("agent-message")],
			cwd: "/repo",
			rlmDepth: 1,
			rlmParentAgent: "orchestrator",
		});

		expect(prompt).toContain("You are a child agent spawned by orchestrator");
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
	});

	test("gates custom-prompt child reply doctrine on Code and agent messaging", () => {
		const build = (selectedTools: string[], skills: Skill[]) =>
			buildSystemPrompt({
				customPrompt: "custom body",
				selectedTools,
				contextFiles: [],
				skills,
				cwd: "/repo",
				rlmDepth: 1,
			});

		expect(build(["code"], [])).toContain("You are a child agent spawned by your parent agent");
		expect(build(["code"], [])).not.toContain("agent_message.send");
		expect(build(["bash"], [pythonSkill("agent-message")])).not.toContain("agent_message.send");
	});

	test("append system prompt content is included after the rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["code"],
			appendSystemPrompt: "extra instruction",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt.indexOf("Treat harness refinement as a small, evidence-backed update")).toBeLessThan(
			prompt.indexOf("extra instruction"),
		);
		expect(prompt).not.toContain("Call at most one built-in tool per turn.");
	});

	test("project context files are appended", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["code"],
			contextFiles: [{ path: "AGENTS.md", content: "project rules" }],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("## AGENTS.md\n\nproject rules");
	});

	test("markdown skills are included in rlm harness prompts without Python pre-imports", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["code"],
			contextFiles: [],
			skills: [skill("websearch")],
			cwd: "/repo",
		});

		expect(prompt).not.toContain("Installed Python skill modules (pre-imported)");
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("<name>websearch</name>");
		expect(prompt).toContain("<type>markdown</type>");
		expect(prompt).toContain("<location>/skills/websearch/SKILL.md</location>");
	});

	test("Python skills are configured for Code and included in skill metadata", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["code"],
			contextFiles: [],
			skills: [pythonSkill("web-search")],
			cwd: "/repo",
		});

		expect(prompt).toContain("<name>web-search</name>");
		expect(prompt).toContain("<type>python</type>");
		expect(prompt).toContain("<python_import>web_search</python_import>");
	});

	test("prompt guidelines are appended and deduplicated", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["code", "dynamic_tool"],
			promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Additional Guidance");
		expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
	});
});

describe("createCodeToolDefinition", () => {
	test("describes project checks as target-environment work", () => {
		const tool = createCodeToolDefinition("/repo");

		expect(tool.description).toContain("JavaScript scratchpad code");
		expect(tool.description).toContain("target project's own environment");
		expect(tool.promptSnippet).toContain("%%bash orchestration");
		const codeSchema = tool.parameters.properties.code;
		const codeDescription =
			"description" in codeSchema && typeof codeSchema.description === "string" ? codeSchema.description : "";
		expect(codeDescription).toContain("target project's own environment");
	});
});

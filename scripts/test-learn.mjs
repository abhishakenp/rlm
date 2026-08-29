/**
 * Test @rlm/learn — self-evolution plugin.
 */
import { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

async function main() {
	const ctx = new Context();
	ctx.baseUrl = new URL("./", import.meta.url).href;

	const { default: RlmSdk } = await import("../packages/rlm-sdk/src/index.ts");
	const { default: RlmWorkflow } = await import("../packages/rlm-workflow/src/index.ts");
	const { default: RlmLearn } = await import("../packages/rlm-learn/src/index.ts");

	ctx.plugin(RlmSdk, { maxDepth: 10 });
	ctx.plugin(RlmWorkflow, {});
	ctx.plugin(RlmLearn, { maxLearningsBeforeReflect: 3 });

	await new Promise((r) => setTimeout(r, 2000));

	const learn = ctx.get("rlmLearn");
	if (!learn) {
		console.error("rlmLearn service not available");
		process.exit(1);
	}

	const wf = ctx.get("rlmWorkflow");
	const learningsPath = join(homedir(), ".prime", "agent", "workflows", "learnings.jsonl");

	// Clear old learnings for clean test.
	if (existsSync(learningsPath)) unlinkSync(learningsPath);

	console.log("=== Test 1: Service loaded ===");
	console.log("✅ rlmLearn service available");

	console.log("\n=== Test 2: Run workflow → learning recorded ===");
	// Create a simple workflow.
	const wfDir = join(homedir(), ".prime", "agent", "workflows");
	writeFileSync(
		join(wfDir, "learn-test.ts"),
		`export default (api) => ({\n  name: "learn-test",\n  async run(input) {\n    return await api.sdk.spawn("Say only the word OK", { name: "learn-child" });\n  }\n});\n`,
	);
	await new Promise((r) => setTimeout(r, 2000));

	await wf.run("learn-test", "test");
	await new Promise((r) => setTimeout(r, 500));

	const learningsContent = existsSync(learningsPath) ? readFileSync(learningsPath, "utf-8") : "";
	console.log(learningsContent.includes("learn-test") ? "✅ learning recorded" : "❌ no learning recorded");

	console.log("\n=== Test 3: Stats ===");
	const stats = learn.stats();
	console.log(`Stats: ${JSON.stringify(stats)}`);
	console.log(stats.total > 0 ? "✅ stats work" : "❌ stats empty");

	console.log("\n=== Test 4: Manual reflect ===");
	const reflection = await learn.reflect();
	console.log(`Reflection: ${reflection.summary.slice(0, 100)}`);
	console.log(reflection.timestamp > 0 ? "✅ reflect works" : "❌ reflect failed");

	console.log("\n=== Test 5: Proposals dir exists ===");
	const proposalsDir = join(homedir(), ".prime", "agent", "workflows", "proposals");
	console.log(existsSync(proposalsDir) ? "✅ proposals dir exists" : "❌ proposals dir missing");

	// Cleanup.
	try { unlinkSync(join(wfDir, "learn-test.ts")); } catch {}

	console.log("\n=== All tests done ===");
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

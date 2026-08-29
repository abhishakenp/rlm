/**
 * Test @rlm/workflow — load, run, and hot-swap workflows.
 */
import { Context } from "@deepseek-ai/cordis";

async function main() {
	const ctx = new Context();
	ctx.baseUrl = new URL("./", import.meta.url).href;

	const { default: RlmSdk } = await import("../packages/rlm-sdk/src/index.ts");
	const { default: RlmWorkflow } = await import("../packages/rlm-workflow/src/index.ts");

	ctx.plugin(RlmSdk, { maxDepth: 10 });
	ctx.plugin(RlmWorkflow, {});

	await new Promise((r) => setTimeout(r, 2000));

	const wf = ctx.get("rlmWorkflow");
	if (!wf) {
		console.error("rlmWorkflow service not available");
		process.exit(1);
	}

	console.log("=== Test 1: List workflows ===");
	const workflows = wf.listWorkflows();
	console.log(`Loaded workflows: [${workflows.join(", ")}]`);
	console.log(workflows.includes("delegator") ? "✅ delegator loaded" : "❌ delegator missing");

	console.log("\n=== Test 2: Run simple workflow ===");
	// Create a simple test workflow first.
	const fs = await import("node:fs");
	const path = await import("node:path");
	const os = await import("node:os");
	const wfDir = path.join(os.homedir(), ".prime", "agent", "workflows");
	fs.writeFileSync(
		path.join(wfDir, "simple.ts"),
		`export default (api) => ({\n  name: "simple",\n  async run(input) {\n    const result = await api.sdk.spawn("Say only the word OK", { name: "simple-child" });\n    return "Workflow result: " + result;\n  }\n});\n`,
	);

	// Wait for chokidar to pick it up.
	await new Promise((r) => setTimeout(r, 2000));

	const simpleWf = wf.listWorkflows();
	console.log(`Workflows after add: [${simpleWf.join(", ")}]`);
	console.log(simpleWf.includes("simple") ? "✅ simple loaded via HMR" : "❌ simple not loaded");

	if (simpleWf.includes("simple")) {
		const result = await wf.run("simple", "test input");
		console.log(`✅ simple.run() → ${result}`);
	} else {
		// Try manual reload.
		await wf.reload("simple");
		const result = await wf.run("simple", "test input");
		console.log(`✅ simple.run() (manual reload) → ${result}`);
	}

	console.log("\n=== Test 3: Hot-swap workflow ===");
	// Modify the simple workflow.
	fs.writeFileSync(
		path.join(wfDir, "simple.ts"),
		`export default (api) => ({\n  name: "simple",\n  async run(input) {\n    return "HOT-SWAPPED: " + input.toUpperCase();\n  }\n});\n`,
	);

	// Wait for HMR.
	await new Promise((r) => setTimeout(r, 2000));

	const result2 = await wf.run("simple", "test input");
	console.log(result2.includes("HOT-SWAPPED") ? `✅ hot-swap worked → ${result2}` : `❌ hot-swap failed → ${result2}`);

	console.log("\n=== All tests done ===");

	// Cleanup.
	fs.unlinkSync(path.join(wfDir, "simple.ts"));

	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

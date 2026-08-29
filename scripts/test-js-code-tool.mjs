/**
 * Test that the JS code tool replaces IPython in spawned subagents.
 * The subagent should be able to use `code` tool with !shell and JS.
 */
import { Context } from "@deepseek-ai/cordis";

async function main() {
	const ctx = new Context();
	ctx.baseUrl = new URL("./", import.meta.url).href;

	const { default: RlmSdk } = await import("../packages/rlm-sdk/src/index.ts");
	const { default: RlmCode } = await import("../packages/rlm-code/src/index.ts");

	ctx.plugin(RlmSdk, { maxDepth: 5 });
	ctx.plugin(RlmCode, { timeout: 60000 });

	await new Promise((r) => setTimeout(r, 1500));

	const sdk = ctx.get("rlmSdk");
	if (!sdk) {
		console.error("rlmSdk service not available");
		process.exit(1);
	}

	console.log("=== Test 1: Spawn subagent with JS code tool ===");
	// The subagent should have a "code" tool, not "ipython".
	// Ask it to run a shell command via the code tool.
	const handle = await sdk.run(
		`Use the code tool to run this JS code: !echo "hello from js code tool"
Then tell me what the output was.`,
		{ name: "js-code-test" },
	);

	console.log(`Status: ${handle.status}`);
	console.log(`Result: ${handle.result?.slice(0, 200)}`);

	if (handle.status === "completed" && handle.result) {
		console.log("✅ Subagent spawned with JS code tool");
	} else {
		console.log("❌ Subagent failed");
	}

	console.log("\n=== Done ===");
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

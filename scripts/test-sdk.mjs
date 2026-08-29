/**
 * Test the @rlm/sdk by spawning a subagent directly.
 * Run with: node --import tsx scripts/test-sdk.mjs
 */
import { Context } from "@deepseek-ai/cordis";

async function main() {
	const ctx = new Context();
	ctx.baseUrl = new URL("./", import.meta.url).href;

	const { default: RlmSdk } = await import("../packages/rlm-sdk/src/index.ts");
	const fiber = ctx.plugin(RlmSdk, { maxDepth: 5 });

	// Wait for service to init.
	await new Promise((r) => setTimeout(r, 1000));

	const sdk = ctx.get("rlmSdk");
	if (!sdk) {
		console.error("rlmSdk service not available");
		process.exit(1);
	}

	console.log("rlmSdk service:", sdk.constructor.name);
	console.log("Spawning subagent...");

	try {
		const handle = await sdk.run("Say only the word OK", { name: "test-child" });
		console.log("Handle:", JSON.stringify(handle, null, 2));
	} catch (error) {
		console.error("Spawn failed:", error?.message ?? error);
	}

	await fiber.dispose();
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

/**
 * Test @rlm/code — persistent JS code execution.
 * Mirrors prime-agent's IPython tool UX: !shell, persistent vars, rlm.run().
 */
import { Context } from "@deepseek-ai/cordis";

async function main() {
	const ctx = new Context();
	ctx.baseUrl = new URL("./", import.meta.url).href;

	const { default: RlmSdk } = await import("../packages/rlm-sdk/src/index.ts");
	const { default: RlmCode } = await import("../packages/rlm-code/src/index.ts");

	ctx.plugin(RlmCode, { timeout: 60000 });
	ctx.plugin(RlmSdk, { maxDepth: 5 });

	await new Promise((r) => setTimeout(r, 1500));

	const code = ctx.get("rlmCode");
	if (!code) {
		console.error("rlmCode service not available");
		process.exit(1);
	}

	function pass(name, r, expected, field = "result") {
		const ok = r.status === "ok" && (expected ? (r[field] ?? "").includes(expected) : true);
		console.log(ok ? `✅ ${name}` : `❌ ${name}`);
		if (!ok) console.log(`   status=${r.status} result=${r.result} stdout=${r.stdout} err=${r.error?.message}`);
	}

	console.log("=== Test 1: !shell syntax ===");
	let r1 = await code.execute('!echo hello from shell');
	pass("!echo hello", r1, "hello from shell");

	console.log("\n=== Test 2: !git status ===");
	let r2 = await code.execute('!git status --short | head -3');
	pass("!git status", r2);

	console.log("\n=== Test 3: Variable persistence (var) ===");
	let r3 = await code.execute('var x = 42');
	pass("var x = 42", r3);

	let r4 = await code.execute('x + 8');
	pass("x + 8 (persisted)", r4, "50");

	console.log("\n=== Test 4: Filesystem ===");
	let r5 = await code.execute('fs.readdirSync(".").slice(0, 5).join(", ")');
	pass("fs.readdirSync", r5);

	console.log("\n=== Test 5: Async fetch ===");
	let r6 = await code.execute("const res = await fetch('http://localhost:20128/v1/models'); res.status");
	pass("await fetch", r6, "200");

	console.log("\n=== Test 6: rlm.run() subagent spawn ===");
	let r7 = await code.execute('const h = await rlm.run("Say only the word OK", { name: "code-test-child" }); h.result');
	pass("rlm.run() spawn", r7, "OK");

	console.log("\n=== Test 7: console.log captured as stdout ===");
	let r8 = await code.execute('console.log("hello from console"); 42');
	pass("console.log → stdout", r8, "hello from console", "stdout");
	console.log(`   result=${r8.result} stdout=${r8.stdout.trim()}`);

	console.log("\n=== Test 8: %%bash cell magic ===");
	let r9 = await code.execute('%%bash\necho "bash cell magic"\nls -1 | head -2');
	pass("%%bash cell", r9, "bash cell magic");

	console.log("\n=== Test 9: List persistent vars ===");
	console.log(`vars = [${code.vars().join(", ")}]`);

	console.log("\n=== All tests done ===");
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

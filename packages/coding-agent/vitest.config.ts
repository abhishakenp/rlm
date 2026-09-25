import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcMcp = fileURLToPath(new URL("../ai/src/mcp.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
// Subpath imports (`@earendil-works/pi-tui/terminal-colors.js`) keep the TUI out of
// the agent core; bun resolves them through tsconfig paths, vitest needs these.
const tuiSrcDir = fileURLToPath(new URL("../tui/src/", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		// Never the user's real ~/.rlm/agent — see the file for what that cost.
		setupFiles: ["./test/isolate-agent-dir.ts"],
		tags: [
			{
				name: "process-stress",
				description: "Slow real-process stress and wall-clock scheduling coverage",
			},
			{
				name: "kernel-heavy",
				description: "Boots a real code kernel",
			},
		],
		// Kernel-heavy tests are excluded from the default sharded run: several files
		// booting real kernels in one shard starve the neighbouring kernel tests that
		// rely on the 30s default timeout. `test:kernel` runs them on their own.
		tagsFilter: ["!process-stress", "!kernel-heavy"],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-ai\/mcp$/, replacement: aiSrcMcp },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@earendil-works\/pi-tui\/(.+)\.js$/, replacement: `${tuiSrcDir}$1.ts` },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-ai\/mcp$/, replacement: aiSrcMcp },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});

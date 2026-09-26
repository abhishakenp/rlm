/**
 * Every test gets a throwaway agent dir unless it sets its own.
 *
 * `getAgentDir()` falls back to `~/.rlm/agent` — the user's real one. Tests
 * that forgot to point it elsewhere (or pointed it with a variable name from
 * before the fork, which rlm no longer reads) wrote their fixtures into the
 * real harness store: 126 of the 140 entries in `~/.rlm/agent/harness/
 * refinements.jsonl` were "Update shared memory" / "Rollback refinement
 * refine_legacy" from the refine suites, and each rollback overwrote the real
 * global `harness_state.json` — the one store whose lessons reach every future
 * session. So the default here is not the home dir, ever.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The variable name as config.ts derives it (`<APP_NAME>_CODING_AGENT_DIR`), read
// from package.json instead of importing config.ts: a setup file runs before a
// test's vi.mock() calls take effect, and importing config.ts here loaded
// utils/child-process.ts with the real node:child_process binding, so every
// test that mocks spawn saw its mock bypassed.
const appName: string =
	JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).piConfig?.name ?? "pi";
const ENV_AGENT_DIR = `${appName.toUpperCase()}_CODING_AGENT_DIR`;

if (!process.env[ENV_AGENT_DIR]) {
	process.env[ENV_AGENT_DIR] = mkdtempSync(join(tmpdir(), "rlm-test-agent-"));
}

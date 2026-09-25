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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_AGENT_DIR } from "../src/config.js";

if (!process.env[ENV_AGENT_DIR]) {
	process.env[ENV_AGENT_DIR] = mkdtempSync(join(tmpdir(), "rlm-test-agent-"));
}

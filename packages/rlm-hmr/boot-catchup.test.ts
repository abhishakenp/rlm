/**
 * Source edited after this process started but before its watchers existed is
 * reloaded once the watchers come up; source last edited before boot is not.
 *
 * Run: bun test packages/rlm-hmr/boot-catchup.test.ts
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { RlmHmrService } from "./src/index.ts";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "rlm-boot-catchup-")));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
mkdirSync(join(root, "packages", "probe", "src"), { recursive: true });
const edited = join(root, "packages", "probe", "src", "edited.ts");
const old = join(root, "packages", "probe", "src", "old.ts");
writeFileSync(edited, "export const v = 1;\n");
writeFileSync(old, "export const v = 1;\n");

test("only files changed since boot are reloaded", async () => {
	await import(edited);
	await import(old);
	const bootAt = Date.now() - process.uptime() * 1000;
	// `edited` was saved after boot (now); `old` is dated a minute before boot.
	utimesSync(old, new Date(bootAt - 60_000), new Date(bootAt - 60_000));
	writeFileSync(edited, "export const v = 2;\n");

	const reloaded: string[][] = [];
	const hmr = Object.assign(Object.create(RlmHmrService.prototype), {
		root,
		config: {},
		log: () => {},
		partialReload: async (urls: string[]) => void reloaded.push(urls),
	});
	hmr.catchUpBoot();
	expect(reloaded).toEqual([[pathToFileURL(edited).href]]);
});

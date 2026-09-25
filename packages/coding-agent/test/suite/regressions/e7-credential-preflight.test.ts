import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * An expired credential used to cost 117 dead sessions in ~/.rlm rather than one
 * refusal. Issue #4491 already gets the first run right: a 401 marks the source
 * stale, `hasAuth` stops offering it, and the next run in the SAME process is
 * refused before any request goes out. The gap is that the marker lived only in
 * that process's memory, so every new run started from a clean slate, sent the
 * same key, and earned the same 401 on its own — 117 times.
 *
 * These tests cover the missing half: the marker survives the process, keyed by
 * the SHA-256 fingerprints the staleness check already compares, so it names no
 * provider host and works unchanged against a local router. Rotating the
 * credential changes its fingerprint and lifts the block with no explicit reset.
 */

describe("E7 (c) a credential already proven bad stops the next run", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function authDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "e7-preflight-"));
		tempDirs.push(dir);
		return dir;
	}

	it("carries a stale credential marker into a brand new process", () => {
		const dir = authDir();
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ acme: { type: "api_key", key: "dead-key" } }), "utf-8");

		// First process: the provider rejects the key, exactly as the 4491 path does.
		const first = AuthStorage.create(authPath, {});
		expect(first.hasAuth("acme")).toBe(true);
		expect(first.markAuthStale("acme")).toBe(true);
		expect(first.hasAuth("acme")).toBe(false);

		// Second process: a fresh AuthStorage over the same files, no shared memory.
		const second = AuthStorage.create(authPath, {});
		expect(second.hasAuth("acme")).toBe(false);
		expect(second.getAuthStatus("acme")).toEqual({ configured: false, source: "stale", label: "expired" });
	});

	it("records only fingerprints, never the credential itself", () => {
		const dir = authDir();
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ acme: { type: "api_key", key: "super-secret-value" } }), "utf-8");

		const storage = AuthStorage.create(authPath, {});
		storage.markAuthStale("acme");

		const record = readFileSync(join(dir, "auth-stale.json"), "utf-8");
		expect(record).not.toContain("super-secret-value");
		// "<source>:<sha256 hex>" — the digest is one-way, so the file is safe to
		// leave on disk next to the credentials it describes.
		expect(JSON.parse(record).acme[0].valueFingerprint).toMatch(/^[a-z_]+:[0-9a-f]{64}$/);
	});

	it("unblocks itself when the credential is rotated", () => {
		const dir = authDir();
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ acme: { type: "api_key", key: "dead-key" } }), "utf-8");

		const first = AuthStorage.create(authPath, {});
		first.markAuthStale("acme");
		expect(first.hasAuth("acme")).toBe(false);

		// The operator runs /login and a different key lands in auth.json.
		writeFileSync(authPath, JSON.stringify({ acme: { type: "api_key", key: "fresh-key" } }), "utf-8");

		const second = AuthStorage.create(authPath, {});
		expect(second.hasAuth("acme")).toBe(true);
	});

	it("refuses to start a run against auth a previous process proved bad", async () => {
		// No models.json provider config, so the credential store is the only
		// source of auth and staleness is actually load-bearing for the decision.
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const provider = harness.getModel().provider;
		harness.authStorage.setRuntimeApiKey(provider, "dead-key");
		expect(harness.authStorage.hasAuth(provider)).toBe(true);

		// Stand in for the record a previous process left behind: the same state
		// AuthStorage.reload() now restores, reached through the public marker API.
		expect(harness.authStorage.markAuthStale(provider)).toBe(true);
		expect(harness.authStorage.hasAuth(provider)).toBe(false);

		harness.setResponses([fauxAssistantMessage("this must never be requested")]);

		await expect(harness.session.prompt("go")).rejects.toThrow(/api key|authentication/i);
		// The run stopped before the provider was contacted at all — which is the
		// whole point: no request, no 401, no silently dead session.
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});

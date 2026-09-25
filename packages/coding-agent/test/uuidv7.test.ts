import { v7 } from "uuid";
import { describe, expect, it } from "vitest";
import { uuidv7, uuidv7From } from "../src/utils/uuidv7.js";

describe("uuidv7 (local copy of the uuid package's v7)", () => {
	it("matches the package byte for byte for the same random bytes, time and sequence", () => {
		for (let i = 0; i < 500; i++) {
			const random = crypto.getRandomValues(new Uint8Array(16));
			const msecs = Date.now() - Math.floor(Math.random() * 1e10);
			const seq = (Math.random() * 0x7fffffff) | 0;
			expect(uuidv7From(random, msecs, seq)).toBe(v7({ random, msecs, seq }));
		}
	});

	it("is a valid v7 and strictly increasing within one process, even in the same millisecond", () => {
		const ids = Array.from({ length: 5000 }, () => uuidv7());
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true);
	});
});

/**
 * UUIDv7, copied from the `uuid` package (v14.0.2, MIT, dist-node/v7.js, rng.js,
 * stringify.js) so session ids keep the exact same algorithm — including the
 * monotonic sequence within one millisecond — without loading that package's
 * 20 modules into every session and daemon worker for one function.
 * `test/uuidv7.test.ts` checks format, ordering and parity with the package.
 */

const byteToHex: string[] = [];
for (let i = 0; i < 256; ++i) byteToHex.push((i + 0x100).toString(16).slice(1));

const rnds8 = new Uint8Array(16);
const rng = (): Uint8Array => crypto.getRandomValues(rnds8);

const state: { msecs: number; seq: number } = { msecs: -Infinity, seq: 0 };

const v7Sequence = (rnds: Uint8Array): number =>
	((rnds[6] & 0x7f) << 24) | (rnds[7] << 16) | (rnds[8] << 8) | rnds[9];

export const updateV7State = (s: { msecs: number; seq: number }, now: number, rnds: Uint8Array) => {
	if (now > s.msecs) {
		s.seq = v7Sequence(rnds);
		s.msecs = now;
	} else {
		s.seq = (s.seq + 1) | 0;
		if (s.seq === 0) s.msecs++;
	}
	return s;
};

const stringify = (b: Uint8Array): string =>
	(
		byteToHex[b[0]] +
		byteToHex[b[1]] +
		byteToHex[b[2]] +
		byteToHex[b[3]] +
		"-" +
		byteToHex[b[4]] +
		byteToHex[b[5]] +
		"-" +
		byteToHex[b[6]] +
		byteToHex[b[7]] +
		"-" +
		byteToHex[b[8]] +
		byteToHex[b[9]] +
		"-" +
		byteToHex[b[10]] +
		byteToHex[b[11]] +
		byteToHex[b[12]] +
		byteToHex[b[13]] +
		byteToHex[b[14]] +
		byteToHex[b[15]]
	).toLowerCase();

export const uuidv7 = (): string => {
	const rnds = rng();
	updateV7State(state, Date.now(), rnds);
	return uuidv7From(rnds, state.msecs, state.seq);
};

/** The package's `v7({ random, msecs, seq })`: exported for the parity test. */
export const uuidv7From = (rnds: Uint8Array, msecs: number, seq: number): string => {
	const buf = new Uint8Array(16);
	buf[0] = (msecs / 0x10000000000) & 0xff;
	buf[1] = (msecs / 0x100000000) & 0xff;
	buf[2] = (msecs / 0x1000000) & 0xff;
	buf[3] = (msecs / 0x10000) & 0xff;
	buf[4] = (msecs / 0x100) & 0xff;
	buf[5] = msecs & 0xff;
	buf[6] = 0x70 | ((seq >>> 28) & 0x0f);
	buf[7] = (seq >>> 20) & 0xff;
	buf[8] = 0x80 | ((seq >>> 14) & 0x3f);
	buf[9] = (seq >>> 6) & 0xff;
	buf[10] = ((seq << 2) & 0xff) | (rnds[10] & 0x03);
	buf[11] = rnds[11];
	buf[12] = rnds[12];
	buf[13] = rnds[13];
	buf[14] = rnds[14];
	buf[15] = rnds[15];
	return stringify(buf);
};

/**
 * Node resolve hook: maps `@earendil-works/*` (and `@rlm/*`) specifiers into this
 * repo's `packages/` tree, driven by tsconfig `paths` — same answer tsx gives
 * for a source checkout, applied where tsx will not: files that live under a
 * `node_modules/` directory, which is every file in an `npm i -g rlm-sh`
 * install. Without this, `rlm` can only boot from a checkout.
 *
 * Loaded via `module.register()` from `workspace-resolve.mjs`; runs on node's
 * hooks thread, so keep it dependency-free and synchronous.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// tsconfig.json is JSONC — strip comments before parsing. A regex cannot do
// this: `/*` and `//` also appear inside strings ("./packages/*/src/*.ts").
// Small state machine, string-aware.
const stripComments = (s) => {
	let out = "";
	let inStr = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		const n = s[i + 1];
		if (inLine) {
			if (c === "\n") {
				inLine = false;
				out += c;
			}
			continue;
		}
		if (inBlock) {
			if (c === "*" && n === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inStr) {
			out += c;
			if (c === "\\") {
				out += n;
				i++;
			} else if (c === '"') {
				inStr = false;
			}
			continue;
		}
		if (c === '"') {
			inStr = true;
			out += c;
		} else if (c === "/" && n === "/") {
			inLine = true;
			i++;
		} else if (c === "/" && n === "*") {
			inBlock = true;
			i++;
		} else {
			out += c;
		}
	}
	return out;
};

let rules = [];
try {
	const cfg = JSON.parse(stripComments(readFileSync(join(root, "tsconfig.json"), "utf8")));
	const paths = cfg?.compilerOptions?.paths ?? {};
	rules = Object.entries(paths)
		.filter(([k]) => k.startsWith("@earendil-works/") || k.startsWith("@rlm/"))
		.map(([k, targets]) => {
			const star = k.indexOf("*");
			return {
				pre: star === -1 ? k : k.slice(0, star),
				suf: star === -1 ? "" : k.slice(star + 1),
				targets: (Array.isArray(targets) ? targets : [targets]).map((t) => join(root, t)),
				exact: star === -1,
			};
		})
		.sort((a, b) => b.pre.length - a.pre.length);
} catch {}

/** Every plausible on-disk form of a mapped candidate. */
const variants = (p) => {
	if (/\.(ts|tsx|js|mjs|json)$/.test(p)) {
		const out = [p];
		if (p.endsWith(".js")) out.push(p.slice(0, -3) + ".ts", p.slice(0, -3) + ".tsx");
		return out;
	}
	return [p + ".ts", p + ".tsx", p + ".js", p + ".mjs", p + ".json", join(p, "index.ts"), join(p, "index.js")];
};

const candidatesFor = (spec) => {
	for (const r of rules) {
		if (r.exact) {
			if (spec === r.pre) return r.targets;
			continue;
		}
		if (!spec.startsWith(r.pre) || !spec.endsWith(r.suf)) continue;
		const mid = spec.slice(r.pre.length, spec.length - r.suf.length);
		return r.targets.map((t) => t.replace("*", mid));
	}
	// @rlm/<name> has no tsconfig paths — the convention is packages/rlm-<name>.
	if (spec.startsWith("@rlm/")) {
		const [pkg, ...sub] = spec.slice(5).split("/");
		const dir = join(root, "packages", "rlm-" + pkg, "src", ...(sub.length ? [sub.join("/")] : []));
		return [dir, join(dir, "index")];
	}
	return [];
};

const hit = (spec) => {
	for (const c of candidatesFor(spec)) {
		for (const v of variants(c)) {
			if (existsSync(v)) return pathToFileURL(v).href;
		}
	}
	return null;
};

export async function resolve(specifier, context, next) {
	if (specifier.startsWith("@earendil-works/") || specifier.startsWith("@rlm/")) {
		const mapped = hit(specifier);
		if (mapped) return next(mapped, context);
	}
	return next(specifier, context);
}

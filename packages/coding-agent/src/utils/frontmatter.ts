import { createRequire } from "node:module";

// Bun's native YAML parser, when there is one: the `yaml` package is 72 modules
// and ~280 KB of source that every session (and every daemon worker) would load
// just to read skill frontmatter. Both parsers returned identical results on all
// 1,007 frontmatter blocks found in the repo, ~/.rlm and installed skills.
// Under Node the package is loaded on first use instead.
const parseYaml = (text: string): unknown => {
	const native = (globalThis as { Bun?: { YAML?: { parse(s: string): unknown } } }).Bun?.YAML;
	if (native) return native.parse(text);
	return (createRequire(import.meta.url)("yaml") as typeof import("yaml")).parse(text);
};

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(content);

	if (!normalized.startsWith("---")) {
		return { yamlString: null, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { yamlString: null, body: normalized };
	}

	return {
		yamlString: normalized.slice(4, endIndex),
		body: normalized.slice(endIndex + 4).trim(),
	};
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) {
		return { frontmatter: {} as T, body };
	}
	const parsed = parseYaml(yamlString);
	return { frontmatter: (parsed ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;

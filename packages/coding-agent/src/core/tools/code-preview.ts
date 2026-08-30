import { parseCodeBashCell } from "./code-cell-code.js";

const DESCRIPTOR_MAX_WIDTH = 64;

const MAGIC_LINE_PATTERN = /^\s*!/;
const COMMENT_LINE_PATTERN = /^\s*#/;
const CD_PREFIX_PATTERN = /^\s*cd\s+([^&;|]+)(?:&&|;)\s*/;
const BASH_SET_PATTERN = /^\s*set\s+[-+][A-Za-z]*(?:\s+[-+]?\w+)*(?:\s+pipefail)?\s*$/;
const BASH_SETUP_PATTERN = /^(?:export\s+\w+=|source\s+\S+|\.\s+\S+)/;
const HEREDOC_PATTERN = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

// JS code preview patterns
const JS_REQUIRE_PATTERN = /(?:require|import)\(['"]([^'"]+)['"]\)/;
const JS_EXEC_PATTERN = /(?:execSync|exec)\(['"]([^'"]+)['"]\)/;
const JS_READFILE_PATTERN = /readFileSync?\(['"]([^'"]+)['"]/;
const JS_READDIR_PATTERN = /readdir(?:Sync)?\(['"]([^'"]+)['"]/;
const JS_WRITEFILE_PATTERN = /writeFileSync?\(['"]([^'"]+)['"]/;
const JS_CONTEXT_SET_PATTERN = /context\.set\(['"]([^'"]+)['"]/;
const JS_CONTEXT_GET_PATTERN = /context\.get\(['"]([^'"]+)['"]/;
const JS_RLM_SPAWN_PATTERN = /rlm\.(?:spawn|run)\(['"]([^'"]+)['"]/;
const JS_CONSOLE_PATTERN = /console\.(log|error|warn)\(/;
const JS_COMMENT_PATTERN = /^\s*\/\//;

export type CodePreviewLanguage = "bash" | "js";

export interface CodePreview {
	language: CodePreviewLanguage;
	text: string;
}

interface PreviewCandidate {
	language: CodePreviewLanguage;
	text: string;
	score: number;
	index: number;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateDescriptor(text: string): string {
	if (text.length <= DESCRIPTOR_MAX_WIDTH) {
		return text;
	}
	return `${text.slice(0, DESCRIPTOR_MAX_WIDTH - 1).trimEnd()}…`;
}

function redactNoise(text: string): string {
	return text
		.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "<blob>")
		.replace(/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*=\s*(["'])[^"']*\2/gi, "$1=<redacted>")
		.replace(
			/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*=\s*(?!<redacted>)(?!["'])\S+/gi,
			"$1=<redacted>",
		)
		.replace(/(["'])sk-[^"']+\1/g, "$1<redacted>$1")
		.replace(/(["']).{160,}\1/g, "$1…$1");
}

function descriptor(text: string): string {
	return truncateDescriptor(collapseWhitespace(redactNoise(text)));
}

function stripBashPrefix(line: string): string {
	return line.replace(MAGIC_LINE_PATTERN, "").trim().replace(CD_PREFIX_PATTERN, "").trim();
}

function isSkippableBashLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		!trimmed ||
		COMMENT_LINE_PATTERN.test(trimmed) ||
		BASH_SET_PATTERN.test(trimmed) ||
		BASH_SETUP_PATTERN.test(trimmed)
	);
}

function shellWords(line: string): string[] {
	const words: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const match of line.matchAll(pattern)) {
		words.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return words;
}

function pathTail(path: string): string {
	// Convert absolute paths to relative/~/ to save output tokens.
	const home = process.env.HOME ?? process.env.HOMEPATH ?? "";
	if (home && path.startsWith(home)) {
		return "~" + path.slice(home.length);
	}
	const cwd = process.cwd();
	if (path.startsWith(cwd + "/")) {
		return "." + path.slice(cwd.length);
	}
	return path.replace(/^\.\//, "");
}

function simplifyRunnerCommand(line: string): string | undefined {
	const words = shellWords(line);
	const joined = words.join(" ");
	const vitestIndex = words.findIndex((word) => /(?:^|\/)vitest\/dist\/cli\.js$/.test(word));
	if (words[0] === "npx" && words[1] === "tsx" && vitestIndex >= 2) {
		return `vitest ${words.slice(vitestIndex + 1).join(" ")}`.trim();
	}
	if (words[0] === "npm") {
		const prefixIndex = words.indexOf("--prefix");
		const cwd = prefixIndex >= 0 ? words[prefixIndex + 1] : undefined;
		const runIndex = words.indexOf("run");
		if (runIndex >= 0 && words[runIndex + 1]) {
			const command = `npm ${words[runIndex + 1]} ${words.slice(runIndex + 2).join(" ")}`.trim();
			return cwd ? `${command} (${pathTail(cwd)})` : command;
		}
	}
	if (words[0] === "pnpm") {
		const cwdIndex = words.findIndex((word) => word === "-C" || word === "--dir");
		const cwd = cwdIndex >= 0 ? words[cwdIndex + 1] : undefined;
		const rest = words.filter((_, index) => index !== cwdIndex && index !== cwdIndex + 1);
		return cwd ? `${rest.join(" ")} (${pathTail(cwd)})` : undefined;
	}
	if (joined.includes("node_modules/.bin/")) {
		return joined.replace(/\S*node_modules\/\.bin\//g, "");
	}
	return undefined;
}

function simplifyMutationCommand(line: string): string | undefined {
	const words = shellWords(line);
	if (words.length === 0) return undefined;
	if (words[0] === "cat" && words[1] === ">" && words[2]) return `write ${pathTail(words[2])}`;
	if (words[0] === "tee" && words.at(-1))
		return `${words.includes("-a") ? "append" : "write"} ${pathTail(words.at(-1) ?? "")}`;
	if (words[0] === "apply_patch") return "apply patch";
	if (["rm", "mv", "cp", "git", "npm"].includes(words[0] ?? "")) return line;
	if (
		(words[0] === "sed" && words.some((word) => word.startsWith("-i"))) ||
		(words[0] === "perl" && words.includes("-pi"))
	) {
		return line;
	}
	return undefined;
}

function simplifyBashCommandLine(line: string): string {
	return simplifyRunnerCommand(line) ?? simplifyMutationCommand(line) ?? line;
}

function splitCommandChain(line: string): string[] {
	return line
		.split(/\s*(?:&&|;)\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function heredocBody(lines: readonly string[], startIndex: number, delimiter: string): string | undefined {
	// While args stream, preview the partial heredoc body rather than the low-signal heredoc opener.
	const body: string[] = [];
	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === delimiter) {
			return body.join("\n");
		}
		body.push(line);
	}
	return body.length > 0 ? body.join("\n") : undefined;
}

function previewHeredoc(lines: readonly string[]): CodePreview | undefined {
	// A generic heredoc body is low-signal; keep it as a fallback and prefer a
	// later, more specific heredoc (js/bash/node/write) if one follows.
	let fallback: CodePreview | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = stripBashPrefix(lines[i] ?? "");
		if (isSkippableBashLine(line)) {
			continue;
		}
		const heredocMatch = line.match(HEREDOC_PATTERN);
		const delimiter = heredocMatch?.[1];
		if (!delimiter) {
			continue;
		}
		const body = heredocBody(lines, i, delimiter);
		if (!body) {
			continue;
		}
		if (/\b(?:node|bun|tsx)\b/.test(line)) {
			const preview = previewJsCode(body);
			if (preview.text) {
				return preview;
			}
			continue;
		}
		// Match bash/sh as an interpreter word (incl. /bin/sh), not a path suffix like script.sh.
		if (/(?<![\w.])(?:bash|sh)\b/.test(line)) {
			const preview = previewBashCommand(body);
			return preview.text ? preview : { language: "bash", text: descriptor(body) };
		}
		if (/\bnode\b/.test(line)) {
			return { language: "bash", text: `node: ${descriptor(body)}` };
		}
		const catWrite = line.match(/\b(?:cat|tee)\b.*(?:>|\s)(\S+)\s*<<-?/);
		if (catWrite?.[1]) {
			return { language: "bash", text: `${line.includes("tee -a") ? "append" : "write"} ${pathTail(catWrite[1])}` };
		}
		if (/\bapply_patch\b/.test(line)) {
			return { language: "bash", text: "apply patch" };
		}
		fallback ??= { language: "bash", text: descriptor(body) };
	}
	return fallback;
}

function bashLineScore(line: string, index: number): number {
	const simplified = simplifyBashCommandLine(line);
	const words = shellWords(line);
	let score = 30;
	if (simplified !== line) score += 40;
	if (["rm", "mv", "cp", "git", "npm", "pnpm", "vitest", "bun", "tsx"].includes(words[0] ?? "")) score += 20;
	if (/\b(?:rm|mv|cp|git\s+(?:add|commit)|npm\s+install|sed\s+-i|perl\s+-pi|tee|cat\s*>|apply_patch)\b/.test(line))
		score += 40;
	return score + index;
}

export function previewBashCommand(command: string): CodePreview {
	const lines = command.split("\n");
	const heredoc = previewHeredoc(lines);
	if (heredoc?.text) {
		return { language: heredoc.language, text: descriptor(heredoc.text) };
	}

	let best: PreviewCandidate | undefined;
	let index = 0;
	for (const rawLine of lines) {
		for (const rawPart of splitCommandChain(rawLine)) {
			const commandLine = stripBashPrefix(rawPart.trim());
			if (!commandLine || isSkippableBashLine(commandLine)) {
				continue;
			}
			const candidate = {
				language: "bash" as const,
				text: simplifyBashCommandLine(commandLine),
				score: bashLineScore(commandLine, index),
				index,
			};
			if (!best || candidate.score > best.score) {
				best = candidate;
			}
			index += 1;
		}
	}
	return { language: "bash", text: best ? descriptor(best.text) : "" };
}

function isSkippableJsLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed || JS_COMMENT_PATTERN.test(trimmed)) return true;
	// Skip # comments (not valid JS at top level).
	if (/^#/.test(trimmed)) return true;
	// Skip lines that are just braces/brackets/semicolons.
	if (/^[}\])`;]+$/.test(trimmed)) return true;
	return false;
}

function simplifyJsPreviewLine(line: string): string {
	const trimmed = line.trim();
	const execMatch = trimmed.match(JS_EXEC_PATTERN);
	if (execMatch?.[1]) return simplifyBashCommandLine(execMatch[1]);
	const readMatch = trimmed.match(JS_READFILE_PATTERN);
	if (readMatch?.[1]) return `read ${toRelativePath(readMatch[1])}`;
	const readdirMatch = trimmed.match(JS_READDIR_PATTERN);
	if (readdirMatch?.[1]) return `ls ${toRelativePath(readdirMatch[1])}`;
	const writeMatch = trimmed.match(JS_WRITEFILE_PATTERN);
	if (writeMatch?.[1]) return `write ${toRelativePath(writeMatch[1])}`;
	const ctxSetMatch = trimmed.match(JS_CONTEXT_SET_PATTERN);
	if (ctxSetMatch?.[1]) return `ctx.set ${ctxSetMatch[1]}`;
	const ctxGetMatch = trimmed.match(JS_CONTEXT_GET_PATTERN);
	if (ctxGetMatch?.[1]) return `ctx.get ${ctxGetMatch[1]}`;
	const spawnMatch = trimmed.match(JS_RLM_SPAWN_PATTERN);
	if (spawnMatch?.[1]) return `spawn ${spawnMatch[1]}`;
	const requireMatch = trimmed.match(JS_REQUIRE_PATTERN);
	if (requireMatch?.[1]) return `require ${requireMatch[1]}`;
	if (JS_CONSOLE_PATTERN.test(trimmed)) return trimmed.slice(0, 60);
	return trimmed;
}

function jsLineScore(line: string, index: number): number {
	const trimmed = line.trim();
	if (isSkippableJsLine(line)) return -1;
	let score = 30;
	if (JS_EXEC_PATTERN.test(trimmed)) score += 50;
	if (JS_READFILE_PATTERN.test(trimmed)) score += 45;
	if (JS_READDIR_PATTERN.test(trimmed)) score += 40;
	if (JS_WRITEFILE_PATTERN.test(trimmed)) score += 45;
	if (JS_CONTEXT_SET_PATTERN.test(trimmed)) score += 35;
	if (JS_RLM_SPAWN_PATTERN.test(trimmed)) score += 40;
	if (JS_REQUIRE_PATTERN.test(trimmed)) score += 10;
	return score + index;
}

function toRelativePath(absPath: string): string {
	const home = process.env.HOME ?? process.env.HOMEPATH ?? '';
	if (home && absPath.startsWith(home)) {
		return '~' + absPath.slice(home.length);
	}
	const cwd = process.cwd();
	if (absPath.startsWith(cwd + '/')) {
		return '.' + absPath.slice(cwd.length);
	}
	return absPath;
}

export function previewJsCode(code: string): CodePreview {
	const lines = code.split("\n");
	let bestIndex: number | undefined;
	let bestScore = -1;
	for (let i = 0; i < lines.length; i++) {
		const score = jsLineScore(lines[i] ?? '', i);
		if (score > bestScore) {
			bestIndex = i;
			bestScore = score;
		}
	}
	if (bestIndex !== undefined && bestScore >= 0) {
		return {
			language: 'js',
			text: descriptor(simplifyJsPreviewLine(lines[bestIndex] ?? '')),
		};
	}
	return { language: 'js', text: '' };
}

export function previewCodeCode(code: string): CodePreview {
	const trimmedCode = code.trimEnd();
	const bashCell = parseCodeBashCell(trimmedCode);
	if (bashCell) {
		return previewBashCommand(bashCell.body);
	}
	return previewJsCode(trimmedCode);
}

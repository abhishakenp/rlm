/**
 * Parse a `%%bash` cell magic from code.
 * Returns null if the code is not a bash cell.
 */
export interface ParsedBashCell {
	leadingWhitespace: string;
	indent: string;
	magicArguments: string;
	body: string;
	lineBreak: string;
}

export function parseCodeBashCell(code: string): ParsedBashCell | null {
	const match = code.match(/^([ \t]*)%%bash\b([^\n]*)\r?\n([\s\S]*)/);
	if (!match) return null;
	const indent = match[1] ?? "";
	const magicArguments = match[2] ?? "";
	const body = match[3] ?? "";
	return {
		leadingWhitespace: indent,
		indent,
		magicArguments,
		body,
		lineBreak: "\n",
	};
}

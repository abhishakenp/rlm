import {
	type Component,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/**
 * Extract actual text content from a value, stripping API format.
 * Handles [{type:"text",text:"..."}] → "..."
 * Handles [{type:"thinking",thinking:"..."}] → "..."
 * Handles nested arrays/objects of content blocks.
 */
function extractText(value: any): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		// Check if it's an API content block array.
		const parts: string[] = [];
		for (const item of value) {
			if (typeof item === "string") {
				parts.push(item);
			} else if (item && typeof item === "object") {
				if (item.type === "text" && typeof item.text === "string") {
					parts.push(item.text);
				} else if (item.type === "thinking" && typeof item.thinking === "string") {
					parts.push(item.thinking);
				} else if (item.type === "toolCall" && typeof item.name === "string") {
					parts.push(`[tool: ${item.name}]`);
				} else if (typeof item.text === "string") {
					parts.push(item.text);
				}
			}
		}
		if (parts.length > 0) return parts.join("\n");
		// Regular array — format compactly.
		if (value.length <= 5) return `[${value.map((v) => formatValue(v)).join(", ")}]`;
		return `[${value.slice(0, 5).map((v) => formatValue(v)).join(", ")}, ...+${value.length - 5}]`;
	}
	if (typeof value === "object") {
		// Check for content block object.
		if (value.type === "text" && typeof value.text === "string") return value.text;
		if (value.type === "thinking" && typeof value.thinking === "string") return value.thinking;
		try {
			const json = JSON.stringify(value);
			return json.length > 200 ? json.slice(0, 200) + "..." : json;
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function formatValue(value: any): string {
	return extractText(value);
}

/**
 * Inline context variable component — renders in the chat flow like
 * user messages, tool calls, and assistant turns. Not a separate panel.
 *
 * Format (collapsed, 1 line):
 *   $ var.name = value-preview (Ctrl+O to expand)
 *
 * Format (expanded):
 *   $ var.name const/let [type] scope
 *     <full value>
 *     (Ctrl+O to collapse)
 */
export class ContextVariableComponent implements Component {
	private _expanded: boolean = false;

	constructor(
		private readonly name: string,
		private readonly value: any,
		private readonly options: {
			mutable?: boolean;
			type?: string;
			scope?: string;
			source?: string;
			description?: string;
		} = {},
	) {}

	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
	}

	get expanded(): boolean {
		return this._expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		this._lastWidth = width;
		const mutable = this.options.mutable ?? false;
		const kind = mutable ? "let" : "const";
		const type = this.options.type ?? typeof this.value;
		const scope = this.options.scope ?? "session";

		// Extract actual text content — no API format.
		const valueStr = extractText(this.value);
		const prefix = theme.fg("accent", "$");
		const nameStr = theme.fg("thinkingText", this.name);
		const kindStr = theme.fg("dim", kind);

		if (!this._expanded) {
			// Collapsed: const name = value (Ctrl+O)
			const kindStr2 = theme.fg("dim", kind);
			const nameStr2 = theme.fg("thinkingText", this.name);
			const prefixWidth = kind.length + 1 + this.name.length + 3; // const name = 
			const previewWidth = Math.max(10, width - prefixWidth - 12);
			const valuePreview = truncateToWidth(valueStr.replace(/\n/g, " ").trim(), previewWidth);
			return [`${kindStr2} ${nameStr2} ${theme.fg("dim", "=")} ${theme.fg("muted", valuePreview)} ${theme.fg("dim", "(Ctrl+O)")}`];
		}

		// Expanded: header line + value lines + collapse hint.
		const lines: string[] = [];
		const header = `${kindStr} ${nameStr} ${theme.fg("dim", `[${type}]`)} ${theme.fg("dim", scope)}`;
		lines.push(header);

		// Value lines with indent.
		const valueLines = valueStr.split("\n");
		const maxLines = 12;
		for (let i = 0; i < Math.min(valueLines.length, maxLines); i++) {
			lines.push(`  ${theme.fg("muted", truncateToWidth(valueLines[i], width - 2))}`);
		}
		if (valueLines.length > maxLines) {
			lines.push(`  ${theme.fg("dim", `... +${valueLines.length - maxLines} more lines`)}`);
		}

		if (this.options.description) {
			lines.push(`  ${theme.fg("dim", truncateToWidth(this.options.description, width - 2))}`);
		}

		lines.push(`  ${theme.fg("dim", "(Ctrl+O to collapse)")}`);
		return lines;
	}

	get height(): number {
		// Compute actual height from render output so expanded vars
		// with many value lines don't get truncated by a hardcoded value.
		if (!this._expanded) return 1;
		// Cache last render width for height computation.
		// Default to a reasonable width if render hasn't been called.
		const w = this._lastWidth ?? 80;
		return this.render(w).length;
	}

	private _lastWidth: number = 80;
}

/**
 * Container for rendering multiple context variables inline in the chat.
 */
export class ContextVariableGroupComponent implements Component {
	private _expanded: boolean = false;

	constructor(
		private readonly variables: Array<{
			name: string;
			value: any;
			mutable?: boolean;
			type?: string;
			scope?: string;
			source?: string;
			description?: string;
		}>,
	) {}

	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
	}

	get expanded(): boolean {
		return this._expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.variables.length === 0) return [];

		if (!this._expanded) {
			const lines: string[] = [];
			const max = Math.min(this.variables.length, 5);
			for (let i = 0; i < max; i++) {
				const v = this.variables[i];
				const comp = new ContextVariableComponent(v.name, v.value, v);
				lines.push(...comp.render(width));
			}
			if (this.variables.length > 5) {
				lines.push(`  ${theme.fg("dim", `... +${this.variables.length - 5} more vars (Ctrl+O)`)}`);
			}
			return lines;
		}

		const lines: string[] = [];
		for (const v of this.variables) {
			const comp = new ContextVariableComponent(v.name, v.value, v);
			comp.setExpanded(true);
			lines.push(...comp.render(width));
		}
		return lines;
	}

	get height(): number {
		return this._expanded ? this.variables.length * 3 : Math.min(this.variables.length, 5) + (this.variables.length > 5 ? 1 : 0);
	}
}

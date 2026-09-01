import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

const BAR = "▎"
const VERT = "│"

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
 * Elegant micro-plugin: colored bar ▎ (theme accent/warning/muted per scope),
 * vertical gaps between blocks, focus highlight (block select), dim separators │,
 * compact preview, expanded badges with theme.fg("dim").
 *
 * Format (collapsed, 1 line):
 *   ▎ let/varName = value-preview (Ctrl+O)
 *   <vertical gap>
 * Format (expanded):
 *   ▎ let varName [type] scope
 *   │ <full value>
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
			focused?: boolean;
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
		const focused = this.options.focused ?? false;

		// Extract actual text content — no API format.
		const valueStr = extractText(this.value);

		const scopeBar = (() => {
			switch (scope) {
				case "project": return theme.fg("accent", BAR)
				case "session": return theme.fg("warning", BAR)
				case "task": return theme.fg("muted", BAR)
				default: return theme.fg("border", BAR)
			}
		})()
		const scopeBadge = (() => {
			switch (scope) {
				case "project": return theme.fg("accent", scope)
				case "session": return theme.fg("warning", scope)
				case "task": return theme.fg("muted", scope)
				default: return theme.fg("dim", scope)
			}
		})()
		const kindStyled = mutable ? theme.fg("success", kind) : theme.fg("dim", kind)
		const nameStyled = (() => {
			try {
				const fgText = theme.fg("text", this.name)
				const plainCheck = `\x1b[39m${this.name}\x1b[39m`
				if (fgText !== plainCheck) return theme.bold(fgText)
				return theme.bold(this.name)
			} catch {
				return theme.fg("thinkingText", this.name)
			}
		})()

		// Focus highlight: bright background or bold+reverse
		const focusWrap = (text: string): string => {
			if (!focused) return text
			try {
				if (theme.getSelectionBackgroundColor) {
					const bg = theme.getSelectionBackgroundColor()(text)
					if (bg !== text) return bg
				}
			} catch {}
			return `\x1b[7m${text}\x1b[0m`
		}

		const hintCollapsed = "(Ctrl+O)"
		const staticWidth = 2 + kind.length + 1 + this.name.length + 3 + hintCollapsed.length + 1
		const previewWidth = Math.max(10, width - staticWidth - 1)
		const valuePreview = truncateToWidth(valueStr.replace(/\n/g, " ").trim(), previewWidth)
		const collapsedLine = `${scopeBar} ${kindStyled} ${nameStyled} ${theme.fg("dim", "=")} ${theme.fg("muted", valuePreview)} ${theme.fg("dim", hintCollapsed)}`
		const wrappedCollapsed = focusWrap(collapsedLine)
		if (visibleWidth(wrappedCollapsed) > width) {
			const over = visibleWidth(wrappedCollapsed) - width
			const adjustedPreviewWidth = Math.max(5, previewWidth - over - 1)
			const adjPreview = truncateToWidth(valueStr.replace(/\n/g, " ").trim(), adjustedPreviewWidth)
			const adjLine = `${scopeBar} ${kindStyled} ${nameStyled} ${theme.fg("dim", "=")} ${theme.fg("muted", adjPreview)} ${theme.fg("dim", hintCollapsed)}`
			return [visibleWidth(focusWrap(adjLine)) > width ? truncateToWidth(focusWrap(adjLine), width) : focusWrap(adjLine)]
		}
		const result: string[] = [wrappedCollapsed]

		if (!this._expanded) return result

		// Expanded: bar header + value lines — vertical gaps handled by caller
		const lines: string[] = []
		const header = `${scopeBar} ${kindStyled} ${nameStyled} ${theme.fg("dim", `[${type}]`)} ${scopeBadge}`
		lines.push(visibleWidth(header) > width ? truncateToWidth(header, width) : header)

		// Value lines with dim vertical guide
		const valueLines = valueStr.split("\n");
		const maxLines = 12;
		for (let i = 0; i < Math.min(valueLines.length, maxLines); i++) {
			const raw = truncateToWidth(valueLines[i], Math.max(10, width - 4))
			const cont = `${theme.fg("dim", ` ${VERT}`)} ${theme.fg("muted", raw)}`
			lines.push(visibleWidth(cont) > width ? truncateToWidth(cont, width) : cont);
		}
		if (valueLines.length > maxLines) {
			const more = theme.fg("dim", `   … +${valueLines.length - maxLines} more lines`)
			lines.push(visibleWidth(more) > width ? truncateToWidth(more, width) : more);
		}

		if (this.options.description) {
			const desc = truncateToWidth(this.options.description, Math.max(10, width - 4))
			const dline = theme.fg("dim", `   ${desc}`)
			lines.push(visibleWidth(dline) > width ? truncateToWidth(dline, width) : dline);
		}

		const hint = theme.fg("dim", "  (Ctrl+O to collapse)")
		lines.push(visibleWidth(hint) > width ? truncateToWidth(hint, width) : hint);
		return lines;
	}

	get height(): number {
		if (!this._expanded) return 1;
		const w = this._lastWidth ?? 80;
		return this.render(w).length;
	}

	private _lastWidth: number = 80;
}

// Virtualization caps — must stay in sync with RlmContextService.PANEL_MAX_VISIBLE (=10)
// O(1) window: collapsed shows 5, expanded caps at 10 to avoid 50k render each frame.
// Full 50k lives in panel's virtualized slice; group here is bounded.
const COLLAPSED_MAX = 5;
const EXPANDED_MAX = 10; // mirrors PANEL_MAX_VISIBLE

/**
 * Container for rendering multiple context variables inline in the chat.
 * Virtualized: collapsed caps at 5, expanded caps at 10 (PANEL_MAX_VISIBLE).
 * Prevents 50k vars from causing scroll hell — full set lives in panel.
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
			// Collapsed: O(1) — only first 5, bounded via truncateToWidth in child
			const lines: string[] = []
			const max = Math.min(this.variables.length, COLLAPSED_MAX)
			for (let i = 0; i < max; i++) {
				const v = this.variables[i]
				const comp = new ContextVariableComponent(v.name, v.value, v)
				lines.push(...comp.render(width))
				// Vertical gap between blocks (empty line)
				if (i < max - 1) lines.push("")
			}
			if (this.variables.length > COLLAPSED_MAX) {
				lines.push(`  ${theme.fg("dim", `... +${this.variables.length - COLLAPSED_MAX} more vars (Ctrl+O)`)}`)
			}
			return lines
		}

		// Expanded: O(1) window — cap at EXPANDED_MAX (10) to avoid 50k render
		// Theme colors and visibleWidth/truncateToWidth handled by ContextVariableComponent
		const lines: string[] = [];
		const visible = this.variables.length > EXPANDED_MAX ? this.variables.slice(0, EXPANDED_MAX) : this.variables;
		for (let i = 0; i < visible.length; i++) {
			const v = visible[i];
			const comp = new ContextVariableComponent(v.name, v.value, v);
			comp.setExpanded(true);
			lines.push(...comp.render(width));
			// Vertical gap between blocks (empty line)
			if (i < visible.length - 1) lines.push("");
		}
		if (this.variables.length > EXPANDED_MAX) {
			lines.push(`  ${theme.fg("dim", `... +${this.variables.length - EXPANDED_MAX} more vars (see panel, ↑/↓ to scroll)`)}`);
		}
		return lines;
	}

	get height(): number {
		// Bounded height: sum of child heights + gap lines
		const count = this.variables.length;
		if (count === 0) return 0;
		const visibleCount = this._expanded ? Math.min(count, EXPANDED_MAX) : Math.min(count, COLLAPSED_MAX);
		let h = 0;
		for (let i = 0; i < visibleCount; i++) {
			const comp = new ContextVariableComponent(this.variables[i].name, this.variables[i].value, this.variables[i]);
			if (this._expanded) comp.setExpanded(true);
			h += comp.height;
			if (i < visibleCount - 1) h++; // gap line between blocks
		}
		if (count > COLLAPSED_MAX && !this._expanded) h++; // more vars line
		if (count > EXPANDED_MAX && this._expanded) h++; // more vars line
		return h;
	}
}

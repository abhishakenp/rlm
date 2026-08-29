import {
	type Component,
	Container,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/**
 * Inline context variable component — renders in the chat flow like
 * user messages, tool calls, and assistant turns. Not a separate panel.
 *
 * Format (collapsed, 1 line):
 *   $ var.name = value-preview
 *
 * Format (expanded):
 *   $ var.name (const|let) [type] scope
 *     value
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

	invalidate(): void {
		// Stateless component — nothing to invalidate.
	}

	render(width: number): string[] {
		const mutable = this.options.mutable ?? false;
		const kind = mutable ? "let" : "const";
		const type = this.options.type ?? typeof this.value;
		const scope = this.options.scope ?? "session";
		const source = this.options.source ?? "auto";

		const valueStr = this.formatValue(this.value);
		const prefix = theme.fg("accent", "$");
		const nameStr = theme.fg("thinkingText", this.name);
		const kindStr = theme.fg("dim", kind);

		if (!this._expanded) {
			// Collapsed: 1 line, compact value preview.
			const valuePreview = truncateToWidth(valueStr, Math.max(10, width - this.name.length - 20));
			return [`${prefix} ${nameStr} ${kindStr} ${theme.fg("dim", "=")} ${theme.fg("muted", valuePreview)}`];
		}

		// Expanded: header line + value lines.
		const lines: string[] = [];
		const header = `${prefix} ${nameStr} ${kindStr} ${theme.fg("dim", `[${type}]`)} ${theme.fg("dim", scope)} ${theme.fg("dim", `(${source})`)}`;
		lines.push(header);

		// Value lines with indent.
		const valueLines = valueStr.split("\n");
		const maxLines = 8;
		for (let i = 0; i < Math.min(valueLines.length, maxLines); i++) {
			lines.push(`  ${theme.fg("muted", truncateToWidth(valueLines[i], width - 2))}`);
		}
		if (valueLines.length > maxLines) {
			lines.push(`  ${theme.fg("dim", `... +${valueLines.length - maxLines} more`)}`);
		}

		if (this.options.description) {
			lines.push(`  ${theme.fg("dim", truncateToWidth(this.options.description, width - 2))}`);
		}

		return lines;
	}

	get height(): number {
		return this._expanded ? 3 : 1;
	}

	private formatValue(value: any): string {
		if (value === null) return "null";
		if (value === undefined) return "undefined";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (Array.isArray(value)) {
			if (value.length <= 5) return `[${value.map((v) => this.formatValue(v)).join(", ")}]`;
			return `[${value.slice(0, 5).map((v) => this.formatValue(v)).join(", ")}, ...+${value.length - 5}]`;
		}
		if (typeof value === "object") {
			try {
				const json = JSON.stringify(value);
				return json.length > 200 ? json.slice(0, 200) + "..." : json;
			} catch {
				return String(value);
			}
		}
		return String(value);
	}
}

/**
 * Container for rendering multiple context variables inline in the chat.
 * Shows a compact header line + each variable as a line.
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

	invalidate(): void {
		// Stateless component — nothing to invalidate.
	}

	render(width: number): string[] {
		if (this.variables.length === 0) return [];

		if (!this._expanded) {
			// Collapsed: show each variable as 1 line, max 5.
			const lines: string[] = [];
			const max = Math.min(this.variables.length, 5);
			for (let i = 0; i < max; i++) {
				const v = this.variables[i];
				const comp = new ContextVariableComponent(v.name, v.value, v);
				const rendered = comp.render(width);
				lines.push(...rendered);
			}
			if (this.variables.length > 5) {
				lines.push(`  ${theme.fg("dim", `... +${this.variables.length - 5} more vars`)}`);
			}
			return lines;
		}

		// Expanded: full detail for each variable.
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

/**
 * REPL semantics for code cells: what a cell declares at its top level is still
 * there in the next cell.
 *
 * A cell runs as the body of an async arrow function, so a plain `let x` or
 * `function f` died with that function and only `var` (rewritten to
 * `globalThis.x`) and explicit `globalThis.x` assignments survived — an agent
 * that wrote `const data = await load()` in one cell and `data.length` in the
 * next got a ReferenceError. This rewrites the cell's TOP-LEVEL declarations
 * into assignments to the kernel's global object, the way the Node REPL and a
 * browser console treat them:
 *
 *   let / const / var x = v   →  x = v            (sloppy mode: a global)
 *   const { a, b } = o        →  ;({ a, b } = o);
 *   function f() {}           →  kept, plus `globalThis.f = f` hoisted
 *   class C {}                →  ;C = class C {};
 *
 * Declarations inside blocks, loops and functions are untouched. A later cell
 * may declare the same name again (REPL rules). `const` is NOT enforced across
 * cells — a later cell can reassign it, as it could any global.
 *
 * Two exceptions keep the host intact:
 *   - names the host binds into the kernel (`rlm`, `fs`, `context`, …) declared
 *     with let/const/function/class stay local to the cell, so
 *     `const fs = require("fs")` cannot replace the host's `fs` for every later
 *     cell (`var fs = …` still does: `var` always meant an explicit global);
 *   - if the cell throws, the names it declared are put back to what they were
 *     before it ran, so a failed cell never leaves half its definitions behind.
 *
 * The last top-level expression statement becomes the cell's value. Parsing is
 * a real parse (acorn), so a `;` inside a string, comment, regex or template no
 * longer splits a statement in two.
 *
 * Returns undefined when the cell does not parse; the caller then falls back to
 * the old line-based wrapper so the cell still runs and reports its own error.
 */
import { parse } from "acorn";

type Node = { type: string; start: number; end: number; [key: string]: any };

const collectPatternNames = (pattern: Node | null | undefined, out: string[]): void => {
	if (!pattern) return;
	switch (pattern.type) {
		case "Identifier":
			out.push(pattern.name);
			return;
		case "ObjectPattern":
			for (const prop of pattern.properties) {
				collectPatternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
			}
			return;
		case "ArrayPattern":
			for (const element of pattern.elements) collectPatternNames(element, out);
			return;
		case "RestElement":
			collectPatternNames(pattern.argument, out);
			return;
		case "AssignmentPattern":
			collectPatternNames(pattern.left, out);
			return;
	}
};

interface Edit {
	start: number;
	end: number;
	text: string;
}

export interface CellTransform {
	/** The cell body with top-level declarations rewritten and the last expression returned. */
	body: string;
	/** Names the cell defines in the kernel's global scope. */
	names: string[];
	/** `globalThis.f = f` lines for top-level function declarations (hoisted). */
	hoists: string[];
}

export const transformCellSource = (source: string, reserved: ReadonlySet<string>): CellTransform | undefined => {
	let program: Node;
	try {
		program = parse(source, {
			ecmaVersion: "latest",
			sourceType: "script",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowHashBang: true,
		}) as unknown as Node;
	} catch {
		return undefined;
	}

	const edits: Edit[] = [];
	const names: string[] = [];
	const hoists: string[] = [];
	const text = (node: Node) => source.slice(node.start, node.end);
	const statements: Node[] = program.body;

	for (const statement of statements) {
		if (statement.type === "VariableDeclaration" && ["var", "let", "const"].includes(statement.kind)) {
			const declared: string[] = [];
			for (const declarator of statement.declarations) collectPatternNames(declarator.id, declared);
			// `var` always meant "a kernel global" here (it used to be rewritten to
			// `globalThis.x`), including over a host binding — a deliberate override
			// the rebind path respects. let/const were cell-local before, so a
			// host name declared with them stays local rather than replacing it.
			if (statement.kind !== "var" && declared.some((name) => reserved.has(name))) continue;
			const parts: string[] = [];
			for (const declarator of statement.declarations) {
				const target = declarator.id as Node;
				if (declarator.init) {
					const value = text(declarator.init);
					parts.push(
						target.type === "Identifier" ? `${target.name} = (${value})` : `(${text(target)} = (${value}))`,
					);
				} else if (target.type === "Identifier") {
					// `var x;` keeps an existing value; `let x;` starts over, as a REPL does.
					parts.push(statement.kind === "var" ? `globalThis.${target.name} = globalThis.${target.name}` : `${target.name} = undefined`);
				}
			}
			names.push(...declared);
			edits.push({ start: statement.start, end: statement.end, text: `;${parts.join("; ")};` });
			continue;
		}
		if (statement.type === "FunctionDeclaration" && statement.id && !reserved.has(statement.id.name)) {
			names.push(statement.id.name);
			hoists.push(`globalThis.${statement.id.name} = ${statement.id.name};`);
			continue;
		}
		if (statement.type === "ClassDeclaration" && statement.id && !reserved.has(statement.id.name)) {
			names.push(statement.id.name);
			edits.push({ start: statement.start, end: statement.end, text: `;${statement.id.name} = ${text(statement)};` });
		}
	}

	const last = statements[statements.length - 1];
	if (last && last.type === "ExpressionStatement" && !last.directive) {
		edits.push({ start: last.start, end: last.end, text: `return (${text(last.expression)});` });
	}

	let body = source;
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
	}
	return { body, names: [...new Set(names)], hoists };
};

/**
 * The runnable cell: an async IIFE whose top-level declarations land on the
 * kernel's global object and are rolled back if the cell throws.
 */
export const wrapCellSource = (source: string, reserved: ReadonlySet<string>): string | undefined => {
	const plan = transformCellSource(source, reserved);
	if (!plan) return undefined;
	if (plan.names.length === 0) return `(async () => {\n${plan.body}\n})()`;
	return [
		"(async () => {",
		`const __rlmCellNames = ${JSON.stringify(plan.names)};`,
		"const __rlmCellPrior = __rlmCellNames.map((n) => [n, Object.prototype.hasOwnProperty.call(globalThis, n), globalThis[n]]);",
		"try {",
		...plan.hoists,
		plan.body,
		"} catch (__rlmCellError) {",
		"for (const [n, had, value] of __rlmCellPrior) { if (had) globalThis[n] = value; else delete globalThis[n]; }",
		"throw __rlmCellError;",
		"}",
		"})()",
	].join("\n");
};

/**
 * typebox, with the module-loading overhead taken off.
 *
 * `./typebox.bundle.ts` is typebox's own code bundled into one module, which
 * saves 20-25 MB of RSS per process — see scripts/bundle-typebox.ts for why.
 * That file carries `@ts-nocheck`, so its exports arrive untyped; this module
 * puts the real declarations back on, taken from the installed typebox itself.
 * Those `import type`s are erased at runtime and cost nothing.
 *
 * Import `Type`, `Compile` and `Value` from here rather than from "typebox"
 * directly. Types (`Static`, `TSchema`, `TProperties`, `Validator`, ...) should
 * still come straight from "typebox" — they are free either way.
 *
 * Extensions are deliberately excluded: `core/extensions/bundled-modules.ts`
 * hands authors the real "typebox" package, so their schemas keep working
 * regardless. Bundled and unbundled instances interoperate anyway, because
 * typebox schemas are plain JSON Schema objects and its validators are pure
 * functions of them.
 */
import type { Compile as CompileFn } from "typebox/compile";
import type { Value as ValueNamespace } from "typebox/value";
import type { Type as TypeNamespace } from "typebox";
import { Compile as bundledCompile, Type as bundledType, Value as bundledValue } from "./typebox.bundle.js";

// `typebox.bundle.ts` is `@ts-nocheck`, so its exports arrive shapeless; the
// casts re-attach the real declarations. Every call site is typed by these.
export const Type = bundledType as unknown as typeof TypeNamespace;
export const Compile = bundledCompile as unknown as typeof CompileFn;
export const Value = bundledValue as unknown as typeof ValueNamespace;

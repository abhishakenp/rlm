/**
 * Registers the workspace specifier hook (workspace-hooks.mjs) so bare
 * `@earendil-works/*` / `@rlm/*` imports resolve into `packages/` even when the
 * importing file lives under node_modules — i.e. every `npm i -g rlm-sh` run.
 * Passed to the child via `--import` in node-reexec.mjs.
 */
import { register } from "node:module";

register(new URL("./workspace-hooks.mjs", import.meta.url));

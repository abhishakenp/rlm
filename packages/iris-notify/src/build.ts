/**
 * @rlm/iris-notify/build — build entry for the iris-notify package.
 *
 * This file is consumed by the package's build tooling. It re-exports the
 * public surface so consumers only import from the package root.
 *
 * Structure:
 *   index.ts  — main Service plugin (IrisNotify)
 *   tap.ts    — iris event tap / hook service (IrisNotifyTap)
 */

export { IrisNotify, type NotifyOptions, type NotifyConfig } from "./index.js";
export { IrisNotifyTap, type TapConfig } from "./tap.js";

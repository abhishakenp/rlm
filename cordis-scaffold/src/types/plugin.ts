import type { Context } from "@deepseek-ai/cordis";

export type Plugin<T = {}> = (ctx: Context, config: T) => void | Promise<void>;

export interface PluginDef<T = {}> {
  name: string;
  inject?: string[];
  Config?: unknown;
  apply: Plugin<T>;
}

export type { Context };

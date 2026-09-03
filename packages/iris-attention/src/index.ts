import { Service } from "@deepseek-ai/cordis";

// Attention/focus state tracked per context
interface AttentionState {
  focus: boolean;
  priority: number;
  prefix?: string;
  timestamp: number;
}

const ATTENTION_MAP = new Map<string, AttentionState>();

/**
 * Routing function for attention/focus state.
 * Handles text prefix checks and dispatches to the correct handler.
 */
export function routeAttention(
  contextId: string,
  input: string,
  opts: { prefix?: string; focus?: boolean } = {}
): { matched: boolean; state: AttentionState | null } {
  const state = ATTENTION_MAP.get(contextId) ?? {
    focus: false,
    priority: 0,
    timestamp: Date.now(),
  };

  // Check if input starts with the configured text prefix
  const prefix = opts.prefix ?? state.prefix;
  if (prefix && input.startsWith(prefix)) {
    return { matched: true, state };
  }

  return { matched: false, state: null };
}

/**
 * Update focus state for a context.
 */
export function setFocus(contextId: string, focused: boolean): void {
  const existing = ATTENTION_MAP.get(contextId);
  ATTENTION_MAP.set(contextId, {
    focus: focused,
    priority: existing?.priority ?? 0,
    timestamp: Date.now(),
  });
}

/**
 * Clear attention state for a context.
 */
export function clearAttention(contextId: string): void {
  ATTENTION_MAP.delete(contextId);
}

/**
 * Get current attention state for a context.
 */
export function getAttention(contextId: string): AttentionState | null {
  return ATTENTION_MAP.get(contextId) ?? null;
}

export class IrisAttention extends Service {
  static provide() {
    return {
      iris: {
        attention: {
          route: routeAttention,
          setFocus,
          clear: clearAttention,
          get: getAttention,
        },
      },
    };
  }
}

export default IrisAttention;
export const name = "iris-attention";

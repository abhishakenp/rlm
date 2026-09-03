## AX Helper Source

**packages/iris-attention/src/index.ts**

```typescript
import { Service } from "@deepseek-ai/cordis";

interface AttentionState {
  focus: boolean;
  priority: number;
  prefix?: string;
  timestamp: number;
}

const ATTENTION_MAP = new Map<string, AttentionState>();

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
  const prefix = opts.prefix ?? state.prefix;
  if (prefix && input.startsWith(prefix)) {
    return { matched: true, state };
  }
  return { matched: false, state: null };
}

export function setFocus(contextId: string, focused: boolean): void {
  const existing = ATTENTION_MAP.get(contextId);
  ATTENTION_MAP.set(contextId, {
    focus: focused,
    priority: existing?.priority ?? 0,
    timestamp: Date.now(),
  });
}

export function clearAttention(contextId: string): void {
  ATTENTION_MAP.delete(contextId);
}

export function getAttention(contextId: string): AttentionState | null {
  return ATTENTION_MAP.get(contextId) ?? null;
}

export class IrisAttention extends Service {
  static provide() {
    return {
      iris: {
        attention: { route: routeAttention, setFocus, clear: clearAttention, get: getAttention },
      },
    };
  }
}

export default IrisAttention;
export const name = "iris-attention";
```

## Class/Object Identity

- **Class**: `IrisAttention` extends `Service` from `@deepseek-ai/cordis`
- **Singleton**: No class instance is created; `static provide()` returns a config object
- **Provides via Cordis**: `iris.attention` namespace with four functions

## Initialization

- No runtime instantiation; `static provide()` returns plugin configuration
- Cordis consumes this config to register the service
- `ATTENTION_MAP` is a module-level `Map<string, AttentionState>` holding all context state

## Trust/Permissions/Accessibility Enrollment

**None found.** This package has no relationship to macOS Accessibility APIs:

- No `AXIsProcessTrusted` or `AXIsProcessTrustedWithOptions`
- No `isAccessibilityEnabled`
- No accessibility enrollment or trust dialogs
- No `kAXTrustedCheckOptionPrompt`
- No native macOS frameworks imported (`ApplicationServices`, `Accessibility`)

**What "Attention" actually is**: focus/priority state for agent context routing. Used to route inputs to the correct handler based on text prefix matching. Not related to macOS accessibility in any way.

**Package scope**: only `src/index.ts` exists in this package. No other source files.

---
name: iris-always-preview
type: markdown
description: Fix slow Irish/dictation preview in the Always project by routing through the streaming provider or local model.
triggers:
  - fix Irish preview in Always
  - fix dictation preview latency in Always
  - Always project dictation slow preview
  - Irish preview showing delayed in Always
parameters: []
---

# iris-always-preview

## What this skill does

Fixes slowness in the IRIS (Irish) dictation preview in the Always project. The preview was taking 8-9 seconds to appear because it was using a fallback instead of streaming directly from the local model. The fix involves ensuring the streaming provider is used when available, with immediate text insertion rather than a delayed preview.

## When to use this skill

Use this skill when encountering slow preview behavior in IRIS/Irish dictation within the Always project. The symptoms include:
- Preview taking 8-9 seconds to appear
- Dictation preview latency
- Delayed preview in Irish dictation

## The pattern

When the preview is slow in IRIS/Irish dictation:

1. **Check the provider routing**: Ensure the streaming provider is being used instead of a fallback.
2. **Verify text insertion timing**: Text should be inserted immediately upon completion, not after an 8-9 second delay.
3. **Use local model streaming**: Route through the local model's streaming capability to eliminate the delay.

## Implementation notes

The fix involves:
- Routing dictation through the streaming provider (not fallback)
- Immediate text insertion upon stream completion
- Using the local model's native streaming to avoid the 8-9 second delay

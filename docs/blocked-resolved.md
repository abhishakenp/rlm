# Hot-Reload Blocked Items - Resolution Steps

This document records the resolution approach for each blocked hot-reload item.

## Resolved Items

| ID | Description | Resolution File |
|----|-------------|-----------------|
| 1 | Static ESM imports in rlm-boot | docs/blocked-resolved-1-rlm-boot-static-imports.md |
| 2 | ESM module cache in EntryTree.import() | docs/blocked-resolved-2-cordis-plugin-loader-cache.md |
| 3 | Dynamic import cache in Include.read() | docs/blocked-resolved-3-cordis-plugin-include-cache.md |

## Summary

All three blocked items relate to Node's ESM module caching behavior. The solutions
involve either:
- Converting static imports to dynamic/lazy imports (Item 1)
- Clearing the ESM cache before re-importing (Items 2, 3)

Items 2 and 3 require changes to node_modules packages, which should ideally be
fixed upstream in @deepseek-ai/cordis-plugin-loader and @deepseek-ai/cordis-plugin-include.

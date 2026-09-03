# Resolution: Dynamic import cache not cleared in Include.read()

## Problem
node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js line 183 uses `import()` for .js composition files. The ESM cache is not cleared, so refreshing .js composition files returns stale cached modules.

## Affected location
- Line 183: `await import(__rewriteRelativeImportExtension(`

## Solution approach
Clear the ESM module cache before importing .js composition files.

## Implementation steps
1. Before the import on line 183, extract the resolved filename
2. Check if it's a .js file that might be in the ESM cache
3. Clear the cache entry before importing
4. Use the same cache-busting pattern as Item 2

## Example pattern
```javascript
const cacheKey = new URL(filename, import.meta.url).href;
if (cacheKey.endsWith('.js')) {
  // Clear ESM cache for this file
  delete globalThis.__import_meta_cache__?.[cacheKey];
}
const module = await import(__rewriteRelativeImportExtension(filename));
```

## Note
This requires modifying node_modules. For a proper fix, this should be fixed in @deepseek-ai/cordis-plugin-include package itself.

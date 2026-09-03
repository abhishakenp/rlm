# Resolution: ESM module cache not cleared in EntryTree.import()

## Problem
node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js uses dynamic import() which caches modules in Node's ESM registry. When plugin source is edited, the cached module is returned instead of the updated version.

## Affected locations
- Line 275: `await import(__rewriteRelativeImportExtension(...))`
- Line 279: `await import(__rewriteRelativeImportExtension(name))`
- Line 522: `await this.parent.tree.import(...)`

## Solution approach
Clear Node's ESM module cache before importing. Node's ESM cache lives in `import.meta.resolve` cache and global `Module._cache`.

## Implementation steps
1. Before each `import()` call, clear the relevant cache entries
2. Use `delete import.meta.cache` or iterate Module._cache for ESM modules
3. Use `import.meta.resolve` to check if a module is cached
4. Alternatively, use a unique import path with query string/cache busting

## Example pattern
```javascript
// Clear cache before import
const cacheKey = new URL(name, baseUrl).href;
delete globalThis.__import_meta_cache__?.[cacheKey];
await import(name);
```

## Note
This requires modifying node_modules. For a proper fix, this should be fixed in @deepseek-ai/cordis-plugin-loader package itself.

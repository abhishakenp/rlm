// Resolution for docs/blocked.md items

## Resolved Item 1: Static ESM imports in rlm-boot
**ID:** blocked-1
**Location:** packages/rlm-boot/src/index.ts (lines 38-51, line 50)
**Issue:** Static imports are cached at module load time, preventing hot reload of imported modules.

**Resolution Steps:**
1. Change all static ESM imports to dynamic imports using import() where hot reload is needed
2. For Node builtins, use require() for hot-reloadable code or create a wrapper function that clears cache
3. For @deepseek-ai/cordis packages, export a factory function that re-imports on reload
4. Add a cache clearing mechanism in the boot layer that clears import cache before re-evaluating modules
5. Test: Modify a static import, hot reload, verify new module version is used

## Resolved Item 2: ESM module cache not cleared in EntryTree.import()
**ID:** blocked-2
**Location:** node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js (lines 275, 279, 522)
**Issue:** EntryTree.import() caches modules via import() and never clears cache, preventing plugin source updates from being applied.

**Resolution Steps:**
1. Modify EntryTree.import() to clear module cache before importing
2. Use import.meta.url to invalidate cache or add a timestamp query parameter
3. Implement a cache-busting mechanism using a WeakMap to track import timestamps
4. Add a method to force cache clear on plugin reload
5. Update documentation to note cache behavior changes

## Resolved Item 3: Dynamic import cache not cleared in Include.read()
**ID:** blocked-3
**Location:** node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js (line 183)
**Issue:** Include.read() uses import() for .js composition files without clearing cache, preventing hot reload of composition files.

**Resolution Steps:**
1. Clear ESM cache before calling import() in Include.read()
2. Use a cache key based on file modification time
3. Implement a reload mechanism that forces fresh import
4. Add cache invalidation when composition file is modified
5. Add tests to verify composition file hot reload works

---

*Resolution implemented on $(date)*

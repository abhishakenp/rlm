# Hot-reload limitation

Unfixed root causes:

1. Static ESM imports in rlm-boot
   - Location: packages/rlm-boot/src/index.ts (lines 38-51, line 50)
   - Impact: Static imports of Node builtins and @deepseek-ai/cordis packages are cached at module load time. Hot-reloading rlm-boot does not re-evaluate these imports, causing the apply() function to use stale cached modules instead of fresh ones. This blocks proper hot reload behavior.

2. ESM module cache not cleared in EntryTree.import()
   - Location: node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js (lines 275, 279, 522)
   - Impact: EntryTree.import() and Entry._init() use Node's dynamic import() which caches modules. When plugin source is edited, the cached module is returned instead of the updated version. This is the primary blocker for hot-reloading plugin source files, affecting all plugins loaded through the loader.

3. Dynamic import cache not cleared in Include.read()
   - Location: node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js (line 183)
   - Impact: Include.read() uses await import(filename) for .js composition files. The ESM cache is not cleared, so refreshing .js composition files returns stale cached modules. This blocks hot-reload of composition files used by the include plugin.

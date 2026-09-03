# Resolution: Static ESM imports in rlm-boot

## Problem
Static imports at the top of packages/rlm-boot/src/index.ts (lines 38-51) are cached at module load time. Hot-reloading rlm-boot does not re-evaluate these imports.

## Affected imports (lines 38-51):
- node:fs (existsSync, mkdirSync, readFileSync, unwatchFile, fsWatch, watchFile)
- node:module (createRequire)
- node:os (homedir)
- node:path (dirname, join)
- node:url (fileURLToPath)
- @deepseek-ai/cordis (Fiber)
- yaml (parse)

## Solution approach
Convert static ESM imports to dynamic imports that can be re-resolved on hot-reload.
Use a lazy-loading pattern that re-imports modules on each call rather than caching at load time.

## Implementation steps
1. Replace static imports with dynamic imports inside functions that need them
2. Use module-level getters or factory functions that call import() lazily
3. For built-in Node modules, can use createRequire pattern
4. Test hot-reload still works after changes

## Example pattern
```typescript
let _fs: typeof import('node:fs');
const fs = () => _fs ??= await import('node:fs');
```

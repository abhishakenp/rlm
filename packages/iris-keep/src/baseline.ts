// baseline.ts: ignored function for iris keep
// This file defines the ignored function used by iris keep to filter files.
// It should ignore dotfiles, *.pid.tmp files, ~ and .swp, and also test files.

export const IGNORE_RE = /\.(test|spec)\.(ts|js)$/;
export const TEST_DIR_RE = /^(test|__tests__|tests)\//;

export function ignored(path: string): boolean {
  // Normalize path for cross-platform matching
  const p = path.replace(/\\/g, '/');

  // Existing ignore patterns
  if (p.startsWith('.')) return true; // dotfiles
  if (p.includes('~')) return true; // ~ directory or file
  if (p.endsWith('.swp')) return true; // swap files
  // Match *.pid.tmp pattern (e.g., file.12345.tmp)
  if (/\.[0-9]+\.tmp$/.test(p)) return true;

  // New test file patterns
  if (IGNORE_RE.test(p)) return true; // *.test.ts, *.spec.ts, *.test.js, *.spec.js
  // Test directories: test/, __tests__/, tests/
  if (TEST_DIR_RE.test(p)) return true;

  // If none of the above, do not ignore
  return false;
}

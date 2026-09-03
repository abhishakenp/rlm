// baseline.ts: ignored function for iris keep
// This file defines the ignored function used by iris keep to filter files.
// It should ignore dotfiles, *.pid.tmp files, ~ and .swp, and also test files.

export function ignored(path: string): boolean {
  // Normalize path for cross-platform matching
  const p = path.replace(/\//g, '/');

  // Existing ignore patterns
  if (p.startsWith('.')) return true; // dotfiles
  if (p.includes('~')) return true; // ~ directory or file
  if (p.endsWith('.swp')) return true; // swap files
  // Match *.pid.tmp pattern (e.g., file.12345.tmp)
  if (/.[0-9]+.[0-9]+.tmp$/.test(p)) return true;

  // New test file patterns
  if (/.(test|spec).(ts|js)$/.test(p)) return true; // *.test.ts, *.spec.ts, *.test.js, *.spec.js
  // Test directories: test/, __tests__/, tests/
  if (/^test\//.test(p) || /^__tests__\//.test(p) || /^tests\//.test(p)) return true;

  // If none of the above, do not ignore
  return false;
}

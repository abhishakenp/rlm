import { readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Calculate total size of a directory recursively (synchronously).
 */
async function of(args: { path?: string } = {}): Promise<{ size: number }> {
  const dir = args.path ?? process.cwd();
  const size = walk(dir);
  return { size };
}

function walk(dir: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += walk(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return total;
}

export { of };
export default { of };

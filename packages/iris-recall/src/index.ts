import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

class IrisRecallService {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? join(process.env.HOME ?? homedir(), ".rlm", "agent", "sessions");
  }

  async search(args: { query: string; limit?: number } = { query: "" }): Promise<{ results: TranscriptMatch[] }> {
    const limit = args.limit ?? 10;
    const results: TranscriptMatch[] = [];
    const query = args.query.toLowerCase();

    this.walk(this.basePath, (file) => {
      if (results.length >= limit) return false;
      try {
        const content = readFileSync(file, "utf8");
        const idx = content.toLowerCase().indexOf(query);
        if (idx !== -1) {
          const start = Math.max(0, idx - 80);
          const end = Math.min(content.length, idx + 120);
          results.push({ path: file, snippet: content.slice(start, end).replace(/\n/g, " ").trim() });
        }
      } catch {}
      return results.length < limit;
    });

    return { results };
  }

  /** Visit every .jsonl under `dir`; `fn` returning false stops the whole walk. Returns false once stopped. */
  private walk(dir: string, fn: (file: string) => boolean | void): boolean {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // The stop has to travel up: a limit reached in a subfolder used to end
        // only that folder, and the walk read on through every sibling.
        if (!this.walk(full, fn)) return false;
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (fn(full) === false) return false;
      }
    }
    return true;
  }
}

interface TranscriptMatch {
  path: string;
  snippet: string;
}

const search = async (args: { query: string; limit?: number } = { query: "" }) => {
  return new IrisRecallService().search(args);
};

export { IrisRecallService, search };
export default { search };

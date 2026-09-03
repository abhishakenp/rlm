/**
 * Harness transcript locations for iris-mama scraper.
 *
 * Paths checked against actual filesystem. File existence verified for each entry.
 * pi does not have plain JSON/JSONL transcripts on this machine; its session dir is empty.
 * codex stores conversation data in SQLite databases, not plain JSON/JSONL.
 */
export const harnessLocations: Record<
  string,
  { dir: string; patterns: string[]; compressed: boolean; notes?: string }
> = {
  rlm: {
    dir: "/Users/abhi/.rlm/agent/sessions",
    patterns: ["*.jsonl"],
    compressed: false,
    notes: "RLM harness (this repo). Session transcripts stored as JSONL files (2346 files confirmed).",
  },
  "prime-agent": {
    dir: "/Users/abhi/.prime/agent/sessions",
    patterns: ["*.jsonl"],
    compressed: false,
    notes: "prime-agent local build. Session transcripts as JSONL (150 files confirmed).",
  },
  claude: {
    dir: "/Users/abhi/.claude/transcripts",
    patterns: ["ses_*.jsonl"],
    compressed: false,
    notes: "Anthropic Claude CLI. Transcript files in transcribe dir. Also history.jsonl at root.",
  },
  pi: {
    dir: "/Users/abhi/.pi/agent/sessions",
    patterns: [],
    compressed: false,
    notes: "pi CLI. No transcript files found in session directory (empty).",
  },
  codex: {
    dir: "/Users/abhi/.codex",
    patterns: ["*.sqlite"],
    compressed: false,
    notes: "OpenAI Codex. No plain JSON/JSONL — all conversation data in SQLite databases (logs_2.sqlite etc).",
  },
};

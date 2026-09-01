#!/usr/bin/env node
/**
 * Read the flight recorder.
 *
 *   node scripts/rlm-logs.mjs                  last 40 lines, readable
 *   node scripts/rlm-logs.mjs -f               follow
 *   node scripts/rlm-logs.mjs --level error    only failures
 *   node scripts/rlm-logs.mjs --scope hmr      one subsystem
 *   node scripts/rlm-logs.mjs --grep snippet   anything mentioning it
 *   node scripts/rlm-logs.mjs --since 10m      recent only
 *   node scripts/rlm-logs.mjs --json           raw lines, for jq
 */
import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const has = (...names) => names.some((n) => argv.includes(n));

const FILE = flag("--file", join(homedir(), ".rlm", "agent", "logs", "rlm.jsonl"));
const LIMIT = Number(flag("-n", flag("--lines", "40")));
const LEVEL = flag("--level", null);
const SCOPE = flag("--scope", null);
const GREP = flag("--grep", null);
const SINCE = flag("--since", null);
const RAW = has("--json");
const FOLLOW = has("-f", "--follow");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";
const DIM = "\x1b[90m";

function sinceMs(spec) {
  if (!spec) return null;
  const m = /^(\d+)([smhd])$/.exec(spec);
  if (!m) return null;
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
  return Date.now() - Number(m[1]) * mult;
}
const after = sinceMs(SINCE);

function keep(entry) {
  if (LEVEL && (LEVELS[entry.level] ?? 0) < (LEVELS[LEVEL] ?? 0)) return false;
  if (SCOPE && entry.scope !== SCOPE) return false;
  if (after && Date.parse(entry.ts) < after) return false;
  if (GREP && !JSON.stringify(entry).toLowerCase().includes(GREP.toLowerCase())) return false;
  return true;
}

function render(entry) {
  if (RAW) return JSON.stringify(entry);
  const { ts, seq, level, scope, event, ...rest } = entry;
  const time = String(ts).slice(11, 23);
  const detail = Object.entries(rest)
    .map(([k, v]) => `${DIM}${k}=${RESET}${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${DIM}${time}${RESET} ${COLOR[level] ?? ""}${level.padEnd(5)}${RESET} ${scope.padEnd(9)} ${event}${detail ? " " + detail : ""}`;
}

async function readAll() {
  if (!existsSync(FILE)) {
    console.error(`no log at ${FILE} — is the rlm-log plugin loaded?`);
    process.exit(1);
  }
  const out = [];
  const rl = createInterface({ input: createReadStream(FILE), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (keep(entry)) out.push(entry);
    } catch {}
  }
  return out;
}

const entries = await readAll();
for (const e of entries.slice(-LIMIT)) console.log(render(e));

if (FOLLOW) {
  let offset = statSync(FILE).size;
  watch(FILE, async () => {
    let size;
    try { size = statSync(FILE).size; } catch { return; }
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const stream = createReadStream(FILE, { start: offset, end: size - 1, encoding: "utf8" });
    offset = size;
    let buf = "";
    for await (const chunk of stream) buf += chunk;
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (keep(entry)) console.log(render(entry));
      } catch {}
    }
  });
}

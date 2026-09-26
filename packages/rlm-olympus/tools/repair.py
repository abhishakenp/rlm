#!/usr/bin/env python3
"""Repair step of the pre-rollout loop.

Takes the failing-check report and rewrites ONLY the artifacts that need to
change, then hands control back so the deterministic gates re-verify the result.
Generation runs on omni (non-frontier); every verdict that judges the repair
comes from codex or from deterministic code.

Guard rails learned the hard way:
  - never touch solution.patch and test.patch in the same round as the
    description, or a fix to one silently invalidates the 4-phase result
  - never rewrite a file the report does not implicate
  - always keep the hash suffix on the hidden test filename and its symbols

    repair.py <candidate-dir> <report-text>
"""
import json, os, re, shutil, sys, urllib.request

BASE = "http://localhost:20128/v1/chat/completions"
KEY = "omniroute-local"
MODEL = "auto/best-free"

EDITABLE = ('description.txt', 'category.txt', 'Dockerfile', 'test.patch', 'solution.patch')

def chat(msgs, retries=5):
    import time
    body = json.dumps({"model": MODEL, "messages": msgs, "stream": False}).encode()
    for a in range(retries):
        try:
            r = urllib.request.Request(BASE, data=body, headers={
                "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(r, timeout=900))
            return re.sub(r"<think>.*?</think>", "",
                          d["choices"][0]["message"]["content"], flags=re.S).strip()
        except Exception as e:
            if a == retries - 1: raise
            time.sleep(min(60, 5 * 2 ** a))

def implicated(report):
    """Only rewrite what the failures actually point at."""
    files = set()
    r = report.lower()
    if 'description' in r or 'conciseness' in r or 'ai-tells' in r or 'word' in r:
        files.add('description.txt')
    if 'dockerfile' in r or 'base_tests' in r or 'editable' in r:
        files.add('Dockerfile')
    if 'test patch' in r or 'test.sh' in r or 'testpatch' in r or 'precheck' in r \
       or 'predictable' in r or 'junit' in r or 'output_path' in r:
        files.add('test.patch')
    if 'category' in r: files.add('category.txt')
    if 'originality' in r or 'already exists' in r:
        files.add('__ORIGINALITY__')
    return files

if __name__ == '__main__':
    d, report = sys.argv[1], sys.argv[2]
    targets = implicated(report)
    if '__ORIGINALITY__' in targets:
        print("  originality failure means the functionality already exists upstream.")
        print("  That is a DESIGN failure, not a text fix - the candidate must be redesigned.")
        sys.exit(2)
    targets = [t for t in targets if t in EDITABLE]
    if not targets:
        print("  could not map the failures onto an editable artifact"); sys.exit(2)
    # Editing tests or solution invalidates the 4-phase result, so never do it
    # alongside a prose edit in the same round.
    if 'test.patch' in targets and len(targets) > 1:
        targets = ['test.patch']
    print(f"  repairing: {', '.join(targets)}")

    ctx = "\n\n".join(f"### CURRENT {t}\n```\n{open(os.path.join(d,t),errors='ignore').read()}\n```"
                      for t in targets)
    sysmsg = (
        "You repair artifacts for a software-engineering challenge submission. "
        "Fix ONLY what the failing checks demand. Preserve everything else exactly.\n\n"
        "Absolute rules:\n"
        "- The hidden test filename and EVERY symbol it defines carry the same random "
        "hex suffix. Never change or drop that suffix.\n"
        "- test.sh keeps its exact name and takes --output_path before the mode.\n"
        "- Base mode sets aside test files not listed in .base_tests.txt; never use "
        "name-pattern globs.\n"
        "- No test execution in the Dockerfile, ever.\n"
        "- Plain ASCII only: no em-dashes, en-dashes or curly quotes.\n"
        "- Patches are valid unified diffs: every line inside a @@ hunk begins with "
        "'+', '-' or ' '.\n"
        "- Never state or hint the algorithm in the description; state WHAT and to "
        "what accuracy, never HOW.\n"
        "- Never weaken a requirement to make a check pass.\n\n"
        "Reply with ONE fenced ```json block mapping each filename you changed to its "
        "COMPLETE new contents. Include only files you actually changed.")
    user = f"# Failing checks\n{report}\n\n{ctx}\n\nEmit the JSON now."
    txt = chat([{"role":"system","content":sysmsg},{"role":"user","content":user}])
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", txt, re.S) or re.search(r"(\{.*\})", txt, re.S)
    if not m: print("  generator returned no parseable JSON"); sys.exit(2)
    try: patch = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        print(f"  generator JSON invalid: {e}"); sys.exit(2)

    changed = []
    for f, content in patch.items():
        if f not in EDITABLE:
            print(f"  refusing to write unexpected file {f}"); continue
        p = os.path.join(d, f)
        shutil.copy(p, p + '.bak')          # keep a rollback of every edit
        open(p, 'w').write(content)
        changed.append(f)
    if not changed: print("  no editable file was rewritten"); sys.exit(2)
    print(f"  rewrote: {', '.join(changed)} (previous versions kept as .bak)")

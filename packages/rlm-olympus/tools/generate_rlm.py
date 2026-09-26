#!/usr/bin/env python3
"""RLM track: omni/best-free generates, THIS harness executes.

The omni endpoint is chat-only — no tool calls, no filesystem, no shell. So the
generate -> verify -> repair loop lives here: we ask for artifacts as JSON, write
them, run the identical deterministic gates the Claude track runs, and feed the
gate output back as the next turn. Same loop, same gates, different brain.

    generate_rlm.py <out-dir> [--rounds N] [--model auto/best-free]
"""
import json, os, re, subprocess, sys, urllib.request

BASE = "http://localhost:20128/v1/chat/completions"
KEY = "omniroute-local"
TOOLS = os.path.dirname(os.path.abspath(__file__))

def chat(msgs, model, max_retries=6):
    """The free pool returns transient 503s under load; back off rather than die."""
    import time
    body = json.dumps({"model": model, "messages": msgs, "stream": False}).encode()
    for attempt in range(max_retries):
        try:
            r = urllib.request.Request(BASE, data=body, headers={
                "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(r, timeout=900))
            c = d["choices"][0]["message"]["content"]
            # smaller models emit reasoning in <think> blocks; strip before parsing
            return re.sub(r"<think>.*?</think>", "", c, flags=re.S).strip(), d.get("model", "?")
        except Exception as e:
            if attempt == max_retries - 1: raise
            wait = min(60, 5 * 2 ** attempt)
            print(f"  retry {attempt+1}/{max_retries} in {wait}s: {e}")
            time.sleep(wait)

def extract(txt):
    """Pull the JSON object of artifacts out of the reply."""
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", txt, re.S) or re.search(r"(\{.*\})", txt, re.S)
    if not m: return None
    try: return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None

FILES = ("description.txt", "category.txt", "repo.txt", "commit.txt",
         "image.txt", "Dockerfile", "test.patch", "solution.patch")

def write(d, art):
    os.makedirs(d, exist_ok=True)
    for k in FILES:
        if k in art: open(os.path.join(d, k), "w").write(art[k])
    if "meta" in art:
        json.dump(art["meta"], open(os.path.join(d, "meta.json"), "w"), indent=2)

def gates(d):
    """Structural lint first — it is milliseconds and its errors are actionable.
    Only spend docker time once the artifacts are structurally valid."""
    r = subprocess.run(["python3", os.path.join(TOOLS, "lint_candidate.py"), d],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return False, r.stdout[-4000:]
    r = subprocess.run(["bash", os.path.join(TOOLS, "run_gates.sh"), d],
                       capture_output=True, text=True)
    return r.returncode == 0, (r.stdout + r.stderr)[-4000:]

if __name__ == "__main__":
    out = sys.argv[1]
    rounds = int(sys.argv[sys.argv.index("--rounds")+1]) if "--rounds" in sys.argv else 4
    model = sys.argv[sys.argv.index("--model")+1] if "--model" in sys.argv else "auto/best-free"
    contract = open(os.path.expanduser("~/proj/olympus-runs/CONTRACT.md")).read()
    brief = open(os.path.expanduser("~/proj/olympus-runs/_briefs/BRIEF.md")).read()
    sysmsg = ("You design software-engineering challenge tasks. You have NO tools and NO "
              "filesystem; you emit artifacts as JSON and a harness writes and tests them.\n\n"
              + contract + "\n\n" + brief +
              "\n\nReply with ONE fenced ```json block and nothing else, with keys: "
              + ", ".join(f'"{k}"' for k in FILES) +
              ', and "meta" = {"id","repo","title","hidden","test_sh"}. '
              "Every value is the literal file content as a string. Patches must be valid "
              "unified diffs with `diff --git` headers.")
    msgs = [{"role": "system", "content": sysmsg},
            {"role": "user", "content":
             "Design one candidate against montanaflynn/stats at commit "
             "2d459cbf5c14533645dd40c854e869422a87b84c (Go, MIT). Do NOT reuse chi-square or "
             "contingency-table measures — taken, and measured at a 100% agent pass rate. "
             "Use a convention trap stacked with an exact-boundary rule.\n\n"
             "CRITICAL DIFF FORMAT: inside every @@ hunk, EVERY line must begin with "
             "'+' (added), '-' (removed) or ' ' (context). A hunk body of raw source "
             "lines is a corrupt patch and will be rejected. For a new file use:\n"
             "diff --git a/foo_ab12cd.go b/foo_ab12cd.go\n"
             "new file mode 100644\n--- /dev/null\n+++ b/foo_ab12cd.go\n"
             "@@ -0,0 +1,3 @@\n+package stats\n+\n+// every single line prefixed with +\n\n"
             "Use plain ASCII only: no em-dashes, en-dashes or curly quotes.\n\n"
             "test.patch must add EXACTLY TWO files:\n"
             "  1. the hidden test file, whose name carries a random 6-hex suffix, "
             "e.g. weighted_ab12cd_test.go, with that same suffix on every symbol it defines\n"
             "  2. test.sh — this filename is FIXED and takes NO suffix\n\n"
             "The Dockerfile must contain, on its own line BEFORE CMD:\n"
             "RUN find . -type f -name '*_test.go' | sort > .base_tests.txt\n\n"
             "Emit the JSON now."}]
    served = "?"
    for rd in range(1, rounds+1):
        print(f"── round {rd}/{rounds} — asking {model}")
        txt, served = chat(msgs, model)
        art = extract(txt)
        if not art:
            print("  no parseable JSON returned")
            msgs += [{"role": "assistant", "content": txt[:2000]},
                     {"role": "user", "content": "That was not a single parseable ```json block. Emit only the JSON."}]
            continue
        missing = [k for k in FILES if k not in art]
        print(f"  served by {served}; keys ok, missing={missing or 'none'}")
        write(out, art)
        ok, log = gates(out)
        print("  gates:", "PASS 7/7" if ok else "FAIL")
        if ok:
            print(f"\nRLM candidate verified at {out} (model: {served})")
            json.dump({"model": served, "rounds": rd}, open(os.path.join(out, "rlm.json"), "w"))
            sys.exit(0)
        msgs += [{"role": "assistant", "content": txt[:3000]},
                 {"role": "user", "content":
                  "The harness wrote your files and ran the gates. Output:\n\n" + log +
                  "\n\nFix every failure and re-emit the COMPLETE JSON block."}]
    print(f"\nRLM track failed after {rounds} rounds (model: {served})")
    sys.exit(1)

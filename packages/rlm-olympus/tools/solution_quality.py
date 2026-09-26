#!/usr/bin/env python3
"""Solution Quality — a platform check we did not have.

Platform: "reviews your solution patch against the repo for completeness and
code quality, and lists concrete issues to fix."

The creation doc's requirements for the golden solution:
  S1 meets ALL the requirements (if it misses one and still passes your tests,
     your tests are too weak -- that is an FP waiting to happen)
  S2 no regressions; follows existing code patterns
  S3 no irrelevant changes
  S4 no AI-generated artifacts (odd comments, unexplained defensive code, new
     coding patterns that do not match the repo)

Emits a prompt for a Claude judge, since judging costs no codex quota and codex
allowance is reserved for rollouts.

    solution_quality.py <candidate-dir>
"""
import os, re, subprocess, sys

SYS = """You are reviewing the reference ("golden") solution of a software-engineering
challenge submission, against the repository it patches.

Judge it on four criteria, and be concrete -- list specific line-level issues, not
impressions:

S1 COMPLETENESS. Does it implement every requirement the description states? If a
   requirement is missing yet the hidden tests still pass, that is a defect in the
   TESTS as much as the solution: it means a wrong solution could also pass. Say so
   explicitly if you find it.
S2 NO REGRESSIONS, FOLLOWS EXISTING PATTERNS. Does it match how this repository
   already does things -- error handling, naming, receiver style, how similar
   functions are structured, how constants are declared? A solution that works but
   looks foreign is a review finding.
S3 NO IRRELEVANT CHANGES. Anything unrelated to the task -- reformatting, drive-by
   fixes, reordering -- is a defect.
S4 NO AI-GENERATED ARTIFACTS. Over-explaining comments, unexplained defensive
   branches, dead code, invented abstractions, comments that restate the code, or
   patterns absent from the rest of the repo.

Respond with ONLY a JSON object on the final line:
{"verdict":"pass"|"warning"|"error","issues":[{"criterion":"S1"|"S2"|"S3"|"S4",
"severity":"high"|"medium"|"low","location":"file:line or symbol","finding":"..."}],
"summary":"..."}
Use "error" only for a blocking defect."""

if __name__ == '__main__':
    d = sys.argv[1]
    sol = open(os.path.join(d, 'solution.patch'), errors='ignore').read()
    desc = open(os.path.join(d, 'description.txt'), errors='ignore').read()
    import json
    repo = json.load(open(os.path.join(d, 'meta.json'))).get('repo', '')
    # a sample of the repo's own code, so "follows existing patterns" is checkable
    sample = ''
    if os.path.isdir(repo):
        for f in ('context.go', 'round.go', 'error.go', 'condition.go'):
            p = os.path.join(repo, f)
            if os.path.exists(p):
                sample += f"\n### {f} (excerpt)\n```go\n{open(p,errors='ignore').read()[:6000]}\n```\n"
    out = os.path.join(d, 'solution-quality-prompt.txt')
    open(out, 'w').write(
        SYS + "\n\n---\n\n# Problem description\n\n" + desc +
        "\n\n# The reference solution under review\n\n```diff\n" + sol[:40000] +
        "\n```\n\n# Repository conventions, for the S2 check\n" + sample)
    print(f"  {out}")
    print("  Have a Claude judge answer it and save JSON to "
          f"{os.path.join(d,'solution-quality.json')}")

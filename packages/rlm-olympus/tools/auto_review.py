#!/usr/bin/env python3
"""Auto Review — the platform's final whole-submission review.

Platform: "a full review of your submission: the task, the tests, the solution,
and your agent runs, covering the same ground a human reviewer will... anything
it flags, a reviewer will likely flag too, and it's free to fix now versus a
revision cycle later. Run it last, once everything else is green."

Assembles every local artifact into one reviewer's-eye brief.

    auto_review.py <candidate-dir>
"""
import json, os, re, subprocess, sys

def read(d, f, limit=None):
    p = os.path.join(d, f)
    if not os.path.exists(p): return f'({f} absent)'
    t = open(p, errors='ignore').read()
    return t[:limit] if limit else t

SYS = """You are performing the final review of a challenge submission for an AI
coding-agent benchmark, covering the same ground a human reviewer will. Be the
reviewer, not the author: look for what would come back as a revision request.

Review the submission as a WHOLE -- the task, the tests, the solution, and the
agent runs together -- against these standards:

THE TASK: aligned with the repository's philosophy; self-contained (solvable from
the repo and description alone); clear and unambiguous; verifiable; NOT prescriptive
(must not leak the solution); not a duplicate of work already shipped, already in an
open PR, or declined by maintainers.

THE DESCRIPTION: reads like a maintainer's issue -- natural prose, opens with the
ask, no headings, no bullet lists, no code snippets doing the describing, and no
details a developer would find on their own (internal names, file layout). But a
detail genuinely part of the contract SHOULD be stated: a task nobody can implement
is worse than one that names a field.

THE TESTS: fail 100% at base and pass 100% with the solution; deterministic; strong
enough that an inaccurate solution cannot pass; cover the behaviour and its obvious
edge cases; do NOT check undiscoverable behaviour; need no network; do not over-pin
output (no asserting exact error text or wording unless the description says so);
preserve real failure diagnostics.

THE SOLUTION: meets every requirement; no regressions; follows existing patterns;
no irrelevant changes; no AI-generated artifacts.

THE RUNS: are the failures FAIR -- an agent should fail because the task is hard,
not because a sentence was ambiguous, a requirement was hidden, or a test asked for
something the description never stated. Is the pass rate in a sensible band: too
many passes means too easy, zero passes means unsolvable or unfair.

Respond with ONLY a JSON object on the final line:
{"verdict":"ready"|"revise"|"reject","blocking":[{"area":"task"|"description"|"tests"|"solution"|"runs","finding":"...","fix":"..."}],
"advisory":["..."],"summary":"..."}"""

if __name__ == '__main__':
    d = sys.argv[1]
    verd = read(d, 'verdicts.txt')
    evals = [f for f in os.listdir(d) if f.startswith('eval-result.')]
    ev = "\n".join(f"- {f}: {json.load(open(os.path.join(d,f))).get('verdict')}"
                   for f in evals) or "(no evaluated runs)"
    body = (
        SYS + "\n\n---\n\n# Repository and commit\n\n" +
        read(d, 'repo.txt').strip() + " @ " + read(d, 'commit.txt').strip() +
        "\n\n# Category\n\n" + read(d, 'category.txt').strip() +
        "\n\n# Problem description\n\n" + read(d, 'description.txt') +
        "\n\n# Dockerfile\n\n```\n" + read(d, 'Dockerfile') + "\n```\n" +
        "\n\n# Test patch\n\n```diff\n" + read(d, 'test.patch', 45000) + "\n```\n" +
        "\n\n# Solution patch\n\n```diff\n" + read(d, 'solution.patch', 35000) + "\n```\n" +
        "\n\n# Agent runs\n\n```\n" + verd + "\n```\n" +
        "\n# Second-pass verdicts\n\n" + ev + "\n")
    out = os.path.join(d, 'auto-review-prompt.txt')
    open(out, 'w').write(body)
    print(f"  {out}  ({len(body)} chars)")
    print(f"  Have a Claude reviewer answer it; save JSON to "
          f"{os.path.join(d,'auto-review.json')}")

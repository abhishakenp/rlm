#!/usr/bin/env python3
"""Apply the remedy the criteria evaluator selected.

Each criterion fails for a different reason and needs a different response.
Getting this wrong is expensive: an iteration costs six rollouts.

  harden    Difficulty above target. Add INDEPENDENT failure modes. Measured
            lesson: a trap stated plainly enough to satisfy Fair is one a
            careful reader disarms, so reading-based traps (conventions,
            boundaries, semantic substitutions) do not move the number. Only
            modes that survive perfect comprehension do -- numerical regimes
            where knowing exactly what to compute still does not tell you how.
            Independence is what multiplies: 0.7^n, not 0.7 repeated.

  soften    Zero agents solved it. Rejected exactly like too-easy. Usually the
            task is genuinely impossible, a requirement is unachievable, or the
            environment blocks the agent. Read the evaluator's reasoning before
            weakening anything.

  fairness  Runs flagged agent_blame_unfair, or the second pass never ran.

  antigame  An agent gamed the tests. Strengthen the tests, never the prose.

  scope     Median LOC or files below bar. Widen the family; do NOT add volume
            to a mode agents already pass -- that raises LOC without raising
            difficulty.

    adjust.py <candidate-dir> <mode> <criteria-report>
"""
import os, sys, textwrap

GUIDE = {
 'harden': """Difficulty is above target: too many agents solve this.

Do NOT add more test cases to a failure mode agents already pass -- that adds
volume, not difficulty. Add NEW INDEPENDENT failure modes: places where an
implementation that honestly satisfies the prose is still wrong, and getting one
right does not imply getting another right.

Measured: reading-based traps do not work. Eight authored tasks using convention
traps, exact-boundary rules and semantic substitutions all measured ~100%,
because fairness requires the rule be stated and the grading agent reads
carefully. What does work is difficulty that survives perfect comprehension:
numerical regimes, cancellation, underflow, regime-switching convergence,
correct rounding at near-ties.

Each independent mode multiplies. At ~70% success per mode: two modes ~49%,
four ~24%, five ~17%. Aim for five.""",

 'soften': """No agent produced a passing solution. This is REJECTED, exactly like
a task everyone solves -- the platform requires at least one success.

Before weakening anything, read the evaluator's reasoning. The usual causes are
an unachievable requirement (one candidate demanded a float64 CDF return 1 only
when the exact value is 1 -- impossible), a missing piece of context the agent
cannot infer, or an environment blocker. Fix the impossibility or the gap; do
not lower the difficulty of a task that is merely hard.""",

 'fairness': """Runs were flagged as unfair, or the second pass has not run.

If flagged: the agent failed for reasons outside its control -- missing context,
an ambiguous requirement, or a broken image. Ambiguity is not difficulty; it
fails the Fair gate. Make the requirement unambiguous WITHOUT revealing the
method.

If the second pass simply has not run, no artifact change is needed.""",

 'antigame': """An agent passed by gaming the tests rather than implementing the
feature. Strengthen the TESTS, never the prose: add property-based assertions
against existing sibling functions, cross-check invariants, and vary inputs so
hardcoded returns and input-specific special cases cannot satisfy them.""",

 'scope': """Median LOC or median files is below bar across passing runs.

Widen the family so a correct solution necessarily spans more real work. Do not
pad an existing mode -- that lifts LOC without lifting difficulty, and the
difficulty bar still has to be met.""",
}

if __name__ == '__main__':
    d, mode, report = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ''
    if mode not in GUIDE:
        print(f"  unknown remedy: {mode}"); sys.exit(2)
    brief = os.path.join(d, 'NEXT_ACTION.md')
    open(brief, 'w').write(
        f"# Remedy: {mode}\n\n## Criteria report\n\n```\n{report}\n```\n\n"
        f"## What to change\n\n{GUIDE[mode]}\n\n"
        f"## Constraints that still apply\n\n"
        f"- Every requirement must be ACHIEVABLE; an impossible one fails Fair.\n"
        f"- State WHAT and to what accuracy, never HOW.\n"
        f"- Keep the hash suffix on the hidden test filename and every symbol.\n"
        f"- No test execution in the Dockerfile.\n"
        f"- Re-verify 4-phase after any test or solution change.\n"
        f"- Prove each new failure mode discriminates: build the naive version\n"
        f"  and measure which tests it fails.\n")
    print(f"  wrote {brief}")
    print(f"  This remedy changes TASK DESIGN, which is not a text edit.")
    print(f"  Hand {brief} to a design agent, then re-run factory.sh.")
    sys.exit(0)

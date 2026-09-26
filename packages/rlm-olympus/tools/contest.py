#!/usr/bin/env python3
"""Classify which runs are CONTESTABLE.

From the platform brief: a flagged run shows a Contest button. If the evaluator's
claim is wrong -- it misjudged the task, or the failure was really environment or
infrastructure -- contesting removes the run from the criteria entirely.
"Contested runs don't count toward your criteria." Leaving a flagged run
unaddressed means it counts against you.

That is not cosmetic. A run removed from the denominator changes the pass rate:
2 passes in 6 is 33%; contest one unfair FAILURE and it becomes 2 in 5 = 40%,
which is WORSE. Contesting a flagged PASS improves it. So contesting is a
decision with a direction, not a formality.

This reads the local second-pass verdicts and reports, for each flagged run,
what contesting it would do to the numbers.

    contest.py <candidate-dir>
"""
import json, os, re, sys

def load(d):
    out = []
    for f in sorted(os.listdir(d)):
        if not (f.startswith('eval-result.') and f.endswith('.json')): continue
        rid = f[len('eval-result.'):-len('.json')]
        try: e = json.load(open(os.path.join(d, f)))
        except Exception: continue
        ea = e.get('environment_assessment', {})
        sq = e.get('details', {}).get('solution_quality', {})
        out.append({
            'rid': rid,
            'verdict': e.get('verdict', '?'),
            'passed': 'PASS' in str(e.get('verdict', '')),
            'unfair': bool(ea.get('agent_blame_unfair')),
            'blocker': ea.get('blocker_type', 'none'),
            'cheating': bool(sq.get('cheating_detected')),
            'reason': (ea.get('finding') or '')[:150],
        })
    return out

if __name__ == '__main__':
    d = sys.argv[1]
    runs = load(d)
    if not runs:
        print("  no evaluated runs — the second pass has not run"); sys.exit(0)
    total = len(runs); passes = sum(r['passed'] for r in runs)
    print(f"  as measured: {passes}/{total} = {round(passes/total*100)}%\n")
    flagged = [r for r in runs if r['unfair'] or r['blocker'] not in ('none', '', None)]
    if not flagged:
        print("  no flagged runs — nothing to contest"); sys.exit(0)
    print(f"  {len(flagged)} flagged run(s). Leaving one unaddressed counts it AGAINST you:\n")
    for r in flagged:
        t2, p2 = total - 1, passes - (1 if r['passed'] else 0)
        now = round(passes / total * 100)
        then = round(p2 / t2 * 100) if t2 else 0
        direction = ('IMPROVES' if then < now else 'WORSENS' if then > now else 'no change')
        print(f"  {r['rid']}  {r['verdict']}  blocker={r['blocker']}  unfair={r['unfair']}")
        if r['reason']: print(f"      evaluator: {r['reason']}")
        print(f"      contesting it: {now}% -> {then}% ({direction} the rate)")
        print(f"      {'CONTEST' if then <= now else 'do NOT contest — it would raise your pass rate'}\n")

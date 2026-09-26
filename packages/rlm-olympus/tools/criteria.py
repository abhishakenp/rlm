#!/usr/bin/env python3
"""Evaluate all seven Olympus submission criteria, and name the remedy.

    criteria.py <candidate-dir> [target-pct] [--action]

Exit 0 only when every criterion holds. With --action, prints the single remedy
the factory should apply, chosen from the evaluator's own verdict fields rather
than guessed.
"""
import json, os, re, sys, statistics as st

def load(d):
    # difficulty.json is only written once all N runs land, so derive from the
    # accumulated verdicts when it is absent -- otherwise partial progress reads
    # as "no measurement" and the factory picks the wrong remedy.
    dj = os.path.join(d, 'difficulty.json')
    diff = json.load(open(dj)) if os.path.exists(dj) else None
    if diff is None:
        vf = os.path.join(d, 'verdicts.txt')
        if os.path.exists(vf):
            ls = [l for l in open(vf, errors='ignore') if 'baselinePassed=' in l]
            if ls:
                p_ = sum(1 for l in ls if 'PASS_LEGITIMATE' in l)
                diff = {'runs': len(ls), 'passed': p_,
                        'rate_pct': round(p_ / len(ls) * 100)}
    evs = []
    for f in sorted(os.listdir(d)):
        if f.startswith('eval-result.') and f.endswith('.json'):
            try: evs.append(json.load(open(os.path.join(d, f))))
            except Exception: pass
    loc, fil = [], []
    vf = os.path.join(d, 'verdicts.txt')
    if os.path.exists(vf):
        for l in open(vf, errors='ignore'):
            if 'PASS_LEGITIMATE' not in l: continue
            m = re.search(r'files=(\d+)\s+addedLines=(\d+)', l)
            if m: fil.append(int(m.group(1))); loc.append(int(m.group(2)))
    return diff, evs, loc, fil

def evaluate(d, target):
    diff, evs, loc, fil = load(d)
    rows, remedies = [], []
    if not diff:
        return [('Minimum runs', False, 'no measurement')], ['SCOPE: no runs']
    runs, passed = diff['runs'], diff['passed']
    rate = diff['rate_pct']

    # Fair / No cheating come from the evaluator. With no evaluated runs there is
    # no evidence either way, and PASS on an empty set is how a broken pipeline
    # looks green.
    unfair = [e for e in evs if e.get('environment_assessment', {}).get('agent_blame_unfair')]
    cheat  = [e for e in evs if e.get('details', {}).get('solution_quality', {}).get('cheating_detected')]
    if not evs:
        rows.append(('Fair', False, 'NO EVIDENCE - no runs evaluated'))
        rows.append(('No cheating', False, 'NO EVIDENCE - no runs evaluated'))
        remedies.append('FAIRNESS: run the second pass')
    else:
        rows.append(('Fair', not unfair, f'{len(unfair)} run(s) flagged unfair/blocked'))
        rows.append(('No cheating', not cheat, f'{len(cheat)} run(s) flagged as gaming the tests'))
        if unfair: remedies.append('FAIRNESS: agents blocked by environment or missing context')
        if cheat:  remedies.append('CHEAT: tests are gameable, strengthen them')

    # The platform brief: a flagged run left unaddressed counts against you;
    # a contested one is removed from the criteria entirely.
    flagged = [e for e in evs
               if e.get('environment_assessment', {}).get('agent_blame_unfair')
               or e.get('environment_assessment', {}).get('blocker_type') not in
                  ('none', '', None)]
    if flagged:
        rows.append(('Flagged runs addressed', False,
                     f'{len(flagged)} flagged run(s) - contest or fix before submitting'))
        remedies.append('FAIRNESS: flagged runs must be contested or fixed')

    rows.append(('Solvable', passed >= 1, f'{passed} agent(s) produced a passing solution'))
    if passed == 0:
        remedies.append('SOFTEN: no agent solved it - unsolvable or unfair as written')

    rows.append(('Minimum runs', runs >= 6, f'{runs}/6'))
    if runs < 6: remedies.append('SCOPE: accumulate more runs')

    # A BAND, not a ceiling. The platform draws its own 6 runs, and BOTH edges
    # reject: >=4 passes fails Difficulty, 0 passes fails Solvable. Risk of a
    # wasted batch against the TRUE rate p:
    #     p=0.20 -> 27.9%   (26.2% of it is drawing 0/6)
    #     p=0.32 -> 18.6%   <- minimum
    #     p=0.50 -> 35.9%
    # So aiming below ~25% increases total risk, because a genuinely hard task
    # draws zero passes often enough to be rejected as unsolvable.
    LO, HI = 25, 40
    ok_diff = LO <= rate <= HI
    rows.append((f'Difficulty (band {LO}-{HI}%)', ok_diff, f'{rate}% ({passed}/{runs})'))
    if rate > HI:
        remedies.append('HARDEN: add independent failure modes')
    elif rate < LO and runs >= 6:
        remedies.append('SOFTEN: too hard - risks drawing 0/6 and failing Solvable')

    ml = int(st.median(loc)) if loc else 0
    mf = int(st.median(fil)) if fil else 0
    rows.append(('Median LOC', ml >= 150, f'{ml} effective (bar 150)'))
    rows.append(('Median files', mf >= 2, f'{mf} (bar 2)'))
    if loc and ml < 150: remedies.append('SCOPE: solutions too small, widen the family')
    if fil and mf < 2:   remedies.append('SCOPE: solutions touch too few files')
    return rows, remedies

if __name__ == '__main__':
    d = sys.argv[1]
    target = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 20
    rows, remedies = evaluate(d, target)
    if '--action' in sys.argv:
        # Difficulty is the criterion that actually kills submissions, so it wins
        # when several remedies apply.
        for pref in ('FAIRNESS', 'CHEAT', 'SOFTEN', 'HARDEN', 'SCOPE'):
            for r in remedies:
                if r.startswith(pref): print(r); sys.exit(1)
        print('NONE'); sys.exit(0)
    for name, ok, detail in rows:
        print(f"  {'PASS' if ok else 'FAIL'}  {name:<26} {detail}")
    allok = all(ok for _, ok, _ in rows)
    print(f"\n  {'SUBMITTABLE' if allok else 'NOT SUBMITTABLE'}")
    sys.exit(0 if allok else 1)

#!/usr/bin/env python3
"""Predict a candidate's frontier pass rate BEFORE spending rollouts.

Calibrated on SWE-bench Verified (500 instances) scored against a 63-system
frontier ensemble (through Claude Opus 4.5 / Gemini 3 Pro / DeepSWE-RL).
Measured cell means, mean frontier solve rate:

    files=1                 73.8%        (P(hard) 13%)
    files=2                 40.2%        (P(hard) 45%)
    files>=3                23.1%        (P(hard) 64%)
    files>=3 AND >=60 LOC    0.4%        (P(hard) 100%, n=4)

File spread x substance dominates. Causal distance ("the fix file is never
named in the problem statement") was tested and is WEAK on its own: 21.3%
P(hard) against a 18.6% base rate. It only matters in multi-site form.
"""
import json, re, sys, os

def score(sol_patch, description):
    files = re.findall(r'^diff --git a/(\S+)', sol_patch, re.M)
    files = [f for f in files if not re.search(r'_test\.|test_|\.md$', f)]
    add = len([l for l in sol_patch.split('\n')
               if l.startswith('+') and not l.startswith('+++')])
    unnamed = [f for f in files
               if os.path.basename(f).rsplit('.', 1)[0] not in description]
    n = len(files)
    # MEASURED COUNTEREXAMPLE: gojq slice-step has 6 files / +333 LOC — this
    # cell — and measured 100% over 4 leak-free rollouts. The cell described
    # contested bug fixes, not authored features whose multi-file spread is
    # mechanical. See calibration/measured.json.
    if n >= 3 and add >= 60: est, pop = 0.4, 4
    elif n >= 3:             est, pop = 23.1, 22
    elif n == 2 and add >= 60: est, pop = 33.0, 5
    elif n == 2:             est, pop = 40.2, 49
    elif add >= 60:          est, pop = 44.4, 3
    else:                    est, pop = 73.8, 429
    # Out-of-calibration guards. The calibration set is SWE-bench Verified:
    # every instance is a bug fix against a reported issue in an existing
    # subsystem. Two shapes fall outside it and MUST NOT get a pass:
    #   - additive features (pure new file, no deletions) — the population
    #     contains none, and the one such task actually measured came back at
    #     100% while this model predicted 44.4%.
    #   - thin cells (n < 10) — no statistical content.
    deletions = len([l for l in sol_patch.split('\n')
                     if l.startswith('-') and not l.startswith('---')])
    additive = deletions == 0
    oob = additive or pop < 10
    return dict(files=n, added=add, unnamed=len(unnamed), additive=additive,
                est_pass_pct=est, calib_n=pop, out_of_calibration=oob,
                file_list=files)

if __name__ == '__main__':
    d = sys.argv[1]
    sol = open(os.path.join(d, 'solution.patch')).read()
    desc = open(os.path.join(d, 'description.txt')).read()
    r = score(sol, desc)
    bar = 20 if '--live' in sys.argv else 50
    print(f"solution touches {r['files']} non-test files, +{r['added']} lines "
          f"({r['unnamed']} unnamed in the description)")
    for f in r['file_list']: print(f"    {f}")
    print(f"\npredicted frontier pass rate ~{r['est_pass_pct']}%  "
          f"(calibration cell n={r['calib_n']})")
    if r['out_of_calibration']:
        why = ("solution is purely additive (no deletions) — the calibration set "
               "is bug fixes only" if r['additive']
               else f"calibration cell has only n={r['calib_n']}")
        print(f"REFUSE  out of calibration: {why}")
        print("        this predictor cannot rank this candidate; measure it "
              "with `olympus difficulty` instead")
        sys.exit(2)
    ok = r['est_pass_pct'] <= bar
    print(f"{'PASS' if ok else 'FAIL'}  predicted rate vs the {bar}% bar")
    sys.exit(0 if ok else 1)

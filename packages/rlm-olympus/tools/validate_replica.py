#!/usr/bin/env python3
"""Measure how closely the local replicas match the platform's real output.

The platform's run exports contain BOTH the inputs to its evaluator and the
verdict its evaluator produced. That makes fidelity measurable without spending
a single platform token: feed the identical inputs to the local replica and
compare field by field.

    validate_replica.py <nova-export-dir>
"""
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evaluate_run import SYS, run_codex, schema_ok, _extract

def load(exp):
    traj = json.load(open(os.path.join(exp,'trajectory.json')))
    desc = traj['steps'][2]['message']          # step 3 is the task prompt
    diff = open(os.path.join(exp,'workspace-diff.patch'), errors='ignore').read()
    log  = open(os.path.join(exp,'test-log.txt'), errors='ignore').read()
    truth = json.load(open(os.path.join(exp,'eval-result.json')))
    return desc, diff, log, truth

def replay(exp, tag):
    desc, diff, log, truth = load(exp)
    prompt = (SYS + "\n\n---\n\n# Problem description given to the agent\n\n" + desc +
              "\n\n# The agent's final diff\n\n```diff\n" + diff[:30000] +
              "\n```\n\n# Test execution log\n\n```\n" + log[-12000:] + "\n```\n")
    got, txt = None, ''
    for attempt in range(3):
        extra = ('' if attempt == 0 else
                 "\n\nYour previous reply OMITTED required top-level objects. The JSON "
                 "MUST contain all six: summary, test_results, details, "
                 "problem_assessment, environment_assessment, verdict.")
        txt = run_codex(prompt + extra, f'val_{tag}')
        open(f'/tmp/valraw_{tag}.txt','w').write(txt)
        c = _extract(txt)
        if c is not None and schema_ok(c):
            got = c; break
        got = c
    return got, truth

FIELDS = [
    ('verdict',                    lambda d: d.get('verdict')),
    ('is_legitimate',              lambda d: d['details']['solution_quality']['is_legitimate']),
    ('cheating_detected',          lambda d: d['details']['solution_quality']['cheating_detected']),
    ('description_clear',          lambda d: d['problem_assessment']['description_clear']),
    ('tests_deterministic',        lambda d: d['problem_assessment']['tests_deterministic']),
    ('difficulty',                 lambda d: d['problem_assessment']['difficulty']),
    ('blocker_detected',           lambda d: d['environment_assessment']['blocker_detected']),
    ('agent_blame_unfair',         lambda d: d['environment_assessment']['agent_blame_unfair']),
]

if __name__ == '__main__':
    exp = sys.argv[1]; tag = os.path.basename(exp.rstrip('/')).replace(' ','_')
    got, truth = replay(exp, tag)
    if got is None:
        print(f"  {tag}: replica returned no parseable verdict"); sys.exit(2)
    agree = 0
    print(f"\n  {'field':<22}{'platform':<18}{'replica':<18}match")
    for name, f in FIELDS:
        try: t = f(truth)
        except Exception: t = '(absent)'
        try: g = f(got)
        except Exception: g = '(absent)'
        ok = (str(t).lower() == str(g).lower())
        agree += ok
        print(f"  {name:<22}{str(t):<18}{str(g):<18}{'yes' if ok else 'NO'}")
    print(f"\n  agreement: {agree}/{len(FIELDS)} fields")
    json.dump({'tag':tag,'agreement':agree,'total':len(FIELDS),
               'platform':truth,'replica':got},
              open(f'/tmp/replica_fidelity_{tag}.json','w'), indent=2)
    sys.exit(0 if agree == len(FIELDS) else 1)

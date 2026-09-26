#!/usr/bin/env python3
"""Run Olympus's own AI rubrics locally, judged by codex on a2.

The 11 files in rubrics/ are the platform's ACTUAL extracted system prompts.
This executes them — previously they were stored but never invoked, so the
factory silently skipped every AI gate.

Judging runs on a2's codex (free, and the closest available stand-in for the
platform's own grader). Generation elsewhere in the factory uses omni; only
validation gets codex.

    judge.py <candidate-dir> [--only NAME] [--jobs N]
"""
import json, os, subprocess, sys, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
RUBRICS = os.path.join(os.path.dirname(HERE), 'rubrics')

# rubric -> which candidate artifacts it needs, mirroring the platform's checks
NEEDS = {
    'categoryAlignment':       ['description.txt', 'category.txt'],
    'descriptionConciseness':  ['description.txt'],
    'problemAndTestQuality':   ['description.txt', 'test.patch'],
    'testPatchAlignment':      ['description.txt', 'test.patch'],
    # Predictor only — showing it the patch makes it parrot the real filename
    # back as a 'prediction', which then collides with itself.
    'predictableTestNames':    ['description.txt'],
    'testPatchTechnicalCheck': ['test.patch', 'test.sh'],
    'precheck_Hge':            ['test.patch'],
    'precheck_Pzt':            ['test.sh'],
    'precheck_Qge':            ['test.patch'],
    'dockerfileValidation':    ['Dockerfile'],
}
# predictableTestNames is NOT a pass/fail rubric — it asks the model to PREDICT
# the filenames an agent would naturally create. Forcing a PASS/FAIL schema onto
# it produced a spurious FAIL on a correctly-hashed filename. It gets its own
# schema, and the collision check is done here in code.
PREDICT_OUT = ('Respond with ONLY a JSON object on the final line:\n'
  '{"predicted_names":["...","..."]}\n'
  'List the test file names a developer or AI agent would naturally create. '
  'Do not judge any existing file.')

# Each platform rubric declares its OWN output contract and verdict vocabulary.
# Imposing a PASS/WARN/FAIL schema over the top destroyed per-suggestion
# priorities and the blocking rule: on a description the platform marked with a
# HIGH suggestion, the overridden replica reported severity "low". Follow the
# rubric's own contract, then normalise for gating.
NATIVE = ('\n\nFollow the Output Rules in the rubric above EXACTLY, including its own '
          'verdict vocabulary and per-suggestion priorities.\n\n'
          'Be THOROUGH. Measured against the platform on a known description, a '
          'first pass found only 2 of the 5 issues the platform reported, and rated '
          'as low-priority an item the platform rated HIGH. Under-reporting is the '
          'failure mode to avoid: work through the artifact clause by clause and '
          'emit every issue the rubric covers, up to the maximum the rubric allows. '
          'Judge each suggestion\'s priority by the rubric\'s own definition, not by '
          'how minor the edit looks.\n\n'
          'WRITE the JSON to a file named verdict.json in the current directory '
          'using the shell, and also print it as the FINAL line. The file is what '
          'gets read, so escape inner quotes properly.')

# rubric verdict -> (gate, blocking)
VERDICT_MAP = {
    'good': 'PASS', 'pass': 'PASS', 'approve': 'PASS', 'ok': 'PASS',
    'minor_suggestions': 'WARN', 'warning': 'WARN', 'warn': 'WARN',
    'request_changes': 'FAIL', 'error': 'FAIL', 'fail': 'FAIL',
}

# The platform's own dashboard shows descriptionConciseness returning
# request_changes with a HIGH suggestion, displayed as a Warning, with the
# section still passing 12/12 and the note "Only high-severity issues are
# blocking". So its request_changes is ADVISORY there, not a gate. Treating it
# as FAIL locally is stricter than the platform and would reject submittable work.
ADVISORY = {'descriptionConciseness'}

OUT = NATIVE

def artifacts(d, names):
    out = []
    for n in names:
        p = os.path.join(d, n)
        if not os.path.exists(p):
            out.append(f'### {n}\n(absent)')
        else:
            out.append(f'### {n}\n```\n{open(p,errors="ignore").read()[:24000]}\n```')
    return '\n\n'.join(out)

def run_one(d, name, path):
    tail = PREDICT_OUT if name == 'predictableTestNames' else NATIVE
    prompt = (open(path, errors='ignore').read() + '\n\n---\n\n# Artifacts under review\n\n'
              + artifacts(d, NEEDS[name]) + '\n\n---\n\n' + tail)
    # The remote work dir was keyed on the rubric alone, so every candidate
    # shared it -- and verdict.json persisted between them. A stale file made
    # sci's Dockerfile finding (a forbidden `RUN go test` line that does not
    # exist in sci2) be reported against sci2. Key on the candidate too, and
    # clear the verdict before every run.
    cid = os.path.basename(os.path.abspath(d))
    rid = f'judge_{cid}_{name}'
    for _a in range(4):
        r = subprocess.run(['ssh','-n','-o','ConnectTimeout=20','a2',
                            f'mkdir -p ~/judge/{rid} && rm -f ~/judge/{rid}/verdict.json'],
                           capture_output=True, timeout=180)
        if r.returncode == 0: break
        import time; time.sleep(5 * (_a + 1))
    import tempfile
    with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as tf:
        tf.write(prompt); tmp = tf.name
    subprocess.run(['scp','-q','-o','ConnectTimeout=20',tmp,f'a2:~/judge/{rid}/p.txt'], timeout=600)
    os.unlink(tmp)
    cmd = (f'cd ~/judge/{rid} && HOME=/home/livio/rollout/fakehome '
           f'CODEX_HOME=/home/livio/rollout/fakehome/.codex timeout 900 '
           f'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check '
           f'-c model_reasoning_effort="high" -C ~/judge/{rid} "$(cat ~/judge/{rid}/p.txt)"')
    r = subprocess.run(['ssh','-n','-o','ConnectTimeout=20','a2',cmd], capture_output=True, timeout=1200)
    txt = r.stdout.decode(errors='ignore')
    _f = subprocess.run(['ssh','-n','-o','ConnectTimeout=20','a2',
                         f'cat ~/judge/{rid}/verdict.json 2>/dev/null'],
                        capture_output=True, timeout=180).stdout.decode(errors='ignore').strip()
    if _f: txt = _f + "\n" + txt
    # Platform rubrics use TWO different output schemas. The quality rubrics
    # return {"verdict": ...}; the precheck rubrics return per-check objects
    # {"check_1": {"status": "OK"|"WARNING"|"ERROR"}, "all_issues": ...}.
    # Scanning only for "verdict" scored five perfectly good precheck replies as
    # failures.
    verdict = None
    if name == 'predictableTestNames': keys = ('"predicted_names"',)
    else:                              keys = ('"verdict"', '"status"', '"all_issues"')
    for line in reversed(txt.strip().split('\n')):
        line = line.strip()
        if line.startswith('{') and any(k in line for k in keys):
            try: verdict = json.loads(line); break
            except json.JSONDecodeError: pass
    if verdict is None:
        for m in __import__('re').finditer(r'(\{(?:[^{}]|\{[^{}]*\})*\})', txt, 0):
            if any(k in m.group(1) for k in keys):
                try: verdict = json.loads(m.group(1))
                except json.JSONDecodeError: pass
    # normalise the per-check schema into the same shape as the verdict schema
    if verdict is not None and 'verdict' not in verdict:
        checks = {k: v for k, v in verdict.items()
                  if isinstance(v, dict) and 'status' in v}
        if checks:
            st = [str(v['status']).upper() for v in checks.values()]
            verdict = {'verdict': 'error' if 'ERROR' in st
                                  else 'warning' if 'WARNING' in st else 'pass',
                       'suggestions': [{'priority': 'high' if str(v['status']).upper()=='ERROR'
                                        else 'medium', 'suggestion': v.get('explanation','')}
                                       for v in checks.values()
                                       if str(v['status']).upper() != 'OK'],
                       'checks': len(checks)}
    if verdict is None:                      # fenced block fallback
        import re as _r
        m = _r.search(r'```(?:json)?\s*(\{.*?\})\s*```', txt, _r.S)
        if m:
            try: verdict = json.loads(m.group(1))
            except json.JSONDecodeError: pass
    if verdict is not None and name != 'predictableTestNames':
        raw = str(verdict.get('verdict','')).lower()
        sugg = verdict.get('suggestions') or verdict.get('issues') or []
        prios = [str((x or {}).get('priority','')).lower()
                 for x in sugg if isinstance(x, dict)]
        verdict['native_verdict'] = raw
        verdict['verdict'] = VERDICT_MAP.get(raw, 'FAIL' if raw else 'ERROR')
        if name in ADVISORY and verdict['verdict'] == 'FAIL':
            verdict['verdict'] = 'WARN'
            verdict['advisory'] = 'request_changes here is advisory on the platform'
        verdict['severity'] = ('high' if 'high' in prios else
                               'medium' if 'medium' in prios else
                               'low' if prios else verdict.get('severity','none'))
        verdict['issues'] = [
            f"[{str(x.get('priority','?')).upper()}] {x.get('suggestion') or x.get('quote','')}"
            if isinstance(x, dict) else str(x) for x in sugg]
        # A third shape: {"verdict": ..., "checks": {...}, "all_issues": [...]}.
        # dockerfileValidation reported FAIL with an empty issue list because the
        # findings live in all_issues, which nothing was reading.
        if not verdict['issues']:
            ai = verdict.get('all_issues')
            if isinstance(ai, list): verdict['issues'] = [str(x) for x in ai]
            elif isinstance(ai, str) and ai.strip(): verdict['issues'] = [ai]
            ch = verdict.get('checks')
            if not verdict['issues'] and isinstance(ch, dict):
                verdict['issues'] = [f"{k}: {v.get('explanation','')}"
                                     for k, v in ch.items()
                                     if isinstance(v, dict)
                                     and str(v.get('status','')).upper() != 'OK']
    if name == 'predictableTestNames' and verdict is not None:
        # Collision check in code: our hashed filename must not be among the
        # names an agent would naturally pick.
        import glob as _g
        ours = {os.path.basename(f) for f in _g.glob(os.path.join(d, '*'))}
        patch = open(os.path.join(d, 'test.patch'), errors='ignore').read()
        import re as _re
        ours |= set(_re.findall(r'^diff --git a/\S+ b/(\S+)', patch, _re.M))
        ours = {os.path.basename(o) for o in ours}
        pred = {os.path.basename(n) for n in verdict.get('predicted_names', [])}
        hit = sorted(ours & pred)
        verdict = {'verdict': 'FAIL' if hit else 'PASS',
                   'severity': 'high' if hit else 'none',
                   'issues': ([f'test filename collides with a predictable name: {h}' for h in hit]
                              or [f'no collision against {len(pred)} predicted names']),
                   'predicted': sorted(pred)[:8]}
    if verdict is None:
        # An unreachable a2 is NOT a quality finding. Marking it one caused a
        # candidate to be filed as "platform rubric FAIL" when the real cause
        # was `ssh mkdir` timing out during a host outage.
        # Three distinct causes, previously collapsed into one misleading
        # message. A trivial prompt passes on scraps of allowance while a real
        # 5-6KB rubric prompt does not, so "quota" is the usual cause, not
        # "unreachable".
        if 'usage limit' in txt:
            reason, kind = 'a2 codex quota exhausted for prompts this size', 'INFRA'
        elif (not txt.strip()) or 'timed out' in txt or 'Connection refused' in txt:
            reason, kind = 'a2 unreachable or ssh timed out', 'INFRA'
        else:
            reason, kind = 'no JSON verdict returned', 'ERROR'
        verdict = {'verdict': kind, 'severity': 'none', 'issues': [f'judge could not run ({reason})']}
    return name, verdict, txt

if __name__ == '__main__':
    d = sys.argv[1]
    only = sys.argv[sys.argv.index('--only')+1] if '--only' in sys.argv else None
    jobs = int(sys.argv[sys.argv.index('--jobs')+1]) if '--jobs' in sys.argv else 5
    todo = []
    for name in NEEDS:
        p = os.path.join(RUBRICS, name + '.sys.txt')
        if not os.path.exists(p): p = os.path.join(RUBRICS, name + '.txt')
        if not os.path.exists(p): continue
        if only and only != name: continue
        todo.append((name, p))
    print(f"running {len(todo)} platform rubrics on a2 codex ({jobs} at a time)\n")
    results = {}
    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = [ex.submit(run_one, d, n, p) for n, p in todo]
        for f in cf.as_completed(futs):
            name, v, raw = f.result()
            results[name] = v
            mark = {'PASS': 'PASS', 'WARN': 'WARN', 'FAIL': 'FAIL'}.get(v['verdict'], '????')
            print(f"  {mark}  {name}  [{v.get('severity','?')}]")
            for i in (v.get('issues') or [])[:3]:
                print(f"          - {str(i)[:150]}")
            open(os.path.join(d, f'judge.{name}.log'), 'w').write(raw)
    json.dump(results, open(os.path.join(d, 'judge.json'), 'w'), indent=2)
    infra = [n for n, v in results.items() if v['verdict'] == 'INFRA']
    bad = [n for n, v in results.items() if v['verdict'] in ('FAIL', 'ERROR')]
    if infra:
        print(f"\nCOULD NOT EVALUATE {len(infra)} rubric(s): {', '.join(infra)}")
        why = {(results[n]['issues'] or [''])[0] for n in infra}
        for w in sorted(why): print(f"  cause: {w}")
        print("This is NOT a verdict on the candidate.")
        sys.exit(3)          # distinct from 1 so callers do not reject
    print(f"\n{len(results)-len(bad)}/{len(results)} rubrics clean")
    print("BLOCKED: " + ', '.join(bad) if bad else "all platform rubrics pass")
    sys.exit(1 if bad else 0)

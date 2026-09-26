#!/usr/bin/env python3
"""Fast structural lint with ACTIONABLE repair instructions.

Runs in milliseconds, before any docker work. Exists because coarse gate output
("base passes without solution FAIL") tells a generator nothing it can act on,
while a small model's failures are almost entirely mechanical: unprefixed hunk
bodies, em-dashes, predictable test filenames. Precise errors are the difference
between a model that can self-repair and one that cannot.
"""
import json, os, re, subprocess, sys

def lint(d):
    errs = []
    def need(f):
        p = os.path.join(d, f)
        return open(p, errors='ignore').read() if os.path.exists(p) else None

    for f in ('description.txt','category.txt','repo.txt','commit.txt',
              'image.txt','Dockerfile','test.patch','solution.patch','meta.json'):
        if need(f) is None: errs.append(f"MISSING FILE: {f} — the contract requires it.")

    desc = need('description.txt') or ''
    if desc:
        w = len(desc.split())
        # Platform raw output: {"target":500,"warningThreshold":500,"errorThreshold":1000}
        # and a 380-word description PASSED with "Word count: 380/500". The
        # "100-200 words" in the UI label is advisory, not the gate.
        if w >= 1000:
            errs.append(f"DESCRIPTION LENGTH: {w} words exceeds the platform's 1000-word error threshold.")
        elif w >= 500:
            print(f"  note: {w} words is over the 500 warning threshold (error at 1000)", file=sys.stderr)
        elif w < 60:
            errs.append(f"DESCRIPTION LENGTH: {w} words is too short to specify a contract.")
        if re.search(r'^\s*[-*#]|```', desc, re.M):
            errs.append("DESCRIPTION FORMAT: no headings, bullets or code fences. "
                        "Write flowing maintainer-issue prose.")

    for pf in ('test.patch','solution.patch'):
        p = need(pf)
        if not p: continue
        if 'diff --git' not in p:
            errs.append(f"{pf}: missing `diff --git` header. Must be a real unified diff.")
        # the classic small-model failure: hunk bodies emitted without +/-/space
        bad, inhunk = [], False
        for line in p.split('\n'):
            if line.startswith('@@'): inhunk = True; continue
            if line.startswith(('diff --git','--- ','+++ ','index ','new file','deleted file')):
                inhunk = False; continue
            if inhunk and line and line[0] not in '+- \\':
                bad.append(line[:60])
        if bad:
            errs.append(f"{pf}: {len(bad)} hunk lines lack a leading '+', '-' or ' '. "
                        f"EVERY line inside a @@ hunk must start with one of those. "
                        f"First offenders: {bad[:3]}. This makes `git apply` fail with "
                        f"'corrupt patch'.")
        for m in re.finditer(r'^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@', p, re.M):
            pass

    tp = need('test.patch') or ''
    names = re.findall(r'^\+\+\+ b/(\S+)', tp, re.M)
    # test.sh is the mandated harness filename, not a hidden test file
    tests = [n for n in names if re.search(r'test', n, re.I)
             and os.path.basename(n) != 'test.sh']
    for n in tests:
        base = os.path.basename(n)
        if not re.search(r'[0-9a-f]{6}', base):
            errs.append(f"PREDICTABLE TEST FILENAME: {base}. Contract rule 1 requires a "
                        f"random 6-hex-char suffix (openssl rand -hex 3), e.g. "
                        f"{base.rsplit('.',1)[0]}_a3f9b2.{base.rsplit('.',1)[-1]}. "
                        f"Every symbol the file defines needs the same suffix too.")
    if tests and 'test.sh' not in ' '.join(names):
        errs.append("test.patch must ALSO add test.sh (with --output_path and base|new modes).")
    mp = os.path.join(d,'meta.json')
    if os.path.exists(mp):
        try: mrepo = json.load(open(mp)).get('repo','')
        except Exception: mrepo = ''
        if mrepo.startswith('http'):
            errs.append("meta.json 'repo' must be a LOCAL path to a pristine clone "
                        "(e.g. /tmp/foo_pristine), not a URL. The URL belongs in repo.txt.")
        elif mrepo and not os.path.isdir(mrepo):
            errs.append(f"meta.json 'repo' points at {mrepo} which does not exist.")
    df = need('Dockerfile') or ''
    if df and 'python' in df.lower() and not re.search(r'pip install\s+(-e|--editable)', df):
        if 'test invocation' not in df.lower():
            errs.append("Python image: the platform requires installs to be editable "
                        "(pip install -e .) or the test invocation to be documented.")
    if 'base_tests.txt' not in (need('Dockerfile') or ''):
        errs.append("Dockerfile: missing the manifest line. Add, BEFORE CMD: "
                    "RUN find . -type f -name '*_test.go' | sort > .base_tests.txt")

    for f in ('description.txt','test.patch','solution.patch'):
        t = need(f) or ''
        for m in re.findall(r'\b(shipd|olympus|datacurve|quest|challenge|mars)\b', t, re.I):
            errs.append(f"BANNED MARKER '{m}' in {f} — remove it.")
    return errs

if __name__ == '__main__':
    d = sys.argv[1]
    e = lint(d)
    if not e:
        print("structural lint: clean"); sys.exit(0)
    print(f"structural lint: {len(e)} problem(s) — fix ALL of these:\n")
    for i, x in enumerate(e, 1): print(f"{i}. {x}\n")
    sys.exit(1)

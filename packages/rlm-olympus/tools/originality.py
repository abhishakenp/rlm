#!/usr/bin/env python3
"""Dashboard gates: "Problem is not plagiarized" + "Plagiarism Review".

HONEST SCOPE LIMIT: the platform compares against its own private corpus of
other users' submissions. That corpus is unobtainable, so THAT half can never be
replicated locally and this tool does not pretend to.

What it does replicate is the half that is checkable: whether the functionality
already exists in the target repo, or was already proposed/implemented in any
PR, issue or discussion. That is the #1 rejection cause per the playbook, and it
is exactly what the RLM track missed when it proposed re-implementing a function
that already existed at quartile.go:13.
"""
import json, os, re, subprocess, sys

def sh(a, **k):
    return subprocess.run(a, capture_output=True, text=True, timeout=120, **k).stdout

def symbols(d):
    """Symbols the task genuinely ADDS.

    Sourced from what solution.patch DEFINES, not from prose and not from what
    the tests call. Both of those produced false positives: descriptions mention
    existing siblings for contrast ("unlike the existing Stats"), and hidden
    tests call pre-existing functions to cross-check against. Only a definition
    added by the solution is new functionality, so only that can be a duplicate.
    """
    sp = os.path.join(d, 'solution.patch')
    if not os.path.exists(sp): return []
    t = open(sp, errors='ignore').read()
    added = '\n'.join(l[1:] for l in t.split('\n')
                       if l.startswith('+') and not l.startswith('+++'))
    # TOP-LEVEL definitions only. A method on a NEW type is not a duplicate even
    # when an existing type has a method of the same name -- flagging those made
    # `describe`, `clear_cache`, `CDF` and `Prob` look like collisions when they
    # are ordinary members of the new API.
    out = set()
    out |= set(re.findall(r'^func\s+([A-Z][A-Za-z0-9_]*)', added, re.M))   # no receiver
    newtypes = set(re.findall(r'^type\s+([A-Z][A-Za-z0-9_]*)', added, re.M))
    out |= newtypes
    # Methods on a NEW type are not duplicates, but methods added to an EXISTING
    # type are new public API and can collide. A candidate adding
    # `func (c *Context) Erf` to a pre-existing Context was reported as
    # "(none detected)" and skipped the check entirely.
    for recv, meth in re.findall(r'^func\s+\(\s*\w+\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([A-Z][A-Za-z0-9_]*)',
                                 added, re.M):
        if recv not in newtypes:
            out.add(meth)
    out |= set(re.findall(r'^(?:class|def)\s+([A-Za-z_][A-Za-z0-9_]*)', added, re.M))
    out |= set(re.findall(r'^(?:export\s+)?(?:function|class|const)\s+([A-Za-z_][A-Za-z0-9_]*)', added, re.M))
    out |= set(re.findall(r'^(?:pub\s+)?fn\s+([a-z_][A-Za-z0-9_]*)', added, re.M))
    out = {x for x in out if not x.startswith(('Test','Benchmark','Fuzz','Example','_'))}
    return sorted(out)

def check(d):
    url = open(os.path.join(d,'repo.txt')).read().strip()
    repo = re.sub(r'^https?://github\.com/','',url).rstrip('/').removesuffix('.git')
    rp = json.load(open(os.path.join(d,'meta.json'))).get('repo')
    # meta.repo must be a LOCAL pristine clone. One generator wrote the URL there,
    # which silently made the repo-existence grep search nothing and pass.
    if not (rp and os.path.isdir(rp)):
        commit = open(os.path.join(d,'commit.txt')).read().strip()
        rp = f"/tmp/orig_{repo.replace('/','_')}_{commit[:8]}"
        if not os.path.isdir(rp):
            subprocess.run(['git','clone','-q',f'https://github.com/{repo}',rp], timeout=600)
            subprocess.run(['git','checkout','-q',commit], cwd=rp, timeout=120)
        print(f"    (meta.repo was not a local clone; checked out {commit[:8]} to verify)")
    syms = symbols(d)
    errs, notes = [], [f"symbols asked for: {', '.join(syms) or '(none detected)'}"]

    # 1. does it ALREADY exist in the pinned tree?
    if rp and os.path.isdir(rp):
        for s in syms:
            hits = sh(['grep','-rn','--include=*.go','--include=*.py','--include=*.ts',
                       '--include=*.rs','-E', rf'^\s*(func|def|class|export function|pub fn)\s+{s}\b', rp])
            hits = [h for h in hits.split('\n') if h and '_test' not in h]
            if hits:
                errs.append(f"{s} ALREADY EXISTS in the repo: {hits[0].replace(rp+'/','')}")
    # 2. already proposed or implemented upstream?
    for s in syms[:6]:
        out = sh(['gh','search','prs','--repo',repo,s,'--state','all','--limit','3',
                  '--json','title,url,state'])
        try: rows = json.loads(out or '[]')
        except json.JSONDecodeError: rows = []
        for r in rows:
            errs.append(f"PR mentions {s}: [{r.get('state')}] {r.get('title','')[:70]} {r.get('url','')}")
        out = sh(['gh','search','issues','--repo',repo,s,'--state','all','--limit','3',
                  '--json','title,url,state'])
        try: rows = json.loads(out or '[]')
        except json.JSONDecodeError: rows = []
        for r in rows:
            notes.append(f"issue mentions {s}: [{r.get('state')}] {r.get('title','')[:60]}")
    return errs, notes

if __name__ == '__main__':
    d = sys.argv[1]
    errs, notes = check(d)
    for n in notes: print(f"    {n}")
    print("    NOTE: the platform's private cross-submission corpus cannot be checked locally.")
    if errs:
        print("  FAIL  originality")
        for e in errs: print(f"        - {e}")
        sys.exit(1)
    print("  PASS  originality (not present in repo; no PR/issue implements it)")

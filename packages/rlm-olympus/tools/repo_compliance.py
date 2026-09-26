#!/usr/bin/env python3
"""Dashboard gate: "Repository meets compliance requirements
(500+ stars, permissive license, active maintenance)".

GitHub's licenseInfo is unreliable — it reports "other" for repos that are
plainly BSD-3 or Apache-2.0, and also for GPL ones, which are disqualifying.
So the LICENSE file itself is read and classified.
"""
import json, re, subprocess, sys, os, datetime as dt

PERMISSIVE = [('MIT', r'\bMIT License\b|Permission is hereby granted, free of charge'),
              ('Apache-2.0', r'Apache License\s*\n?\s*Version 2\.0'),
              ('BSD-3', r'Redistribution and use in source and binary forms.*'
                        r'(?:names? of (?:the )?(?:contributors|copyright holder))'),
              ('BSD-2', r'Redistribution and use in source and binary forms'),
              ('ISC', r'\bISC License\b')]
COPYLEFT = [('GPL', r'GNU GENERAL PUBLIC LICENSE'), ('AGPL', r'GNU AFFERO'),
            ('LGPL', r'GNU LESSER GENERAL PUBLIC')]

def gh(repo):
    r = subprocess.run(['gh','repo','view',repo,'--json',
                        'stargazerCount,licenseInfo,pushedAt,primaryLanguage'],
                       capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 else None

def check(url, repo_path=None):
    repo = re.sub(r'^https?://github\.com/','',url.strip()).rstrip('/').removesuffix('.git')
    errs, notes = [], []
    d = gh(repo)
    if not d: return [f"could not query {repo} via gh"], []
    stars = d.get('stargazerCount', 0)
    notes.append(f"stars: {stars}")
    if stars < 500: errs.append(f"stars {stars} < 500")
    pushed = d.get('pushedAt','')
    if pushed:
        age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(pushed.replace('Z','+00:00'))).days
        notes.append(f"last push: {age} days ago")
        if age > 365: errs.append(f"inactive: last push {age} days ago (>365)")
    lang = (d.get('primaryLanguage') or {}).get('name','?')
    notes.append(f"language: {lang}")
    if lang not in ('Go','Python','TypeScript','JavaScript','Rust','C++','Java'):
        errs.append(f"language {lang} not supported by the platform")
    # read the LICENSE file itself, never trust the API field
    txt = None
    if repo_path:
        for n in ('LICENSE','LICENSE.txt','LICENSE.md','COPYING'):
            p = os.path.join(repo_path, n)
            if os.path.exists(p): txt = open(p, errors='ignore').read(); break
    if txt is None:
        r = subprocess.run(['gh','api',f'repos/{repo}/license','--jq','.content'],
                           capture_output=True, text=True)
        if r.returncode == 0:
            import base64
            try: txt = base64.b64decode(r.stdout.strip()).decode('utf-8','ignore')
            except Exception: txt = None
    if txt is None:
        errs.append("could not read the LICENSE file")
    else:
        cl = next((n for n,p in COPYLEFT if re.search(p, txt, re.I)), None)
        pm = next((n for n,p in PERMISSIVE if re.search(p, txt, re.I|re.S)), None)
        if cl: errs.append(f"LICENSE is {cl} — copyleft, disqualified")
        elif pm: notes.append(f"license (read from file): {pm}")
        else: errs.append(f"LICENSE not recognised as permissive "
                          f"(API says {(d.get('licenseInfo') or {}).get('key','?')})")
    return errs, notes

if __name__ == '__main__':
    d = sys.argv[1]
    url = open(os.path.join(d,'repo.txt')).read().strip()
    rp = None
    mp = os.path.join(d,'meta.json')
    if os.path.exists(mp): rp = json.load(open(mp)).get('repo')
    errs, notes = check(url, rp)
    for n in notes: print(f"    {n}")
    if errs:
        print("  FAIL  repository compliance")
        for e in errs: print(f"        - {e}")
        sys.exit(1)
    print("  PASS  repository compliance (500+ stars, permissive license, active)")

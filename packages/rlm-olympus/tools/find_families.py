#!/usr/bin/env python3
"""Find parallel-implementation families in a repo.

Measured on SWE-bench Verified: of the 14 hardest multi-file instances, nearly
all are ONE rule that must land consistently across N sibling implementations of
a single abstraction — N printers (sympy-14248), N database backends
(django-15629), N middleware (django-13344), N language domains (sphinx-7590),
N set handlers (sympy-20438). Agents patch two of four and fail.

A family here = a directory where >=3 files each define the same >=2 symbols.
Changing the shared contract forces every sibling to change with it, which is
the 3+-file / 23.1%-solve-rate cell.

    find_families.py <repo-dir> [--min-siblings 3]
"""
import os, re, sys, collections

DEFS = {
    '.py':  re.compile(r'^\s*(?:def|class)\s+([A-Za-z_]\w*)', re.M),
    '.go':  re.compile(r'^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)', re.M),
    '.ts':  re.compile(r'^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_]\w*)', re.M),
    '.rs':  re.compile(r'^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)', re.M),
    '.java':re.compile(r'^\s*(?:public|private|protected).*?\s(\w+)\s*\(', re.M),
}
SKIP = re.compile(r'(^|/)(\.git|node_modules|vendor|testdata|third_party|dist|build)(/|$)')

def scan(root, min_sib):
    bydir = collections.defaultdict(dict)
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if not SKIP.search(os.path.join(dp, d))]
        if SKIP.search(dp): continue
        for fn in fns:
            ext = os.path.splitext(fn)[1]
            if ext not in DEFS or 'test' in fn: continue
            p = os.path.join(dp, fn)
            try: src = open(p, encoding='utf-8', errors='ignore').read()
            except OSError: continue
            names = set(DEFS[ext].findall(src))
            if len(names) >= 2:
                bydir[dp][fn] = names
    fams = []
    for d, files in bydir.items():
        if len(files) < min_sib: continue
        cnt = collections.Counter(n for names in files.values() for n in names)
        # symbols implemented by at least min_sib siblings = the shared contract
        shared = {n for n, c in cnt.items() if c >= min_sib}
        if len(shared) < 2: continue
        members = [f for f, names in files.items() if len(names & shared) >= 2]
        if len(members) < min_sib: continue
        fams.append((len(members), len(shared), os.path.relpath(d, root),
                     sorted(members)[:6], sorted(shared)[:6]))
    return sorted(fams, reverse=True)

if __name__ == '__main__':
    root = sys.argv[1]
    ms = int(sys.argv[sys.argv.index('--min-siblings')+1]) if '--min-siblings' in sys.argv else 3
    fams = scan(root, ms)
    if not fams:
        print("no parallel-implementation families found — "
              "this repo is a poor Olympus candidate")
        sys.exit(1)
    print(f"{len(fams)} parallel-implementation families "
          f"(>= {ms} siblings sharing >= 2 symbols)\n")
    for nm, ns, d, members, shared in fams[:12]:
        print(f"  {nm:2d} siblings x {ns:3d} shared symbols   {d or '.'}")
        print(f"      siblings: {', '.join(members)}")
        print(f"      contract: {', '.join(shared)}")

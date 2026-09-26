#!/usr/bin/env python3
"""Detect stale runs, the way the platform shows "2 stale batches (4 runs)".

Runs measure the artifacts as they were WHEN THE RUN HAPPENED. Edit the
description, test patch or Dockerfile afterwards and those runs describe a task
that no longer exists — the platform marks the batch stale and it stops counting.

This fingerprints the artifacts that define the task and stores the digest
alongside the verdicts, so a changed candidate cannot silently reuse old runs.
A 4-run 50% measurement was nearly carried across a test-suite rewrite here;
that is the exact failure this prevents.

    staleness.py <candidate-dir> [--stamp]
"""
import hashlib, json, os, sys

# Files that DEFINE the task. solution.patch is deliberately excluded: it is a
# local solvability proof and is never submitted, so changing it cannot stale a
# run.
DEFINING = ('description.txt', 'test.patch', 'Dockerfile', 'category.txt',
            'repo.txt', 'commit.txt')

def fingerprint(d):
    h = hashlib.sha256()
    for f in DEFINING:
        p = os.path.join(d, f)
        h.update(f.encode())
        h.update(open(p, 'rb').read() if os.path.exists(p) else b'<absent>')
    return h.hexdigest()[:16]

if __name__ == '__main__':
    d = sys.argv[1]
    stamp = os.path.join(d, '.task_fingerprint')
    cur = fingerprint(d)
    if '--stamp' in sys.argv:
        open(stamp, 'w').write(cur); print(f"  stamped {cur}"); sys.exit(0)
    if not os.path.exists(stamp):
        print(f"  no fingerprint recorded; current {cur}")
        sys.exit(0 if not os.path.exists(os.path.join(d, 'verdicts.txt')) else 1)
    old = open(stamp).read().strip()
    n = 0
    vf = os.path.join(d, 'verdicts.txt')
    if os.path.exists(vf):
        n = sum(1 for l in open(vf, errors='ignore') if 'baselinePassed=' in l)
    if old == cur:
        print(f"  fingerprint {cur} unchanged — {n} run(s) still valid"); sys.exit(0)
    print(f"  STALE: task changed since those runs ({old} -> {cur})")
    print(f"  {n} accumulated run(s) measure a task that no longer exists")
    sys.exit(1)

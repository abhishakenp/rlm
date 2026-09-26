#!/usr/bin/env python3
"""Count EFFECTIVE solution lines from a unified diff on stdin.

The platform: "what counts is the effective solution -- the lines an agent has
to actually write to implement the task and pass the tests. Blank lines,
comments, and padding are excluded, and test code doesn't count at all."
"""
import re, sys

TEST = re.compile(r'_test\.(go|py|ts|js|rs|java)$|(^|/)test\.sh$|(^|/)test_[^/]*\.py$'
                  r'|\.test\.[jt]sx?$|base_tests|(^|/)\._')
COMMENT = ('//', '/*', '*/', '*', '#', '--')

def main():
    cur, eff = None, 0
    for line in sys.stdin:
        if line.startswith('diff --git'):
            cur = line.rstrip().split(' b/')[-1]
            continue
        if not line.startswith('+') or line.startswith('+++') or cur is None:
            continue
        body = line[1:].strip()
        if not body:                     continue   # blank
        if TEST.search(cur):             continue   # test code never counts
        if body.startswith(COMMENT):     continue   # comment
        eff += 1
    print(eff)

main()

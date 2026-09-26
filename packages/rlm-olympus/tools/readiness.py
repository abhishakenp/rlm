#!/usr/bin/env python3
"""Quantify the risk of submitting, from locally measured runs.

You cannot be 100% sure. What you CAN do is bound the risk and decide against a
number instead of a feeling.

The platform draws its own 6 runs. Even a genuinely hard task can draw badly.
Given k passes in n local runs, the posterior over the true pass rate p is
Beta(k+1, n-k+1) (uniform prior), and the chance the platform's 6-run batch
shows >=4 passes -- failing Difficulty -- is the posterior-weighted binomial
tail. That is the number that decides whether 33 tokens are worth spending.

    readiness.py <candidate-dir>
"""
import json, math, os, re, sys

def beta_pdf(p, a, b):
    return (p ** (a - 1)) * ((1 - p) ** (b - 1))

def risk_fail_difficulty(k, n, platform_runs=6, max_pass=3, steps=2000):
    """P(platform draws > max_pass passes in platform_runs), integrating over p."""
    a, b = k + 1, n - k + 1
    num = den = 0.0
    for i in range(1, steps):
        p = i / steps
        w = beta_pdf(p, a, b)
        tail = sum(math.comb(platform_runs, j) * p**j * (1-p)**(platform_runs-j)
                   for j in range(max_pass + 1, platform_runs + 1))
        num += w * tail; den += w
    return num / den

def risk_zero(k, n, platform_runs=6, steps=2000):
    """P(platform draws 0 passes) -- fails Solvable, rejected the same way."""
    a, b = k + 1, n - k + 1
    num = den = 0.0
    for i in range(1, steps):
        p = i / steps
        w = beta_pdf(p, a, b)
        num += w * (1 - p) ** platform_runs; den += w
    return num / den

if __name__ == '__main__':
    d = sys.argv[1]
    vf = os.path.join(d, 'verdicts.txt')
    if not os.path.exists(vf):
        print("  no runs measured — readiness cannot be assessed"); sys.exit(1)
    lines = [l for l in open(vf, errors='ignore') if 'baselinePassed=' in l]
    n = len(lines); k = sum(1 for l in lines if 'PASS_LEGITIMATE' in l)
    if n == 0:
        print("  no valid runs"); sys.exit(1)
    rd = risk_fail_difficulty(k, n)
    rz = risk_zero(k, n)
    print(f"  local measurement: {k} passes in {n} runs ({round(k/n*100)}%)\n")
    print(f"  P(platform batch shows >=4/6, FAILS Difficulty) : {rd*100:5.1f}%")
    print(f"  P(platform batch shows  0/6, FAILS Solvable)    : {rz*100:5.1f}%")
    print(f"  P(batch is wasted, either way)                  : {(rd+rz)*100:5.1f}%\n")
    for label, kk, nn in (("  if 0 passes in 6 local", 0, 6),
                          ("  if 1 pass  in 6 local", 1, 6),
                          ("  if 2 passes in 6 local", 2, 6),
                          ("  if 3 passes in 6 local", 3, 6)):
        print(f"{label}: fail-risk {(risk_fail_difficulty(kk,nn)+risk_zero(kk,nn))*100:5.1f}%")
    print(f"\n  cost of a wasted batch: 33 tokens of {54.5} available")

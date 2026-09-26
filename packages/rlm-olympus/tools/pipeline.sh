#!/usr/bin/env bash
# The full Olympus check pipeline, replicated locally. Mirrors the platform
# dashboard section for section. Costs zero platform tokens.
#   pipeline.sh <candidate-dir> [runs]
set -uo pipefail
d="$(cd "${1:?candidate dir}" && pwd)"; runs="${2:-6}"
T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0; warn=0
sec(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
res(){ if [ "$1" = 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); fi; }

sec "GitHub Repository"
python3 "$T/repo_compliance.py" "$d"; res $?

sec "Problem Description & Tests"
python3 "$T/lint_candidate.py" "$d" >/tmp/pl.txt 2>&1
if [ $? = 0 ]; then echo "  PASS  structural + deterministic checks"; pass=$((pass+1))
else echo "  FAIL  structural checks"; sed 's/^/        /' /tmp/pl.txt; fail=$((fail+1)); fi
( cd "$d" && python3 "$T/det_checks.py" >/tmp/pd.txt 2>&1 )
if grep -q "ALL PASS" /tmp/pd.txt; then echo "  PASS  length / AI-tells / UTF-8 / markers"; pass=$((pass+1))
else echo "  FAIL  deterministic"; grep '^FAIL' /tmp/pd.txt | sed 's/^/        /'; fail=$((fail+1)); fi

sec "Plagiarism Review"
python3 "$T/originality.py" "$d"; res $?

sec "Dockerfile + Build"
grep -qE '^FROM public\.ecr\.aws/(d3j8x8q7/olympus-base|x8v8d7g8/mars-base)' "$d/Dockerfile" \
  && grep -q 'WORKDIR /app' "$d/Dockerfile" \
  && { echo "  PASS  base image and WORKDIR"; pass=$((pass+1)); } \
  || { echo "  FAIL  base image / WORKDIR"; fail=$((fail+1)); }

sec "Verify Tests (4-phase)"
bash "$T/run_gates.sh" "$d" 2>&1 | grep -E '^\s+(PASS|FAIL)' | sed 's/^ */  /'
bash "$T/run_gates.sh" "$d" >/dev/null 2>&1; res $?

sec "Test Quality / Task Quality / Description Quality (platform rubrics)"
python3 "$T/judge.py" "$d" --jobs 4 2>&1 | grep -E '^\s+(PASS|WARN|FAIL|\?\?\?\?)' | sed 's/^ */  /'
[ -f "$d/judge.json" ] && python3 -c "
import json;j=json.load(open('$d/judge.json'))
bad=[k for k,v in j.items() if v['verdict'] in ('FAIL','ERROR')]
w=[k for k,v in j.items() if v['verdict']=='WARN']
print(f'  {len(j)-len(bad)}/{len(j)} rubrics clean' + (f'  ({len(w)} warn)' if w else ''))
raise SystemExit(1 if bad else 0)"; res $?

sec "Agent Rollouts (Nova solver parity)"
rm -f "$d/verdicts.txt" "$d/difficulty.json"
bash "$T/difficulty.sh" "$d" "$runs" 2>&1 | tail -$((runs+2)) | sed 's/^/  /'

sec "Second pass — Nova evaluator"
if [ -f "$d/verdicts.txt" ]; then
  for rid in $(grep -oE '^\s*\S+:' "$d/verdicts.txt" | tr -d ' :'); do
    python3 "$T/evaluate_run.py" "$d" "$rid" 2>&1 | sed 's/^/  /'
  done
else echo "  (no runs to evaluate)"; fi

sec "Submission criteria"
python3 - "$d" "$runs" <<'PY'
import json,os,re,sys,statistics as st
d,runs=sys.argv[1],int(sys.argv[2])
dj=os.path.join(d,'difficulty.json')
if not os.path.exists(dj): print("  no measurement"); raise SystemExit(1)
j=json.load(open(dj)); rate=j['rate_pct']
evs=[json.load(open(os.path.join(d,f))) for f in os.listdir(d) if f.startswith('eval-result.')]
cheat=[e for e in evs if e.get('details',{}).get('solution_quality',{}).get('cheating_detected')]
unfair=[e for e in evs if e.get('environment_assessment',{}).get('agent_blame_unfair')]
loc,fil=[],[]
for l in open(os.path.join(d,'verdicts.txt'),errors='ignore'):
    if 'PASS_LEGITIMATE' not in l: continue
    m=re.search(r'files=(\d+)\s+addedLines=(\d+)',l)
    if m: fil.append(int(m.group(1))); loc.append(int(m.group(2)))
ml=int(st.median(loc)) if loc else 0; mf=int(st.median(fil)) if fil else 0
def row(ok,name,val): print(f"  {'PASS' if ok else 'FAIL'}  {name:<16} {val}")
# Fair and No-cheating are judged BY the evaluator. With no evaluated runs there
# is no evidence either way, and reporting PASS on an empty set is exactly the
# silent-success failure this pipeline exists to prevent.
if not evs:
    row(False,'Fair','NO EVIDENCE - no runs were evaluated')
    row(False,'No cheating','NO EVIDENCE - no runs were evaluated')
else:
    row(not unfair,'Fair',f"{len(unfair)} run(s) flagged unfair/blocked")
row(j['passed']>=1,'Solvable',f"{j['passed']} agent(s) produced a passing solution")
if evs:
    row(not cheat,'No cheating',f"{len(cheat)} run(s) flagged as gaming the tests")
row(j['runs']>=6,'Minimum runs',f"{j['runs']}/6")
row(rate<=50,'Difficulty',f"{rate}% ({j['passed']}/{j['runs']})  bar <=50%")
row(ml>=150,'Median LOC',f"{ml}  bar >=150")
row(mf>=2,'Median files',f"{mf}  bar >=2")
ok = (bool(evs) and not unfair and not cheat and j['passed']>=1
      and j['runs']>=6 and rate<=50 and ml>=150 and mf>=2)
print(f"\n  {'SUBMITTABLE' if ok else 'NOT SUBMITTABLE'}")
raise SystemExit(0 if ok else 1)
PY
sec "Local pipeline summary"
echo "  static gates: $pass passed, $fail failed"

#!/bin/bash
# TRUE Olympus rollout: real codex_cli (Nova's harness) solves on a2,
# result graded locally in the Olympus base image with the real test.sh.
# usage: codex_rollout.sh <id> <repo> <title> <desc-file> <hidden-test> <test.sh> <image>
set -uo pipefail
cd "$(dirname "$0")" || exit 1
id="$1"; repo="$2"; title="$3"; desc="$4"; hidden="$5"; tsh="$6"; image="$7"

# exact Nova prompt format: "# <title>\n\n<description>"
printf '# %s\n\n%s\n' "$title" "$(cat "$desc")" > /tmp/$id.prompt

rm -rf /tmp/$id.work && cp -R "$repo" /tmp/$id.work && rm -f /tmp/$id.work/Dockerfile
( cd /tmp/$id.work && git checkout -- . 2>/dev/null )

# The solver MUST NOT see the hidden tests or the grading harness. The authoring
# repo directory contains both, and copying it wholesale leaked them into the
# workspace: a run was caught grepping its own hidden test file by name, which
# makes any pass rate from that run meaningless and biased toward easy.
rm -f "/tmp/$id.work/$(basename "$hidden")" "/tmp/$id.work/test.sh"
leaked=$(cd /tmp/$id.work && git status --porcelain --ignored 2>/dev/null | grep -cE "$(basename "$hidden")|(^|/)test\.sh")
if [ -e "/tmp/$id.work/$(basename "$hidden")" ] || [ -e "/tmp/$id.work/test.sh" ]; then
  echo "$id: ABORT — hidden test or test.sh still present in solver workspace" >&2
  exit 3
fi
# COPYFILE_DISABLE stops macOS tar from emitting AppleDouble "._*" resource
# forks. Without it the agent's workspace was littered with 315 junk files and
# the LOC counter read 824 added lines on runs where the agent wrote nothing.
COPYFILE_DISABLE=1 tar --exclude '._*' --exclude '.DS_Store' \
  -C /tmp/$id.work -czf /tmp/$id.tgz .

# Transfer the workspace ONCE per repo and reuse it. gonum is 23MB compressed;
# three concurrent copies silently truncated mid-scp, tar failed into a swallowed
# 2>/dev/null, and the poll loop then waited 96 minutes for a sentinel that could
# never appear. Every step below is verified and aborts loudly.
cachekey=$(echo "$repo" | shasum | cut -c1-12)
local_sz=$(wc -c < /tmp/$id.tgz | tr -d ' ')
ssh -n a2 "mkdir -p ~/rollout/cache" 2>/dev/null
remote_sz=$(ssh -n a2 "wc -c < ~/rollout/cache/$cachekey.tgz 2>/dev/null || echo 0" 2>/dev/null | tr -d ' ')
# Concurrent rollouts share one cache key, so they must not scp to the same
# path at once -- three of them did and produced a corrupt archive
# ("invalid compressed data--format violated"). Transfer to a unique temp name
# and move it into place atomically, under a lock.
if [ "$remote_sz" != "$local_sz" ]; then
  scp -q /tmp/$id.tgz "a2:~/rollout/cache/.$cachekey.$id.part" \
    || { echo "$id: ABORT scp failed" >&2; exit 5; }
  part_sz=$(ssh -n a2 "wc -c < ~/rollout/cache/.$cachekey.$id.part" 2>/dev/null | tr -d ' ')
  [ "$part_sz" = "$local_sz" ] \
    || { echo "$id: ABORT transfer truncated ($part_sz/$local_sz)" >&2; exit 5; }
  ssh -n a2 "mv -f ~/rollout/cache/.$cachekey.$id.part ~/rollout/cache/$cachekey.tgz"
fi
# Whatever is in the cache now, prove it is a valid archive before relying on it.
ssh -n a2 "gzip -t ~/rollout/cache/$cachekey.tgz" 2>/dev/null || {
  ssh -n a2 "rm -f ~/rollout/cache/$cachekey.tgz"
  scp -q /tmp/$id.tgz "a2:~/rollout/cache/.$cachekey.$id.part" || { echo "$id: ABORT scp retry failed" >&2; exit 5; }
  ssh -n a2 "mv -f ~/rollout/cache/.$cachekey.$id.part ~/rollout/cache/$cachekey.tgz && gzip -t ~/rollout/cache/$cachekey.tgz" \
    || { echo "$id: ABORT cached archive still corrupt" >&2; exit 5; }
}
scp -q /tmp/$id.prompt a2:~/rollout/$id.prompt || { echo "$id: ABORT prompt scp failed" >&2; exit 5; }
ssh -n a2 "rm -rf ~/rollout/$id && mkdir -p ~/rollout/$id && tar xzf ~/rollout/cache/$cachekey.tgz -C ~/rollout/$id" \
  || { echo "$id: ABORT tar extraction failed" >&2; exit 5; }
nfiles=$(ssh -n a2 "find ~/rollout/$id -type f | head -50 | wc -l" 2>/dev/null | tr -d ' ')
[ "${nfiles:-0}" -ge 5 ] || { echo "$id: ABORT workspace empty after extraction ($nfiles files)" >&2; exit 5; }

start=$(date +%s)
# Run DETACHED on a2. A dropped ssh connection previously killed a 1-hour
# rollout mid-flight ("Connection reset by peer"), losing the measurement.
# nohup + setsid means the run survives the control channel; we poll for a
# sentinel file instead of holding the pipe open.
ssh -n a2 "cd ~/rollout/$id && rm -f ../$id.done && setsid nohup env HOME=/home/livio/rollout/fakehome CODEX_HOME=/home/livio/rollout/fakehome/.codex timeout 5400 codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -c model_reasoning_effort=\"high\" -C ~/rollout/$id \"\$(cat ~/rollout/$id.prompt)\" > ~/rollout/$id.log 2>&1 < /dev/null; echo \$? > ~/rollout/$id.done" < /dev/null > /dev/null 2>&1 &
for _ in $(seq 1 380); do
  sleep 15
  if ssh -n -o ConnectTimeout=10 a2 "test -f ~/rollout/$id.done" 2>/dev/null; then break; fi
done
arc=$(ssh -n a2 "cat ~/rollout/$id.done 2>/dev/null" 2>/dev/null || echo 99)
scp -q a2:~/rollout/$id.log /tmp/$id.agent.log 2>/dev/null; secs=$(( $(date +%s) - start ))

ssh a2 "cd ~/rollout/$id && tar czf ../$id.out.tgz ." 2>/dev/null
scp -q a2:~/rollout/$id.out.tgz /tmp/$id.out.tgz
rm -rf /tmp/$id.graded && mkdir -p /tmp/$id.graded && tar -C /tmp/$id.graded -xzf /tmp/$id.out.tgz
cp "$hidden" "$tsh" /tmp/$id.graded/ && chmod +x /tmp/$id.graded/test.sh

# Grading bind-mounts the workspace over /app, which SHADOWS everything baked
# into the image at that path — including .base_tests.txt. Without the manifest
# base mode aborts, so every run reads baselinePassed=false regardless of what
# the agent did. Lift the manifest out of the image into the workspace.
# Retry: a transient failure here (the image was mid-rebuild) aborted a run
# whose agent had actually SOLVED the task, and the abort was then recorded as
# a FAIL -- biasing the measurement toward "too hard", which is the direction
# that makes you soften a task that never needed it.
for _try in 1 2 3; do
  docker run --rm --entrypoint cat "$image" /app/.base_tests.txt \
    > /tmp/$id.graded/.base_tests.txt 2>/dev/null
  [ -s /tmp/$id.graded/.base_tests.txt ] && break
  sleep 5
done
if [ ! -s /tmp/$id.graded/.base_tests.txt ]; then
  # ABORT is not a verdict. Emit a distinct marker so the caller DISCARDS the
  # run instead of banking it as an agent failure.
  echo "$id: ABORT_HARNESS  could not recover .base_tests.txt from $image" >&2
  echo "$id: ABORT_HARNESS  could not recover .base_tests.txt from $image"
  exit 4
fi

out=$(docker run --rm --network none -v "/tmp/$id.graded:/app" "$image" bash -c '
  cd /app
  ./test.sh --output_path /tmp/b.xml base > /tmp/b.log 2>&1; echo "BASE_RC=$?"
  ./test.sh --output_path /tmp/n.xml new  > /tmp/n.log 2>&1; echo "NEW_RC=$?"
  echo "NEWFAIL=$(grep -c "^\s*--- FAIL: " /tmp/n.log)"
  grep -E "^\s*--- FAIL: |syntax error|undefined: " /tmp/n.log | head -4 | sed "s/^/D /"
' 2>&1)
brc=$(sed -n 's/^BASE_RC=//p' <<<"$out"); nrc=$(sed -n 's/^NEW_RC=//p' <<<"$out")
nf=$(sed -n 's/^NEWFAIL=//p' <<<"$out")
files=$(cd /tmp/$id.graded && git status --porcelain 2>/dev/null \
        | grep -vE "$(basename $hidden)|test\.sh|\._|\.DS_Store|base_tests" | wc -l | tr -d ' ')
# `git diff` shows tracked modifications ONLY. Agents typically add a NEW file,
# which is untracked, so this reported addedLines=0 for runs that had in fact
# written a complete implementation -- and Median LOC is a submission criterion.
# Stage everything first so new files are counted.
# EFFECTIVE solution lines, per the platform's rule: "the lines an agent has to
# actually write to implement the task... Blank lines, comments, and padding are
# excluded, and test code doesn't count at all."  Counting raw added lines gave
# 1321 where the rule gives 360 -- a 3.7x overcount that would call a sub-bar
# candidate a pass.
cd /tmp/$id.graded && rm -f ._* .DS_Store 2>/dev/null
find /tmp/$id.graded -name '._*' -delete 2>/dev/null
( cd /tmp/$id.graded && git add -A >/dev/null 2>&1 )
loc=$( cd /tmp/$id.graded && git diff --cached 2>/dev/null | python3 "$here/eff_loc.py" )

files=$(cd /tmp/$id.graded && git status --porcelain 2>/dev/null \
        | grep -vE "$(basename $hidden)|test\.sh|\._|\.DS_Store|base_tests" | wc -l | tr -d ' ')
# `git diff` shows tracked modifications ONLY. Agents typically add a NEW file,
# which is untracked, so this reported addedLines=0 for runs that had in fact
# written a complete implementation -- and Median LOC is a submission criterion.
# Stage everything first so new files are counted.
loc=$(cd /tmp/$id.graded && rm -f ._* .DS_Store 2>/dev/null; \
      find . -name '._*' -delete 2>/dev/null; \
      git add -A >/dev/null 2>&1; \
      git diff --cached 2>/dev/null \
        | grep -v -E "^\+\+\+|$(basename "$hidden")|\._" \
        | grep -c '^+[^+]')
[ "$nrc" = "0" ] && v=PASS_LEGITIMATE || v=FAIL
[ "$brc" = "0" ] && b=true || b=false
# The dashboard reports a per-run message count ("45 msgs") alongside files and
# LOC, and the live tier carries a median-messages bar, so track it.
msgs=$(grep -c '^\[20\|tokens used\|^exec\|^codex' /tmp/$id.agent.log 2>/dev/null | head -1)
echo "$id: $v  baselinePassed=$b  files=$files  addedLines=$loc  msgs=${msgs:-0}  newFailures=$nf  agentExit=$arc  ${secs}s"
[ "$nrc" != "0" ] && grep "^D " <<<"$out" | head -4 | sed 's/^D/    /'

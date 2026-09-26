#!/bin/bash
# Mine eligible repos for long-open, high-demand issues (hard by natural selection).
for repo in "$@"; do
  meta=$(gh api repos/$repo --jq '"\(.stargazers_count)|\(.license.spdx_id)|\(.pushed_at[:10])|\(.language)"' 2>/dev/null) || continue
  IFS='|' read -r stars lic pushed lang <<<"$meta"
  case "$lic" in MIT|Apache-2.0|BSD-3-Clause|BSD-2-Clause|ISC) ;; *) continue;; esac
  [ "${stars:-0}" -ge 500 ] || continue
  [[ "$pushed" > "2025-09-01" ]] || continue
  echo "### $repo  ${stars}★ $lic $lang (pushed $pushed)"
  gh api "repos/$repo/issues?state=open&per_page=100&sort=reactions&direction=desc" \
    --jq '.[] | select(.pull_request == null) | select(.created_at < "2024-01-01") |
          "\(.reactions.total_count)\t#\(.number)\t\(.created_at[:7])\t\(.title[:88])"' 2>/dev/null \
    | sort -rn | head -6
  echo
done

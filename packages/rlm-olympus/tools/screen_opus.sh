#!/usr/bin/env bash
# Opus SCREEN — not a measurement.
#
# The authoritative pass rate must come from the platform's own solver
# (codex_cli / gpt-5.6-sol via a2), because that is what grades the submission.
# An Opus rate measures Opus. A proxy model already misread one task at 50% that
# the real solver then passed 4/4.
#
# What Opus IS good for: a free, unmetered filter. If Opus solves a candidate
# easily, the real solver almost certainly will too, so the candidate is too easy
# and can be rejected WITHOUT spending a codex window. Only candidates that give
# Opus trouble are worth the metered measurement.
#
# Cheap NO, expensive YES: a screen fail is decisive, a screen pass is not.
#
#   screen_opus.sh <candidate-dir> <workdir>
set -uo pipefail
d="$(cd "${1:?candidate dir}" && pwd)"; w="${2:?workdir}"
title=$(python3 -c "import json;print(json.load(open('$d/meta.json'))['title'])")
repo=$(python3 -c "import json;print(json.load(open('$d/meta.json'))['repo'])")
hidden=$(python3 -c "import json;print(json.load(open('$d/meta.json'))['hidden'])")
tsh=$(python3 -c "import json;print(json.load(open('$d/meta.json'))['test_sh'])")
img=$(cat "$d/image.txt")

# Byte-identical prompt shape to the real solver: "# <title>\n\n<description>"
rm -rf "$w" && mkdir -p "$w"
cp -R "$repo/." "$w/" 2>/dev/null
rm -f "$w/$(basename "$hidden")" "$w/test.sh" "$w/Dockerfile"
printf '# %s\n\n%s\n' "$title" "$(cat "$d/description.txt")" > "$w/TASK.md"
echo "workspace ready at $w"
echo "prompt written to $w/TASK.md"
echo
echo "Grade an Opus attempt with:"
echo "  bash $0 --grade $d $w"

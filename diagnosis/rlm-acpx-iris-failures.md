# rlm/acpx/Iris: Failure Pattern Diagnosis

**lapse.status:** 26 shapes, 16 over threshold (threshold=3), 1 explained (shape 0,
named-and-not-called, claimed by evolve:proposed), **14 unexplained failures.**

failure clusters:

## 1. Failure Clusters

### A. TypeScript Type Errors (9 shapes, 55 occurrences)

Recurring patterns across iris-dirsize, iris-clocktick, iris-watson-seaboard, and test
files:

- Missing description on CommandParameter / IntentDefinition (14 occurrences, worst)
- Bare exec instead of execSync (9 occurrences)
- Accessing static member via instance: ctx.config instead of FooService.config (8)
- Unterminated string literal (1)
- 'e' is of type 'unknown' (7)

The plugin-gate runs tsc --noEmit at mount time and correctly refuses every package
with type errors. The errors were never fixed because nothing rewrote the source after
the rejection. The skill-gate status shows iris-alexa-tondola, iris-search-person, and
iris-pong also failed the plugin gate (types or tests). Additionally, 2 test-file type
errors escaped: iris-fashion-trends.test.ts has TS2306 and iris-keep test fixtures have
TS2739 — the types level checks src/ only.

### B. Skill Gate Rejection Failures (3 shapes, 22 occurrences)

The skill gate correctly identifies every one of these and rejects them. The
rejections are recorded; the skills remain on disk.

| Shape | Verdict | Skill | Count |
|---|---|---|---|
| mtjfu69q03 | shape | open-youtube-channel | 6 |
| mtj9syhe0h | trigger-reach | greet | 8 |
| mtj9sogf0g | fixed-answer | rika-shortcuts | 1 |
| mtjfxd3h04 | shape | fashion-trends-shell | 2 |
| mtjfxd3i05 | shape | fashion-trends-shell | 2 |
| mtjgmq3b07 | shape | run-shell | 2 |

Additionally: me-1-proposer (skill-gate.status tested=false) failed without a
corresponding lapse shape appearing above threshold.

### C. Event Pair Breakage (1 shape, 164 occurrences)

mtje7sje01 broke-a-pair, 164 times. The pair skillGate/plugin-tested followed by
keep/changed has failed on every recorded attempt. The root cause is structural:
keep/changed is emitted only when the file-system watcher detects a delta against
the mirror. The skill gate runs at mount time, which has no causal relationship to
a subsequent file-system event. These are independent triggers. The pair is
unsatisfiable by design.

Recent instances in lapse.list show a wider chain failure:
- hmr/change no longer triggers log/wrote
- keep/noticed no longer triggers log/wrote or prompt/changed

### D. Stale Self-Knowledge (2 shapes, 12 occurrences)

mtja3som0k (event, 6x) and mtja3soo0l (path, 6x). creed.check checked 852 claims and
found 40 stale across three documents:

**cordis.yml (8 stale):**
- ~/.iris/credentials.json missing (7 occurrences)
- @iris/ears, @iris/heed, @iris/lapse: never emitted in source
- evolve.mode: not among evolve.cycle / evolve.log / evolve.status

**AGENTS.md (9 stale):**
- @deepseek-ai/cordis, @iris/handover, @iris/agents: never emitted
- desktop.apps: not a registered desktop command
- node_modules paths don't exist

**docs/acpx.md (23 stale):**
- @iris/rlm, @iris/converse, @iris/agents, @iris/agents-acpx, @iris/agents-rlm,
  @iris/boot: never emitted
- agents.register(): not a registered agents command

### E. Source Modification Without Gate (1 shape, 3 occurrences)

mtk65vzk08 broke-on-load, 3 times. A plugin was mounted, its source was modified
directly, the row reloaded, and the row stopped loading. The plugin gate runs only
at plugin.mount, not on write to an already-mounted package. iris-undo observed the
breakage in all three cases and could not repair it. The guidance (plugin.check,
undo, standing prompt) was all present and not acted on.

---

## 2. Ranked Carriers of Guidance

| Channel | Shapes Present | Carried | Effective |
|---|---|---|---|
| skill gate (posthoc) | 21 shapes | — | No: judges output, cannot change input |
| plugin gate (posthoc) | 3 shapes | — | No: same |
| undo (posthoc) | 2 shapes | — | No: observes after fact, cannot repair |
| standing prompt | 10 shapes | Yes | No: assembled from top, wrong position for action |
| command registry | 8 shapes | Yes | Partially: exists but no pre-write enforcement |
| SKILL.md documents | 6 shapes | Yes (5), No (1) | No: present but not always in context |
| creed-check | 2 shapes | Yes | No: detects stale but cannot correct |
| lull | 1 shape | — | No: observes absences, no fix mechanism |

All posthoc observers share one property: they detect bad outcomes and name the
remedy, but have no path to apply it. The command registry is the only channel
that is present, carries a fix, and is structurally available at pre-write time
— and it is not used for pre-write validation.

---

## 3. Gaps in Current Diagnosis (Why 14/15 Failures Are Unexplained)

**1. Detection without correction loop.**
The skill gate identifies a bad skill and rejects it. The rejection is recorded in
lapse. Nothing removes the skill from disk, and nothing tells the model to fix the
specific error. The model reproduces the same pattern in the next session.

**2. Gate runs at mount, not at write.**
The type-error shapes (Cluster A) and broke-on-load (Cluster E) share one
structural property: the gate checks the result of an action that has already
completed. The gate refuses a bad package at mount. By mount time, the type error
is already on disk.

**3. Skill gate is output-judging, not input-validating.**
The skill gate checks whether a skill file that exists is good. It does not
validate the inputs that produce the skill file (does the command exist? are
triggers non-empty? are steps non-empty?) before the skill is saved.

**4. Typechecker's root may not match plugin location.**
The skill-gate typechecker is at /Users/abhi/proj/sensei/iris-mama/node_modules/.bin/tsc.
Plugins were created in both /Users/abhi/proj/sensei/iris-mama/packages/ and
/Users/abhi/proj/rlm/packages/. Error filtering by package-relative path may classify
all errors as elsewhere if the typechecker's root does not encompass the plugin
location. Additionally, the types level checks src/ only — test/ type errors are
invisible to the gate.

**5. lull cannot fix event chains.**
The 164-failure broke-a-pair cluster is a structural mismatch: skillGate/plugin-tested
and keep/changed are independent triggers. lull correctly identifies the mismatch
but has no mechanism to correct it.

**6. creed cannot correct.**
The 40 stale claims are exactly diagnosed. The fix for each is named. creed has no
path to apply the correction to cordis.yml, AGENTS.md, or docs/acpx.md. The same
claims are stale today that were stale when the shapes first appeared.

---

## 4. Proposed Non-Hardcoded Fixes

### Fix 1: plugin-gate runs on plugin.write, not only on plugin.mount

**Files:** packages/iris-skill-gate/src/plugin-gate.ts; packages/iris-plugins/src/write.ts

**Problem:** Type-error shapes (Cluster A) and broke-on-load (Cluster E) are recorded
because bad source reached disk before any gate ran. The plugin gate checks mount,
not write.

**Fix:** Add a pre-write gate check to plugin.write. Run shape + substance + types
against the proposed source before the write commits. If fatal findings exist, refuse
the write and return the findings as the error. The existing checkTypes function in
plugin-gate.ts is the right tool; it needs to be called from the write path.

### Fix 2: skill-gate validates skill save inputs, not only skill file outputs

**Files:** packages/iris-skill-gate/src/gate.ts; packages/iris-skill-gate/src/judgement.ts

**Problem:** A skill with empty triggers, empty steps, or a non-existent command
passes the save-time judgment and fails at evaluation time.

**Fix:** Add a pre-save validation step. Before a skill is committed to the recall
index: check that every step names a command in the command registry; that triggers
is non-empty; that steps is non-empty; that every parameter has either a
trigger-derived fill or a default. Refuse the save if any check fails.

### Fix 3: lull.keep() emits keep/changed after skillGate/plugin-tested

**Files:** packages/iris-skill-gate/src/plugin-gate.ts

**Problem:** skillGate/plugin-tested (164x) and keep/changed are independent triggers.
The pair is unsatisfiable. Every lapse instance is a false alarm generated by a bad
pair definition.

**Fix:** After the skill gate runs on a plugin, call the keep service to record the
change explicitly, so that keep/changed fires from within the skill gate's execution
path and satisfies the lull pair expectation.

### Fix 4: creed.check writes correction patches to the documents it flags

**Files:** new creed-correct plugin or packages/iris-skill-gate/src/creed.ts

**Problem:** 40 stale claims are correctly identified and named. creed cannot apply the
corrections. The stale claims persist indefinitely.

**Fix:** Add a write mode to creed.check. When it finds a stale path, command, or
event claim: propose the correct replacement. Write corrections to a proposal file
(e.g., ~/.iris/creed/proposals/). A subsequent step reviews and applies them.
The key invariant: creed cannot correct its own source, but it can correct the
documents it flags. Alternatively: make creed.check refuse to assemble a system
prompt section from a document with more than N stale claims, blocking progress
rather than accumulating silently.

### Fix 5: plugin typecheck includes test/ directory

**Files:** packages/iris-skill-gate/src/plugin-gate.ts checkTypes function

**Problem:** The types level checks src/ only. iris-fashion-trends.test.ts has TS2306
and iris-keep test fixtures have TS2739 — both invisible to the gate.

**Fix:** After running tsc --noEmit with the src/ filter, run a second pass filtering
to test/. Merge findings. Both represent real failures that should block mount.

### Fix 6: typechecker's root is verified against the plugin location

**Files:** packages/iris-skill-gate/src/plugin-gate.ts checkTypes function

**Problem:** Error filtering by package-relative path may classify all errors as
elsewhere if the typechecker's tsconfig root does not encompass the plugin's
packages directory.

**Fix:** Before running the type check, verify that the typechecker's tsconfig root
encompasses the plugin's packages directory. If not, report the finding as
not-checked and refuse the mount at the types level.

---

*Diagnosis generated from iris lapse.status (26 shapes, 16 over threshold) and
iris skill-gate.status (15 skills tested, 4 failed; 4 plugins tested, 3 failed)
against /Users/abhi/.iris/lapse.json and /Users/abhi/.iris/skills/.*

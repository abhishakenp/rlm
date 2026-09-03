# outloop — the loops that prompt him out of his own process

**Status: specification. Nothing here is built.** It is written so that
implementing it is typing rather than designing, the way `docs/acpx.md` was
written in the iris-mama tree for the same reason. Where it names a file, that
file does not exist yet unless it says otherwise.

The seam it plugs into *does* exist and is already load-bearing:
`packages/rlm-delegate` specifies a reviewer and deliberately does not implement
one. **Read `packages/rlm-delegate/README.md` and `src/graph.ts` before writing a
line of this.** Everything below is an occupant of a room that package already
built.

Two findings from reconnaissance are load-bearing and appear early because they
change what is worth building:

- **The corpus of "what he said" is a few kilobytes, not a few megabytes.** After
  filtering, roughly two dozen genuine utterances exist across both sources
  (§12). No compaction layer is needed, and the `stricter-rtk` fork is not on
  this critical path (§12.5).
- **me-2's queue is empty today.** Every task in every journal on disk is
  `unproven`; there is not one `done` task anywhere, so `forReview()` returns
  nothing (§12.3). me-2 must therefore be proved against constructed cases
  (§6.7) before the runner ever hands it real work.

---

## 1. What this is

His shape, in his words:

```
- me
- me-1  (thinks like me, gives ideas, strict gates)
- me-2  (reviews like me, gives feedback on existing work on all aspects)
- outer delegator
- n inner delegators
```

> "real 'me' would talk to delegator not me-1 or me-2. me-1 and me-2 would just
> prompt like i am currently doing with you and i do with other agents, to
> automate the prompter out from me. and me-1 and me-2 would ofc get the reports
> from delegator before it reaches me, so it can learn from what i said and what
> i delivered by looking at the compacted transcripts."

And the constraint that makes it buildable:

> "it doesnt have to know about anything except transcripts, what i said. thats
> it. not code it writes or anything heavy"

That constraint is the design's best feature and it should be defended, not
relaxed. These two loops read **what he said**. They do not read the code that
was written, they do not open a diff, and they form no opinion about
implementation quality. The moment either one has to understand the work in
order to judge it, it has to be as capable as the thing that did the work — and
then it is just another agent producing confident prose about a codebase, which
is the failure this whole area exists to stop.

| | me-1 | me-2 |
|---|---|---|
| role | proposer | reviewer |
| reads | his transcripts + what the graph already holds | one finished task: the request, the criterion, the evidence |
| produces | a proposal, quoting him | a verdict — `accepted` / `rejected` / `unsure` — with a reason |
| lands in | a file; the graph only on an explicit commit | the task graph, through `review()` |
| its lie, if it lies | work nobody wanted | a rubber stamp |
| build order | **second, and not yet** (§8, §12.4) | **first** |

**Build me-2 first.** Its seam already exists, its input is concrete, its output
is two words and a sentence, and it pays immediately: the graph can ask whether
the declared test passed, and cannot ask whether the declared test was the right
one. That second question is the whole of me-2 and nothing else in the system
asks it.

---

## 2. Where me-2 goes: the seam `rlm-delegate` left

Already in the tree, unimplemented on purpose. From
`packages/rlm-delegate/src/graph.ts`:

```ts
export interface Review {
  by: string
  at: string
  verdict: "accepted" | "rejected"
  reason: string
}

export interface Reviewer {
  review(task: Task, graph: Graph): Promise<{ verdict: "accepted" | "rejected"; reason: string }>
}
```

And on the service, `packages/rlm-delegate/src/index.ts`:

| method | what it gives you |
|---|---|
| `forReview(graphId)` | every `done` task, with its criterion in words, the evidence that satisfied it, and any verdict already recorded |
| `review(graphId, taskId, verdict, by, reason)` | records the verdict; appends to the journal; emits `rlm/delegate-reviewed` |
| `get(graphId)` | the whole `Graph`, including `goal` and every `Task` with its `attempts` |

`forReview` returns exactly this:

```ts
Array<{
  id: string
  title: string        // the asker's words
  criterion: string    // describeProof(proof) — the criterion as a sentence
  proof: Task["proof"] // the structured criterion
  evidence?: string    // proofDetail of the attempt that passed
  result?: string      // what the agent said it did
  reviewed?: Review    // already judged — skip these
}>
```

### 2.1 What `forReview` does not give you, and where to get it

me-2's question is *does the criterion cover the request*, so it needs the
request. `forReview` is per-task and the request is per-graph. Three things are
missing and all three are already public on `get(graphId)`:

| needed | why | where |
|---|---|---|
| `graph.goal` | **the request, verbatim** — the other half of the comparison | `get(graphId).goal` |
| `task.prompt` | what the agent was actually told, which may narrow the request | `get(graphId).tasks[]` |
| `attempt.at` | when the work *began* — the timestamp the deductive floor in §5.2 needs | `task.attempts[]` |

**Do not widen `forReview` to add them.** Another agent is building a runner in
`packages/rlm-delegate`, and the whole of me-2 can be written without touching
that package: use `forReview(graphId)` as the *list of candidates* and
`get(graphId)` for the substance. Widening it is a two-line change once the tree
is quiet, and it is not needed to ship.

### 2.2 Three facts about `review()` that will bite

1. **`accepted` is not a no-op.** In `store.ts`, an `accepted` verdict on a task
   currently in `rejected` puts it back to `done`. A me-2 that accepts
   everything it is handed will silently un-reject work a person rejected.
   Accepting must be a decision, never a default and never a sweep.
2. **`rejected` is a failure, with blast radius.** `settle()` treats a rejected
   task exactly like a failed one: dependents that had not started become
   `unreachable`, and dependents that had already finished are marked `tainted`.
   One wrong rejection can take a subtree down. That asymmetry is the argument
   for the quote gate in §6.4 — not for timidity, for evidence.
3. **Rollups are in the queue and should not be.** `closeRollup` in
   `scheduler.ts` finishes a rollup with `proofDetail: "everything it was broken
   into is done"`, so it arrives in `forReview` as a `done` task whose criterion
   is true by construction. **Skip `proof.kind === "rollup"` in v1.** There *is*
   a real question about a rollup — whether the children add up to the parent —
   but that is a review of a decomposition, not of a criterion, and it is §11.

### 2.3 What me-2 does *not* see, and why that is correct

Only `done` tasks reach `forReview`. So the nine-jobs-in-one-night case does not
arrive here at all: under this graph those turns end `unproven` or `failed`, and
the graph already refuses to call them finished. me-2 is not the guard against
*"it said done and nothing ran"* — the criterion is. me-2 is the guard against
*"something ran, it passed, and passing it meant nothing"*.

Keep that scope. A me-2 that also chases `unproven` tasks is doing the graph's
job, worse than the graph does it.

---

## 3. The contract

New package, `packages/rlm-outloop`, row id `outloop`. Nothing in
`packages/rlm-delegate` changes. This is `src/contract.ts`; copy it.

```ts
/**
 * What me-2 is handed. Assembled by the caller from `forReview()` + `get()`,
 * never fetched by the reviewer itself — so the reviewer is a pure function of
 * text and can be tested with no graph, no disk and no model.
 */
export interface ReviewCase {
  graphId: string
  taskId: string
  /** The request as it arrived, verbatim. `graph.goal`. */
  request: string
  /** The asker's one line for this task. `task.title`. */
  title: string
  /** What the agent was actually told. `task.prompt`. */
  prompt: string
  /** The structured criterion. */
  proof: Proof
  /** The criterion as a sentence — `describeProof(proof)`. */
  criterion: string
  /** What the criterion printed when it passed. */
  evidence: string
  /** What the agent said it did. Read with suspicion: the claim, not the proof. */
  claim: string
  /** ISO. When the work began — the attempt whose proof passed. */
  startedAt: string
}

/** Three outcomes, not two. See §6.5 — `unsure` is why me-2 can be trusted. */
export type Verdict = "accepted" | "rejected" | "unsure"

export interface Judgement {
  verdict: Verdict
  /** One paragraph, for the journal and for him. */
  reason: string
  /**
   * For a rejection: the span of `request` the criterion does not cover,
   * quoted literally. Checked as a substring before anything is recorded.
   * A rejection without one is downgraded to `unsure`.
   */
  quote?: string
  /** Which mechanical concern (§5.3) or rubric rule (§7) this rests on. */
  cites?: string[]
  /** Which layer decided: the deductive floor, or the reading on top of it. */
  by: "floor" | "reading"
}

/**
 * How the loops reach a model.
 *
 * One prompt in, one string out, no tool loop. Injected rather than imported so
 * the loops can be driven by a stand-in in tests — the pattern
 * `packages/rlm-delegate/workflow.test.ts` already uses for the planner.
 *
 * The real implementation is §9. It is `completeSimple` from `packages/ai`,
 * NOT `rlmSdk.spawn` — spawn runs a whole agent.
 */
export type Ask = (prompt: string, options?: { name?: string; maxTokens?: number }) => Promise<string>
```

And the two loops, as functions:

```ts
/** me-2. Pure: text in, judgement out. No disk, no graph, no side effects. */
export type Reviewer = (job: ReviewCase, rubric: Rubric, ask: Ask) => Promise<Judgement>

/** me-1. See §8. */
export type Proposer = (input: ProposalInput, rubric: Rubric, ask: Ask) => Promise<Proposal[]>
```

Everything stateful — reading the graph, recording the verdict, writing the
report — lives in the service (§10) and calls these. Keep the judgement itself
pure; it is the only way to have a test suite that proves me-2 rejects the
`iris-dirsize` case with no model, no network, and no mounted rlm.

---

## 4. me-2, end to end

```
forReview(graphId)                     candidates: done, not yet reviewed, not rollups
  └─ get(graphId)                      + the request, the prompt, the start time
      └─ survey(job)                   MECHANICAL. facts, floor rejections, concerns
          ├─ floor rejection?  ────────► record `rejected`, cite the arithmetic, DONE.
          │                             the model is never asked. it cannot overturn this.
          └─ otherwise
              └─ read(job, concerns, rubric, ask)     ONE model call
                  └─ gate(answer, job)                MECHANICAL. quote must be real
                      ├─ valid rejection ────────────► record `rejected`
                      ├─ valid acceptance ───────────► record `accepted`
                      └─ anything else ──────────────► `unsure`. record NOTHING.
```

Two mechanical layers with one model call sandwiched between them, and the
model's output checked on the way out by the same kind of check that produced
its input. That sandwich is the entire trustworthiness argument; §5 and §6 are
the two slices of bread.

---

## 5. The floor: what can be decided without a model

`src/survey.ts`. Pure but for one `fs.statSync`. This is the part that is
*right* rather than plausible, and it should be written and tested first — a
me-2 that is only the floor is already worth shipping.

### 5.1 Facts it computes

From `ReviewCase` alone:

- `identifiers(request)` — every concrete handle the request names: file paths,
  dotted command names (`dirsize.of`), row ids, package names, anything in
  backticks. A conservative regex set; missing one costs a concern, inventing
  one costs a false rejection, so bias to missing.
- `identifiers(criterion)` — the same, over the criterion's text and its
  structured fields (`proof.run`, `proof.path`, `proof.name`, `proof.id`).
- `overlap` — the intersection.
- `verbs(request)` — whether the request is behavioural (*run, work, return,
  fix, make X do Y, so that*) or existential (*add, create, write, scaffold*).

### 5.2 Floor rejections — deductive, model never consulted

Only two, and both are provable. Resist adding a third that is merely strong.

**F1 — the criterion was already satisfied before the work started.**

For `proof.kind === "file"` with no `changedSince`: if
`statSync(path).mtimeMs < Date.parse(startedAt)`, the file existed, unmodified,
before the attempt began. The criterion was true before anybody did anything, so
passing it is not evidence the work happened.

Record it with the arithmetic in the reason, so a person can check it at a
glance:

> rejected — `/x/y.ts` last changed 2026-08-30T11:04:02Z; the work began
> 2026-09-02T01:19:55Z. The criterion "`/x/y.ts` exists" was already true two
> days before this task was picked up, so it cannot be evidence the task was
> done.

This is the scaffold detector for file criteria and it costs one `stat`.

**F2 — the criterion is constant.**

A shell criterion whose exit code cannot depend on the work: `true`, `:`,
`exit 0`, and a bare `echo …` with no pipe, `&&`, `;`, or command substitution.
Match narrowly on the *whole* trimmed command, never on a substring — a command
that merely contains the word `true` is a different thing.

Not hypothetical: `exit 0` is used as a stand-in criterion in
`packages/rlm-delegate/workflow.test.ts` today, and a planner that has read the
prompt fragment has seen it.

### 5.3 Concerns — pre-stated, handed to the model, never auto-rejected

The difference between a reviewer that works and one that invents is almost
entirely here. A model asked *"is anything wrong with this?"* will find
something, because that is what the question rewards. A model asked *"does
concern C1 apply to this pair, yes or no, and quote the words"* is doing a
bounded reading with a checkable answer.

So the survey **names the suspicion** and the model only adjudicates it.

| id | fires when | the scar behind it |
|---|---|---|
| **C1** mounted, not working | `proof.kind` is `row` or `command`, and the request's verbs are behavioural | `iris-dirsize` was announced as a capability with its row ACTIVE while its only command was still the scaffold's `dirsize.hello` |
| **C2** the criterion is about something else | `overlap` is empty and the request names at least one identifier | a criterion mentioning nothing the request mentions is testing a different thing, or nothing |
| **C3** existence where behaviour was asked | `proof.kind === "file"` (exists / contains) and the verbs are behavioural | a file containing the right words is prose, not a working feature |
| **C4** the smoke test | the shell command is `--help`, `--version`, a bare import/require, or `node -e` with no assertion | it proves the binary starts |
| **C5** narrower than the ask | the request names several identifiers and the criterion covers one | five of six jobs went missing once already; a criterion covering one sixth of a request is the same shape |
| **C6** evidence says nothing | `evidence` is empty, or only restates the criterion | "exited 0" with no output, for a criterion that should have printed something |

C6 is a concern and not a floor rejection on purpose: plenty of honest commands
print nothing.

**A concern is never a verdict.** `survey()` returns them; the model decides
whether each actually applies to these particular words. A concern that fires
and is correctly dismissed should be common — if the model never dismisses one,
the concerns are miscalibrated, and that is measurable (§6.6).

---

## 6. The reading: one model call, gated on both sides

`src/reviewer.ts`.

### 6.1 The question, narrowed

The prompt asks one thing and says so:

> You are not reviewing the work. You cannot see the work. You are reviewing
> **whether the criterion, if it passed, establishes that the request was
> fulfilled.**
>
> The request, verbatim: …
> The criterion: …
> What the criterion printed: …
> What the agent claimed: … *(a claim, not evidence)*
> Concerns already raised mechanically: C1, C3 …
> Standing objections he has made before: R2 "…", R7 "…"

Every field is text already on disk. Nothing is summarised on the way in — the
corpus is small enough that nothing needs to be (§12.5).

### 6.2 The answer, constrained

Return one JSON object and nothing else:

```json
{
  "verdict": "accepted" | "rejected" | "unsure",
  "quote": "the exact words from the request the criterion does not cover",
  "cites": ["C1", "R2"],
  "reason": "one paragraph"
}
```

Parse with the cascade in §9.3. **A malformed answer is `unsure`, not a retry
into acceptance.**

### 6.3 Why acceptance is bounded in its own words

The recorded reason for an acceptance must say what it does and does not mean:

> accepted — the criterion runs `iris dirsize.of path=.` and requires a size in
> the output, which is the behaviour the request named. This says nothing about
> the quality of the implementation, which was not examined.

Without that, the journal fills with `accepted` marks that read like
endorsements of the work, and the next reader up the chain — him — takes them as
such. That is a new way to manufacture false confidence, inside the package
built to destroy false confidence.

### 6.4 The quote gate

**A rejection must quote a literal span of the request that the criterion does
not cover, and that span is checked as a substring before anything is written.**

```ts
const norm = (s: string) => s.replace(/\s+/g, " ").trim()

const grounded = (j: Judgement, job: ReviewCase): boolean =>
  j.verdict !== "rejected" ||
  (!!j.quote &&
   norm(j.quote).length >= 8 &&
   (norm(job.request).includes(norm(j.quote)) || norm(job.prompt).includes(norm(j.quote))))
```

If the quote is not there, the model made it up: the verdict is downgraded to
`unsure` and counted as a fabrication (§6.6). One substring check makes a
fabricated rejection structurally impossible to record. Normalise whitespace on
both sides and nothing else — no fuzzy matching, no lowercasing. The gate is
worth exactly as much as it is strict.

### 6.5 `unsure` must be cheap

Three outcomes, and the graph accepts two. So `unsure` means **nothing is
recorded**: the task stays `done`, stays un-reviewed, and appears in the report
as *could not judge*.

This is not a rough edge, it is load-bearing. A reviewer with only `accepted`
and `rejected` and a queue to clear will accept, because accepting is the
cheaper of the two available lies. Give it a free exit and the acceptances that
remain mean something. Say so in the prompt, in those words: *"unsure costs you
nothing and is the right answer whenever the request does not say enough to
tell."*

### 6.6 Rubber-stamping is measurable, so measure it

Every verdict is journalled. The report (§10.3) carries the running counts, and
so does the log line.

- **Acceptance ≈ 100% over the last 20 → me-2 is not reviewing.** Say it in the
  report, in those words. A reviewer that has never rejected anything is broken,
  and the only thing worse than not having one is having one nobody doubts.
- **Rejection ≈ 100% → it is a rejection machine**, equally useless and more
  expensive, because every rejection takes a subtree with it (§2.2.2).
- **`unsure` ≈ 100% → the concerns or the rubric are not reaching it.**
- **Any fabricated quote at all** is worth a line of its own. One is a bad
  sample; a steady rate means the prompt is inviting invention.

There is no correct band to hard-code. Print the numbers and let him look. But
print them.

### 6.7 The seeded fault — the honest way to know it works

Ship with this as a test, and do not trust the loop until it passes. It is not
optional: until the runner produces a `done` task, this is the *only* way me-2
can be exercised at all (§12.3).

```
request:   "give iris a dirsize command"
criterion: row iris-dirsize reaches ACTIVE
evidence:  "row iris-dirsize is ACTIVE"
```

The correct verdict is `rejected`, citing C1, quoting `dirsize command`. The row
being mounted says nothing about the command doing anything, and this is the
exact pair that was announced as a working capability on the night that produced
`rlm-delegate`. **If me-2 accepts this, it is not fit to run.**

Add the counterpart — the same request against a criterion that runs the command
and requires a number — and require `accepted` there, or the test only proves it
can say no.

A third case is free and worth having, because his own words name it:

```
request:   "iris-dirsize is 104 lines whose only command is still dirsize.hello
            from the template — finish or remove"
criterion: `iris dirsize.hello` exits 0
```

Correct verdict `rejected`; the criterion passes on precisely the state he is
complaining about.

---

## 7. The rubric: his standing objections, quoted

`src/rubric.ts`, cached at `~/.rlm/agent/outloop/rubric.json`.

This is what makes it *him* reviewing rather than a general-purpose LLM
reviewer, and it is the part that answers "learn from the transcripts".

### 7.1 What it is

Not a summary of the conversation. A short list — expect 8 to 15, given the
corpus size in §12 — of the objections he **repeats**, each carrying his own
words:

```ts
export interface Rule {
  id: string          // "R7"
  objection: string   // one line, the standing objection, in the imperative
  quote: string       // HIS words, verbatim, from a transcript
  source: string      // file + line + ISO timestamp — so it can be looked up
  seen: number        // how many distinct utterances support it
}
export type Rubric = Rule[]
```

Real material is already on disk for this. From the backlog request of
2026-09-02T01:16:30Z (`g-20260902011630-injn.jsonl`), verbatim:

> "A job is done when you have run it and seen it do what was asked —
> dirsize.hello returning hello is not a folder size."

> "And a job you cannot finish stays recorded as owed with the reason, never
> dropped."

and from 00:48:22Z (`g-20260902004822-12i8.jsonl`):

> "A job is not done because a turn ended — run it and check it does what was
> asked, and if you cannot verify it, say you could not."

> "I would rather be asked ten times than find out tomorrow that everything
> stopped and nobody said anything."

Those four are the spine of the rubric and they were written by him, not
inferred. The first is C1's justification in his own voice; the last is why
`unsure` exists (§6.5).

### 7.2 The extraction, and its gate

Given the corpus size, **one model call over the whole filtered corpus** — not a
map-reduce. Feed it every genuine utterance (§12.4), ask for the recurring
objections, one line each plus the quote that supports it.

Then apply the §6.4 gate to the rubric itself:

**Every rule's `quote` is checked as a literal substring of a real transcript
line. A rule whose quote cannot be found is dropped, not repaired.**

That makes the rubric auditable end to end — rule → his words → the line in the
file — and makes a hallucinated standard impossible to install. It also keeps
the artifact short enough for him to read in one sitting, which matters more
than its recall: he can delete a rule he disagrees with, and it stays deleted.

### 7.3 When it is rebuilt

Never inside a review. Build once, cache, rebuild on an explicit command or when
the corpus has grown materially. A rubric that changes under the reviewer makes
two verdicts incomparable and the counts in §6.6 stop meaning anything.

---

## 8. me-1 — second, smaller, and not yet worth building

Its value is generating the next thing to do in his voice. Its risk is
generating plausible work nobody wanted, and that risk is not symmetric with
me-2's: a bad rejection is visible and argued with, while a bad proposal joins a
backlog and is indistinguishable from the real ones a week later.

**Two facts say to wait.**

- The backlog has been handed over about twelve times tonight and zero items
  have come back finished. The last thing that system needs is a machine that
  makes the backlog longer.
- **me-1's entire input corpus today is roughly two dozen utterances (§12.4),
  and the most substantive single one is already an explicit, hand-written,
  fifteen-item numbered backlog** (`g-20260902011630-injn.jsonl`, quoted in
  §12.2). me-1's first act would be to re-derive a list he had just written out
  by hand. There is no gap for it to find yet.

So: specify it, do not build it, and revisit when the transcript corpus is large
enough that he can no longer hold it in his head. That is the condition — not a
date.

### 8.1 The five constraints, all mechanical

When it is built:

1. **It may only propose what he already said.** Every proposal carries a
   verbatim quote from a transcript, gated as a substring of a real line exactly
   as in §6.4 and §7.2. A proposal with no surviving quote is dropped. me-1 has
   no licence to have ideas of its own; it is a re-surfacer, not an inventor.
2. **Its candidates come from a gap, computed mechanically.** Utterances that
   read as asks and have **no corresponding graph goal**. The graph records what
   was asked for; the transcript records what he said; the difference is the
   candidate set. Neither half needs a model.
3. **Repetition is the ranking signal, and it needs no judgement.** Something he
   said three times across two weeks with no graph record is the strongest
   available evidence of unfinished work, and it is detectable with string
   similarity over his own lines. `similarity()`, `shapeOf()` and `judge()` are
   already exported from `@rlm/delegate`'s `lapse.ts` — built to cluster
   failures, and they cluster utterances just as well. The model's only job is
   turning a cluster of near-duplicates into one sentence. It never decides what
   matters.
4. **A proposal is a row, not an action.** It lands through
   `rlmDelegate.intake()`, which records a request verbatim and derives a
   criterion where it can. Where it cannot, the task is `unstated` — and the
   graph *already* surfaces that through `questions()` as one specific sentence
   to put to him. That is exactly the right resting place for a proposal: not "I
   have started this" but "you said this three times; how will we know it is
   done?"
5. **Never auto-commit, and never more than three at a time.** me-1 writes to
   `~/.rlm/agent/outloop/proposals.json`; putting one into the graph is a
   separate explicit step (`outloop.commit(id)`). The graph's entire value is
   that everything in it was actually asked for. A proposer with write access
   dilutes that to *everything in it was plausible*, and there is no way back
   from that.

### 8.2 Separation of powers

**Whoever writes a criterion must not be the one who accepts it.**

me-1 authors criteria for its proposals; me-2 disputes them. Never in the same
call, never in the same run. If one component both proposes the test and blesses
the result, the graph degrades to a single model's opinion with extra steps —
precisely the "second claim standing behind the first" that `graph.ts` refuses
to allow as a proof kind.

### 8.3 Types

```ts
export interface ProposalInput {
  /** His utterances, newest first. See §12.6 for how these are read. */
  said: Utterance[]
  /** Every goal already in the graph, for the gap in §8.1.2. */
  known: string[]
  /** Hard ceiling on how many proposals may come back. Default 3. */
  limit: number
}

export interface Proposal {
  /** One line, in his voice, as the graph's `title` would read. */
  ask: string
  /** HIS words. Gated as a substring of a real transcript line. */
  quote: string
  source: string
  /** How many distinct utterances support it. 1 is allowed but weak. */
  seen: number
  /** A criterion, if one can honestly be named. Otherwise omitted → `unstated`. */
  proof?: Proof
}
```

---

## 9. Reaching a model

Verified against the running machine, not assumed.

### 9.1 `completeSimple`, not `rlmSdk.spawn`

`rlmSdk` has no one-shot path: both `run()` and `spawn()` build a full
`AgentSession` with its own tool set, loop and persistence. Using it for one
question is expensive and non-deterministic.

The one-shot call is `completeSimple` from `packages/ai`. The in-repo precedent
is `packages/coding-agent/src/core/refinement/refinement.ts:930`
(`completeSimple` itself is exported from `packages/ai/src/stream.ts:62`):

```ts
const response = await completeSimple(
  model,
  {
    systemPrompt: REFINEMENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
  },
  { maxTokens: …, signal, apiKey, headers },
)
```

**Omit `tools` from the context and a tool loop is structurally impossible.**
That is the cheapest guarantee in this document: the one-shot-ness is a property
of the call shape, not of a prompt instruction.

### 9.2 Getting `model`, `apiKey`, `headers`

Through `rlmConfig`. `static inject = ["rlmConfig"]` — `config` is row 89 in
`cordis.yml` and `delegate` is row 163, so it is up first either way, but
**inject, do not probe** (§14.5).

```ts
const cfg = this.ctx.get("rlmConfig") as any
const registry = cfg.getModelRegistry()
const settings = cfg.getSettingsManager().getSettings?.() ?? {}

const model = registry.find(settings.defaultProvider ?? "omniroute",
                            settings.defaultModel   ?? "auto/best-free")
if (!model) throw new Error("no model")

const auth = await registry.getApiKeyAndHeaders(model)
if (!auth.ok) throw new Error(auth.error)
```

What is actually configured right now: a single provider, `omniroute`, at
`http://localhost:20128/v1`, `api: "openai-completions"`, `apiKey:
"omniroute-local"` with `authHeader: true` → `Authorization: Bearer
omniroute-local`. Model ids `auto/best-free`, `auto/best-coding`,
`auto/best-reasoning`, `auto/best-fast`, `auto/cheap` and others.
`~/.rlm/agent/auth.json` is `{}`; auth comes entirely from
`~/.rlm/agent/models.json`. The router answers `GET /v1/models` with 200.

**On the banned key:** nothing on this path reads `ANTHROPIC_API_KEY`. The env
lookup table in `packages/ai/src/env-api-keys.ts:99` is keyed by provider and
its anthropic branch is unreachable when `model.provider === "omniroute"`. Keep
it that way: do not add a provider that would reach it, and do not set it on any
child environment.

Two failure modes that do not throw:

- **`completeSimple` returns `stopReason: "error"` with `errorMessage` rather
  than throwing.** Check it. Also check `"length"` — a truncated JSON object is
  not a malformed one and should be reported as truncation.
- **The bare specifier `@earendil-works/pi-ai` does not resolve from a `rlm-*`
  package.** The symlink exists only under `packages/coding-agent/node_modules`.
  Import by relative path — `"../../ai/src/index.ts"` — which is the convention
  `packages/rlm-config/src/index.ts:13` already follows, and works because the
  host re-execs with tsx (`cordis-shell.mjs:101`).

### 9.3 Parsing the answer

Copy `extractJsonObject` from `refinement.ts:607` — a three-stage cascade: bare
`{…}`, then a fenced block, then brace-slicing to recover an object wrapped in
prose; plus `parseJsonCandidate`, which distinguishes truncated from malformed.

**Do not copy `packages/rlm-learn/src/index.ts:487`.** It greedy-matches
`/\{[\s\S]*\}/`, does no shape validation, and silently no-ops when the regex
misses — an `if` with no `else`. Every one of those is a way for a reviewer to
fail open.

After parsing, type-guard field by field with defaults rather than trusting the
shape, then apply the §6.4 gate. Anything that does not survive is `unsure`.

Because `Ask` is injected, every test in §13 runs with a stand-in and no
network — the way `packages/rlm-delegate/workflow.test.ts` stands in for the
planner. `registerFauxProvider` in `packages/ai/src/providers/faux.ts` is
available if a test needs the real call shape without the network.

---

## 10. The service

`packages/rlm-outloop/src/index.ts`, row id `outloop`, added to `cordis.yml`
after `delegate`. `static inject = ["rlmDelegate", "rlmConfig"] as const`.

### 10.1 Surface

| method | does |
|---|---|
| `review(graphId?)` | run me-2 over every unreviewed `done` non-rollup task; record verdicts; return the report |
| `judge(graphId, taskId)` | one task, **records nothing** — for looking before trusting |
| `rubric({rebuild?})` | read or rebuild the standing objections |
| `propose({limit?})` | run me-1; write proposals; record nothing in the graph |
| `commit(proposalId)` | put one proposal into the graph via `rlmDelegate.intake()` |
| `report()` | the last run, as text |

`judge` before `review` is deliberate: there must be a way to watch it decide
before it is allowed to write.

### 10.2 Visibility — he wants to attach and watch

Not a background process with opinions. Three surfaces, all already house style:

1. **The journal.** Every verdict goes through `rlmDelegate.review()`, so it is
   an appended line in `~/.rlm/agent/delegate/<graph>.jsonl` and shows up in
   `render()`, which already prints `accepted by X: reason` under the task.
   Nothing me-2 decides lives anywhere else.
2. **Events**, mirroring the existing names: `rlm/outloop-reviewing`,
   `-verdict`, `-unsure`, `-fabricated`, `-proposed`. `rlm-delegate` emits
   `rlm/delegate-reviewed` when the verdict lands, for free.
3. **A prompt fragment**, registered the way `rlm-delegate` registers its two —
   `registerFragment("rlm-outloop", { id: "under-review", … })`, content read
   from disk at build time, never captured at mount. One effect owns the
   teardowns.

### 10.3 The report

Plain text, one screen, leading with the numbers from §6.6:

```
me-2 — 14 reviewed, 3 rejected, 9 accepted, 2 could not judge
       acceptance 75% over the last 20 — reviewing
       0 fabricated quotes

rejected
  g-2026…-12i8/mount-dirsize   C1 — "give iris a dirsize command"
      the row being ACTIVE says nothing about the command doing anything.
      criterion: row iris-dirsize reaches ACTIVE
could not judge
  g-2026…-c4ia/wire-notch      the request does not say what "working" means here
```

---

## 11. What this deliberately does not do

Each of these is a real gap, named so that not building it is a decision rather
than an oversight.

- **No review of decompositions.** Whether the children of a rollup add up to
  the parent is the natural next question and a different one; rollups are
  skipped in v1 (§2.2.3).
- **me-2 never authors a criterion.** Not for `unstated` tasks, not for
  `questions()`, not as a helpful suggestion attached to a rejection. §8.2.
- **me-2 never reads code, diffs or files** — except the single `stat` F1 needs,
  which reads a timestamp and not a byte of content.
- **No verdict on `unproven` or `failed` work.** The graph already refuses to
  call those done; saying so twice adds nothing.
- **No autonomous scheduling.** Both loops are invoked; neither wakes itself. An
  outer loop that runs on a timer and writes to the graph is the §8 failure mode
  with a cron entry.
- **No compaction layer.** §12.5.

---

## 12. Reconnaissance: the transcripts

Read off disk, not assumed. This is the part that is expensive to rediscover.

### 12.1 `~/.iris/mind/sessions/iris.jsonl`

403 lines, 791,690 bytes, **one continuous session** — exactly one `session`
record, and the `parentId` chain is strictly linear. Range
2026-09-01T11:06:17Z → 2026-09-02T00:53:32Z, about 13h47m.

Discriminator is top-level `type`: 393 `message`, 4 `child_usage_attributed`,
2 `model_change`, 1 each `session`, `thinking_level_change`,
`service_tier_change`, `custom_message`.

Within `message`, the sub-discriminator is `message.role`:

| role | n |
|---|---|
| `assistant` | 197 |
| `toolResult` | 140 |
| **`user`** | **56** |

**His words are at `.message.content[] | select(.type=="text") | .text` where
`.type=="message" and .message.role=="user"`.** Nothing else in the file contains
them. User records have exactly three keys — `role`, `content`, `timestamp` —
and all 56 content blocks are `{type:"text",text}`.

Timestamps: top-level `timestamp` is ISO-8601 and authoritative;
`message.timestamp` is epoch-ms and differs by ~100ms.

**Voice vs typed has no structured field.** Voice turns carry an appended
parenthetical in the same string — 11 of 56 contain `He said this out loud`, in
four variants of `(Context: …)`. Split on `\n\n(Context:`; the text before it is
the utterance and the parenthetical is harness scaffolding. Voice turns are also
recognisable by ASR damage: `"Irish what time is it"`, `"Rahira svimato it"`,
`"Iris Watson my current seaboard"` — that last one is the mishearing that
produced the `iris-watson-seaboard` scaffold he now wants deleted.

Utterance length, raw: min 12, median 68, mean 133, p90 366, max 717 chars.
After stripping the `(Context: …)` trailer: min 4, median 31.5, max 717.

A sibling file `iris.jsonl.bak-1788263525` is a 19-line prefix of the same
session. Ignore it or dedupe against it.

### 12.2 `~/.rlm/agent/delegate/*.jsonl`

Six files, **11 lines total**. Discriminator is `k`: 6 `declared`, 5 `ended`.

A `declared` record's `goal` is 11–12 KB, and almost all of it is the delegation
template — "You are being handed something you could not already do", checklists,
`plugin.new`/`plugin.write` instructions, absolute paths into
`/var/folders/tl/…/T/iris-rlm-*/skills/`. `tasks[0].prompt` is byte-identical to
`goal`, and `tasks[0].title` is the goal's first line, which is template
boilerplate rather than the request.

**The human request is the slice between the `## The request` heading and the
next `## ` heading** — typically 200–1,900 chars.

**Three of six goals contain his words; three do not.** `12i8`, `ew1n` and
`injn` are his — second person addressed to the agent, dated grievances,
personal register. `c4ia` is a system-generated retry wrapper that re-quotes
`12i8` under `## The original request` (a duplicate — dedupe it). `x5v4` and
`x0c6` are harness validator feedback quoting a rejected SKILL.md; **zero human
words**.

Extraction rule: `k=="declared"` → `goal` → slice `## The request` to the next
`^## `. No `## The request` → no human utterance, skip. Only `## The original
request` → a re-quote, dedupe.

The richest of the three is the backlog of 2026-09-02T01:16:30Z, which contains
items 14 and 15 verbatim:

> 14 the me-1 and me-2 outer loops in rlm: one that thinks like me, one that
> reviews like me, both learning from my transcripts
> 15 a stricter-rtk fork for compacting those transcripts

### 12.3 me-2's queue is empty today

Every `ended` record on disk is `state: "unproven"`, with
`attempt.proof: "unstated"` and the reason *"it came back, and nobody had said
how to tell whether it worked"*. There were seven at the time of writing and the
count is climbing as the runner works; what matters is the other number.

**There is not one `done` task in any journal on disk, so `forReview()` returns
nothing.** The cause is visible: these goals are 11–12 KB, and `derive()` only
reads requests under 600 characters, so every one falls through to `unstated`,
which can never pass.

Two consequences for the build:

- me-2 must be proved against constructed cases (§6.7). Step §13.5 will return
  an empty list today, and that is the correct result, not a bug.
- The first real verdict me-2 gives will come after the runner produces a task
  that reaches `done`. Do not treat an empty queue as evidence me-2 works.

### 12.4 How much material there actually is

This is the number that decides §7 and §8.

Of the 56 user records in `iris.jsonl`, most are not him:

| to drop | n | how |
|---|---|---|
| harness liveness pings | ~20 | `^(Say only\|Reply with exactly\|Reply in one short sentence\|reply with just)` — 12 are the identical `"Say only: yes"` |
| agent output injected as `role:"user"` | 2 | starts `You handed the last request to the delegator` — this is the delegator's own transcript wearing a user role |
| exact duplicates | ~4 | retries after failures; dedupe by text |
| `(Context: …)` trailers | 13 msgs | strip the trailer, keep the utterance |

**That leaves roughly 20–24 genuine utterances**, plus 3 unique requests from
the delegate journals, minus one overlap (the `ew1n` goal is the same utterance
as an `iris.jsonl` user message at 00:51:33Z).

**The entire corpus of "what he said" is a few kilobytes.**

The two injected pseudo-user messages are the most dangerous item in that table.
They are `role:"user"`, they are long, they are fluent, and they are the
delegator describing its own work. A rubric built without dropping them would
learn *the agent's* standards and attribute them to him — the exact inversion
this design exists to prevent. Filter by prefix, and gate every quote (§7.2).

### 12.5 Does the `stricter-rtk` fork need building? Not for this.

He asked for it (item 15 above), so this is not a recommendation to drop it —
only a measurement of whether me-1 and me-2 need it.

They do not, for three reasons:

1. **The input is already small.** A few kilobytes fits in one prompt with room
   to spare. There is nothing to compact.
2. **The reduction these loops need is not compaction.** It is *extraction of a
   short list of standing objections, each with a verbatim quote* (§7). That
   output is 8–15 lines whether the input is 8 KB or 8 MB, and its correctness
   comes from the substring gate, not from the quality of any upstream summary.
   A general-purpose compactor would sit between the loops and the only thing
   that makes them trustworthy — his exact words — and paraphrase it.
3. **A lossy stage before a quote gate is actively harmful.** If the compactor
   rewrites `"dirsize.hello returning hello is not a folder size"` into
   something tidier, the quote no longer appears in any transcript line, the
   gate drops the rule, and the rubric silently loses its best content.

What *is* needed is the filtering in §12.4 — twenty lines of string
predicates — and the `## The request` slice in §12.2. Both are deterministic and
neither needs a model.

Revisit if the corpus grows past what one prompt holds. Judge that by measuring
the filtered corpus, not the raw file size: `iris.jsonl` is 791 KB and 97% of it
is assistant reasoning and tool output that these loops must never read.

### 12.6 `transcripts.ts`, concretely

```ts
export interface Utterance {
  text: string      // his words, trailer stripped
  at: string        // ISO
  source: string    // "iris.jsonl:317" | "g-2026…-injn.jsonl:1"
  spoken: boolean   // the "He said this out loud" marker was present
}

export const readIris = (path: string): Utterance[] => { /* §12.1 + §12.4 filters */ }
export const readDelegate = (dir: string): Utterance[] => { /* §12.2 slice + dedupe */ }
```

Keep `source` precise enough to look up by hand. It is what makes a rubric rule
checkable in one command, and a rule nobody can check is a rule nobody can
delete.

---

## 13. How to prove it

In this order. Each step runs with
`/Users/abhi/.local/share/fnm/node-versions/v22.23.1/installation/bin/node
--experimental-strip-types`, matching how `rlm-delegate`'s three suites run.

1. **`survey.test.ts` — no model, no graph.** F1 fires on a file older than
   `startedAt` and not on one newer. F2 fires on `exit 0`, `true`, `:`,
   `echo hi`, and not on `echo hi && test -f x`. Each of C1–C6 fires on a
   constructed pair and stays silent on its negation.
2. **`reviewer.test.ts` — a stand-in `Ask`.** The three cases in §6.7. A model
   answer quoting words absent from the request is downgraded to `unsure` and
   counted as a fabrication. A malformed answer is `unsure`. **A floor rejection
   never calls `ask` at all — assert the stand-in was not invoked.**
3. **`transcripts.test.ts`.** The 12 `"Say only: yes"` pings are dropped, the two
   `You handed the last request to the delegator` messages are dropped, the
   `(Context: …)` trailer is stripped but the utterance kept, and the
   `## The request` slice returns the backlog text and not the template around
   it.
4. **`rubric.test.ts`.** A candidate rule whose quote is absent from the corpus
   is dropped; one whose quote is present survives with the right `source`.
5. **Against the real journals, read-only.** `judge(graphId, taskId)` over
   `~/.rlm/agent/delegate/`, recording nothing. **Expect an empty list today**
   (§12.3) — that is the correct result, and it is why steps 1–2 carry the
   proof.
6. **Then record.** `review(graphId)` on one graph, once the runner has produced
   a `done` task. Confirm the verdict is in the journal and in `status(graphId)`,
   and that a rejection does what §2.2.2 says to its dependents.
7. **Only then me-1**, and only under the condition in §8.

---

## 14. Traps

1. **`accepted` un-rejects.** §2.2.1. Never sweep-accept.
2. **A rejection takes dependents with it** — `unreachable` for the unstarted,
   `tainted` for the finished. §2.2.2.
3. **Rollups are true by construction** and will be handed to you as candidates.
   Skip them. §2.2.3.
4. **Already-reviewed tasks stay in `forReview` forever** — the `reviewed` field
   is populated, not filtered. Filter it yourself, or me-2 re-reviews the same
   task every run and the counts in §6.6 become meaningless.
5. **`inject`, do not `ctx.get`,** for `rlmDelegate` and `rlmConfig`. A
   registration into another service dies when that service reloads and does not
   come back; injecting puts the fiber into PENDING and re-runs `apply` when it
   returns. That is the whole re-attach mechanism and it is free.
6. **`inject`'s object form maps service name → intercept config.** There is no
   `{required, optional}`; writing that waits forever, silently, for services
   literally named "required" and "optional".
7. **One effect at init, owning a `Set` of teardowns.** An effect registered
   later is never released. `rlm-delegate/src/index.ts` shows the shape and says
   why in a comment.
8. **`completeSimple` does not throw on a provider error** — it returns
   `stopReason: "error"` with `errorMessage`. Check that and `"length"` before
   touching `content`. §9.2.
9. **`@earendil-works/pi-ai` does not resolve from a `rlm-*` package.** Relative
   import, `"../../ai/src/index.ts"`. §9.2.
10. **Do not copy `rlm-learn`'s JSON parsing.** Greedy regex, no validation, and
    a silent no-op on a miss. Copy `refinement.ts`. §9.3.
11. **Two of the 56 `role:"user"` records are the delegator's own output.** A
    rubric that ingests them learns the agent's standards and attributes them to
    him. §12.4.
12. **`iris.jsonl` is 791 KB and 97% of it is not his.** Never feed the file to a
    model. Filter first, always. §12.4.
13. **Read the rubric and every prompt fragment at use time, not at mount.** A
    captured copy goes stale and the prompt then teaches something untrue — the
    reason `skeletonFragment()` re-reads its file on every build.
14. **Never `console.log`.** `ctx.logger`.
15. **Never `ANTHROPIC_API_KEY`,** in any file or child environment. §9.2.
16. **Do not touch `packages/rlm-delegate`** while the runner is being built
    there. Everything above is achievable from outside it; §2.1 is the one
    tempting exception and the workaround is one extra call.
17. **Do not leave the tree unbootable, even for one save.** rlm hot-reloads what
    is written and an unresolvable import stops the boot. Add
    `packages/rlm-outloop` complete and passing *before* adding its row to
    `cordis.yml`.
18. **A schema default is evaluated at module load.** No `join(homedir(), …)`
    inside a config default; resolve at the use site.

---

## 15. Suggested order

1. `contract.ts` — §3. Types only; nothing to run.
2. `survey.ts` + `survey.test.ts` — §5, §13.1. **Stop here and look.** The floor
   alone is deductive and already worth shipping.
3. `reviewer.ts` + `reviewer.test.ts` — §6, §13.2, with the seeded fault.
4. `transcripts.ts` + `transcripts.test.ts` — §12.6, §13.3. Filters only.
5. `rubric.ts` + `rubric.test.ts` — §7, §13.4. One model call, cached.
6. The service — §10 — with `judge()` working before `review()` can write.
7. The row in `cordis.yml`, last.
8. me-1 — §8 — not until the condition in §8 is met.

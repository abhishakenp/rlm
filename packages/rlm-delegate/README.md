# @rlm/delegate

A durable task graph for the delegation loop, so a task cannot be forgotten and
a turn ending cannot pass for work being done.

## Why

Two failures, from one night, both structural:

- Six jobs arrived in one request. One was done. The other five ended when the
  process did, and there was no queue, no list and no "still to do" anywhere on
  disk to say they had ever been asked for. A request was a string handed to a
  process; whatever that process did not do went with it.
- Nine turns in a row ended with the word "Done" and nothing had been built.
  `iris-dirsize` was announced as a capability while its only command was still
  the scaffold's `hello`. Every one of those reports was true — a turn *had*
  ended — and nothing anywhere asked whether the work had happened.

So the loop no longer owns the list, and no longer takes an agent's word for it.

## The floor

The graph could not forget, but that was worth nothing while nothing ever
created one. The delegator reached the model as a prompt fragment saying a graph
was available — which is a protocol a model has to remember to follow, which is
the thing that failed in the first place.

So the recording happens at the boundary, in `rlm-modes`, in four lines, before
the model runs:

```ts
const recorded = graphs?.intake?.(prompt, { source: "--print" }) ?? null;
```

Every caller passes through there, Iris included (`node cordis-shell.mjs
--print "…"`). It needs no plan, no decomposition and no model call, so it still
happens when the model is unavailable, confused, or lying — verified by killing
the session mid-run and finding the request and the failure both on disk.

What it records is one task holding the request verbatim, and a criterion read
out of the request itself — mechanically, with no model:

| the request says | the criterion becomes |
|---|---|
| "build me an X plugin" | the row `X` reaches ACTIVE — written to disk is not mounted |
| "add a command that does `y.z`" | `y.z` is in the registry afterwards |
| "fix `path/to/Z`" | `path/to/Z` is not the file it was (`changedSince`) |
| "make \`npm test\` pass" | that command exits 0 |

Where nothing is confident it falls back to `unstated` — *nobody has said how to
tell* — which can never pass. That is a **last** resort, and it is a question,
not a conclusion. A turn that comes back on an unstated criterion ends
`unproven`; a turn that does not come back ends `failed`.

Deriving can never refuse a request: a bad guess produces a task that fails
loudly, which is recoverable, while a throw at the boundary would stop work
being handed over at all.

**It only reads requests short enough to be an ask (600 characters).** This was
learned against real traffic, over three rounds. Iris's standard preamble runs
to a hundred lines and is full of example commands — `iris plugin.new`,
`iris plugin.revert`, `iris recall.match text="…"` — none of which is a
criterion, and every guard that suppressed one promoted the next. The rules were
not the problem: pattern-matching emphasis markers inside a document written to
*instruct* is reading someone else's mail. A person asking for something writes a
line or two; anything longer is a template, and the honest answer to a template
is that nobody said. It is also the request most in need of `refine()`, which
uses a model that can actually read it.

`refine(graphId, taskId, tasks)` is the improvement on top: a model reads the
recorded request and turns it into real tasks with real criteria and real edges.
The parent becomes a `rollup` — done when everything it was broken into is done,
checked for free, run by nobody. **The floor is mechanical; the refinement is
optional.** If nothing ever refines, the request is still on disk.

## What a task is

```ts
{
  id: "mount-dirsize",
  title: "give iris a dirsize command",        // the asker's words — the record that survives
  prompt: "...",                                // what an agent is handed
  needs: ["write-dirsize"],                     // real edges, refused if they form a cycle
  proof: { kind: "command", name: "dirsize.of" } // mandatory, mechanical
}
```

`proof` is not optional. A task nobody can tell is finished is refused at
declaration, the same way a cycle is. The four kinds are all things the graph
can run itself — `shell` (exits zero), `file` (exists / contains), `row` (a
composition row reached ACTIVE), `command` (a name is really in the registry),
`rollup` (everything it was broken into is done), and `unstated` (nobody said,
so this can never pass) —
because a criterion is only worth anything if it still answers when the model is
down and the agent is confidently wrong.

There is deliberately no "ask a model whether this looks right" kind. That is a
second claim standing behind the first and it fails in the same direction.

## States

```
blocked → ready → running → done
                          ↘ unproven      came back; nobody had said how to check
                          ↘ failed        tried, did not work, says why
                          ↘ rejected      criterion passed; a reviewer disputed it
        unreachable                       something it needs died
```

**`unproven` counts as still owed.** An earlier version of this package left it
out on the grounds that it would drown the live work; that was the wrong trade.
`unproven` means a turn ended and nobody can tell whether the work happened —
which is not a quieter kind of success, it is the exact failure this package
exists to prevent. Nine turns in one night ended with "Done" and nothing was
built; in these terms those were nine unproven tasks everybody read as finished.
If there are too many to read the answer is to group and count them, which the
prompt does, never to stop saying them. It is also dead for dependents: work
that came back with no way to check it is not a foundation. And it never ages
out — only a journal where every task is *proven* done is a receipt.

## Nothing rests in a state that reads like success

Either a task is proven done, or it is visibly owed with something able to try
again, or **a person has been asked a specific question**. `questions()` returns
the third case as data — each unstated criterion with the sentence to put to
whoever asked — and `answer(graphId, taskId, proof)` records the reply, replaces
the criterion, and puts the task back into the pool so something tries again.

The asking itself is not done here; it belongs to whatever is actually talking
to him. What is guaranteed here is that the question exists, is specific, and
does not go away on its own.

`unreachable` is derived from the edges, never stored as a decision — so a
dependent comes back on its own if the thing that failed is later fixed. A
dependent is never deleted and never quietly counted as done: it sits in the
graph naming what stopped it. Work that had already finished on top of something
that later died keeps its `done` (its own criterion did pass) but is marked
`tainted`, because "true and useless" is the exact shape being guarded against.

## The reviewer's seam

The graph answers one question: *did the declared criterion pass?* It cannot
answer whether the criterion was worth passing — a criterion written to be easy
is invisible from down here. That is judgement, it belongs above, and it plugs
in here:

```ts
interface Reviewer {
  review(task: Task, graph: Graph): Promise<{ verdict: "accepted" | "rejected"; reason: string }>
}
```

`forReview(graphId)` hands a reviewer each finished task with its criterion in
words and the evidence that satisfied it; `review(graphId, taskId, verdict, by,
reason)` records the answer. A rejection is treated exactly like a failure. No
reviewer is implemented here.

## The drive — the part that is not asked

Everything above could not forget, and the backlog still did not move, because
all of it waited to be asked. `run(graphId)` needs a graph id from somebody who
went and looked; nothing ever went and looked. Iris was handed the same fifteen
jobs roughly twelve times in one night and finished none of them.

`drive()` is the loop that is not asked. It reads what is owed off the disk,
across **every** graph, works all of it against one shared budget, and comes
back with each task either proven done or stopped with a specific question
against its name.

```
rlm drive            work everything that is owed
rlm drive --follow   and keep waiting for more
rlm drive status     what is owed, and what is waiting on him
rlm drive stop       stop it, now
rlm drive resume
```

It is bounded three ways, independently: attempts per task, sweeps per run, and
a stop file it re-reads before every single task. A sweep only happens because
the last one changed something — `fingerprint()` compares the whole store before
and after — so "nothing moved" ends the run instead of repeating it.

### Refining first, because a paragraph is not a criterion

On real traffic every recorded request is fifteen jobs written as prose, and no
single command exits zero when "the backlog" is done. So before the drive gives
up on a request nobody can judge, it asks a model for the one thing a model is
needed for: what the separate jobs are, what each depends on, and how anybody
could tell each is finished. Only on `unstated`, only written down if the graph
accepts the plan — a decomposition that gets refused leaves the task exactly as
it was, because a bad plan on disk looks like progress.

The ask is cut out of the envelope first (`askIn`). Her preamble is eleven
kilobytes; his words are the two lines under `## The request`. Handing a planner
the whole envelope gets a plan for the instructions.

### What a retry is, and is not

Not the same prompt. Not the same prompt with the error stapled to it either —
that is the same attempt with more words. Which **carrier** of the guidance
failed decides what changes, the way `@iris/lapse` decides it: `standing` (the
task text, written before anybody tried), `in-turn` (the failure carried next to
the decision), `posthoc` (the criterion — it can refuse, it cannot redirect) and
`affordance` (whether the thing reached for was there at all).

| what the last failure was | the cause | what the next attempt is told |
|---|---|---|
| it was killed, or ran out of time | `cut-off` | it was not refused — do the smallest provable piece first, and check what is already there |
| it reported done, the criterion said no | `only-after-the-fact` | run the check yourself before saying anything |
| what it reached for was not there | `not-offered` | establish what *does* exist first; that route is closed |
| anything else, first time | `never-carried` | here is how it failed |
| the same shape survived a changed approach | `exhausted` | nothing — this is a question now |

`cut-off` is not a nicety. A fifteen-minute delegation ceiling killed every
multi-task backlog partway through, and each one came back as a failure whose
sentence said nothing about time; reading those as refusals is how a bound gets
mistaken for incapacity.

### When it stops and asks

The judgement is written out in `impasse.ts`, and it is a rule about
information, not effort: **another attempt is worth making only if it would have
something the last one did not.** New failure shape → hard, retry. Repeated
shape → hard, but a different carrier gets it. Same shape after a changed
approach, or the budget spent → stop and ask.

Three things are asked about with no attempt spent at all, because no attempt
could move them: nobody said how to tell (a standard cannot be invented from
below); the criterion cannot be *run* from here (the work may well be done —
retrying it does not make the checker able to see); and it stands on something
that died. Every one of them is a question with the sentence to put to him, on
disk in `QUESTIONS.md`, and answering any of them puts the task straight back
into the pool.

### Stopping it

A file, the way `@iris/autonomy` does it, because it has to work when you are
annoyed and not at a terminal:

```
~/Desktop/.rlm-drive-off      this drive        (`rlm drive stop` writes it)
~/Desktop/.iris-autonomy-off  Iris's own switch (honoured, never written)
```

Checked with `existsSync` before every task and on a one-second poll, never
cached. The drive's own abort signal reaches the runner, so a fifteen-minute
attempt already in the air is killed too — and the default runner kills the
whole process group, because rlm re-executes itself under tsx and killing the
child alone leaves the grandchild holding the machine.

Attempts run in their own process. A task hands the machine to an agent that
spawns things and writes files; when that goes wrong it should take a child down
and not the thing keeping the list. `RLM_DELEGATE_CHILD` is set in that child so
its `--print` is not recorded at the door as a fresh request — without it,
working the backlog lengthens it, once per attempt, for ever.

## Parallelism, and the queue

Two tasks with no path between them run at the same time — the graph is what
makes that safe. How many run at once is measured from the machine, not
configured, and re-measured between tasks:

- **file descriptors**, first, because that is what actually wedged this
  machine — fourteen hours with hot reload silently dead at 380 open against a
  soft limit of 256, the fiber reporting ACTIVE throughout;
- **memory**, via `vm_stat` on macOS, because `os.freemem()` counts only wholly
  free pages there and reads 1% on a healthy machine;
- **load average**, the slowest signal, but the one that means "the laptop is
  lagging" to the person using it.

Below 20% headroom on any one of them the limit drops to one. It is never zero.
Anything over the limit **waits in the journal as `ready`** — it is never
refused. A refusal that reaches nobody is how five of six jobs disappeared.

`concurrency` accepts a number to pin it, or a function; that function is the
seam a remote pool replaces later.

## Retry

An agent that failed the same way twice will fail the third time. Each failure
is fingerprinted — first line, identifiers stripped, Dice similarity over the
words, the same clustering idea as `@iris/lapse` in the Iris tree — and once a
shape repeats, the task stops with the shape recorded rather than being handed
back. A retry that does happen is never the same prompt: how the last attempt
failed is carried into the task text itself, next to the decision.

## Durability

An append-only JSONL journal, one file per graph, in rlm's own home
(`~/.rlm/agent/delegate/`) — never the working directory, because delegations
run in throwaway temp dirs and a list of jobs deleted with the workspace is the
same bug wearing a hat. State is a fold over the lines. A crash loses at most
the line being written; a torn line is dropped on read and closed before the
next append. A task a dead process was holding is put back into the pool, as a
journalled fact rather than a rendering.

## Service API

| Method | Does |
|---|---|
| `intake(request, {source})` | The floor. One task, the request verbatim, criterion `unstated`. Never throws at the caller. |
| `refine(graphId, taskId, tasks)` | Break a recorded request into real tasks; the parent becomes a rollup. |
| `close(graphId, taskId, {ok, detail})` | Record how the turn went: `unproven` if it came back, `failed` if it did not. |
| `unverified(sinceMs?)` | Turns nobody could check — the wounds. |
| `questions()` | Every job waiting on one sentence from a person, with the question. |
| `answer(graphId, taskId, proof, by?)` | Record how to judge it, and put it back into the pool. |
| `declare(goal, tasks, id?)` | Write down what was asked. Throws — before writing — on a cycle, an unknown dependency, or a missing criterion. |
| `add(graphId, tasks)` | Extend a graph, refusing a cycle across the whole thing. |
| `run(graphId, runner?, options?)` | Work one graph. Defaults to `rlmSdk.spawn` per task. |
| `drive(options?)` | Work **everything** that is owed, unasked, until proven or asked. |
| `impasses()` | Everything that is stopped and needs one sentence from a person. |
| `stop(why?)` / `resume()` / `stopped()` | The kill switch, as a file. |
| `status(graphId?)` | A one-screen account, including what did not happen. |
| `open()` / `ids()` / `get(id)` | What is still owed. |
| `verify(graphId, taskId)` | Run one criterion now, without touching the graph. |
| `capacity()` / `explainCapacity()` | The limit, and its reasoning. |
| `review(...)` / `forReview(id)` | The reviewer's seam. |
| `owedFragment()` / `skeletonFragment()` | The two prompt contributions, as text. |

Events: `rlm/delegate-intake`, `-declared`, `-refined`, `-began`, `-done`,
`-unproven`, `-retry`, `-failed`, `-recovered`, `-capacity`, `-reviewed`,
`-settled`, `-outstanding`, `-answered`.

Journals are pruned after a fortnight — but only the receipts. A journal with
anything failed, unreachable, rejected or still runnable in it is evidence and
stays whatever its age.

## The prompt

Two fragments, both read from disk when the prompt is built and never at mount:

- **Still owed** — what was asked and is not finished. A memory nobody reads is
  a log file.
- **The loop, as it currently is** — the live source of
  `~/.rlm/agent/workflows/delegator.ts`. Read at runtime on purpose: a pasted
  copy goes stale and then teaches a flow that no longer exists.

## Tests

```
node --experimental-strip-types packages/rlm-delegate/index.test.ts
node --experimental-strip-types packages/rlm-delegate/intake.test.ts
node --experimental-strip-types packages/rlm-delegate/workflow.test.ts
node --experimental-strip-types packages/rlm-delegate/drive.test.ts
```

The first proves the graph cannot forget — including a child process that really
does `SIGKILL` itself mid-graph. The second proves the boundary records a request
before the model runs, and still records it when the model throws. The third
drives the delegator workflow end to end against a stand-in for the model. The
fourth is the drive: three owed tasks across three graphs finished unattended
with every criterion re-run afterwards by somebody else, a criterion that cannot
pass bounded and turned into a question, a retry whose difference from its
predecessor is journalled and pointed at, and the stop file killing an attempt
that was already in the air.

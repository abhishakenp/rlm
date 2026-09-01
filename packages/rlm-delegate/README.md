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
composition row reached ACTIVE), `command` (a name is really in the registry) —
because a criterion is only worth anything if it still answers when the model is
down and the agent is confidently wrong.

There is deliberately no "ask a model whether this looks right" kind. That is a
second claim standing behind the first and it fails in the same direction.

## States

```
blocked → ready → running → done
                          ↘ failed        tried, did not work, says why
                          ↘ rejected      criterion passed; a reviewer disputed it
        unreachable                       something it needs died
```

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
| `declare(goal, tasks, id?)` | Write down what was asked. Throws — before writing — on a cycle, an unknown dependency, or a missing criterion. |
| `add(graphId, tasks)` | Extend a graph, refusing a cycle across the whole thing. |
| `run(graphId, runner?, options?)` | Work it. Defaults to `rlmSdk.spawn` per task. |
| `status(graphId?)` | A one-screen account, including what did not happen. |
| `open()` / `ids()` / `get(id)` | What is still owed. |
| `verify(graphId, taskId)` | Run one criterion now, without touching the graph. |
| `capacity()` / `explainCapacity()` | The limit, and its reasoning. |
| `review(...)` / `forReview(id)` | The reviewer's seam. |
| `owedFragment()` / `skeletonFragment()` | The two prompt contributions, as text. |

Events: `rlm/delegate-declared`, `-began`, `-done`, `-retry`, `-failed`,
`-recovered`, `-capacity`, `-reviewed`, `-settled`, `-outstanding`.

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
node --experimental-strip-types packages/rlm-delegate/workflow.test.ts
```

The first proves the graph cannot forget — including a child process that really
does `SIGKILL` itself mid-graph. The second drives the delegator workflow end to
end against a stand-in for the model.

# @rlm/olympus

A software factory for shipd.ai Olympus quests.

The platform charges tokens for every check it runs. This package replicates
those checks locally — using the platform's own extracted rubric prompts, not
reimplementations — so a submission is only sent once it is already known green.

## Why the stages are ordered by cost

```
rlm olympus status
```

Eight stages are free. One (`difficulty`) costs an a2 codex rollout. One
(`submit`) costs shipd tokens. Each expensive stage refuses to run until every
free stage ahead of it is clean, and `submit` additionally refuses unless a
*measured* pass rate is under the bar.

## The one gate that cannot be faked

`difficulty` must run the real solver. The platform's Nova agent is `codex_cli`
on `gpt-5.6-sol`, and the harness in `tools/codex_rollout.sh` reproduces it
byte-for-byte: same prompt shape (`# {title}\n\n{description}`), isolated
`HOME`/`CODEX_HOME` so local skills cannot contaminate the run, `high` reasoning
effort, and grading inside the real Olympus base image.

Do not substitute a cheaper model here. A Sonnet/Haiku proxy scored one task at
50% that the platform's own agent then solved 4/4 — the proxy was wrong in the
direction that costs tokens.

## Usage

```
rlm olympus status                    # the pipeline, cost per stage
rlm olympus mine                      # eligible repos + hard candidate issues
rlm olympus gates <dir>               # every free gate                (free)
rlm olympus difficulty <dir> [n]      # measured pass rate             (a2 rollouts)
rlm olympus submit <dir> [--live]     # prints the command; --confirm sends it
```

A candidate directory holds `description.txt`, `test.patch`, `solution.patch`,
`Dockerfile`, `image.txt`.

## Bars

|  | tutorial | live |
|---|---|---|
| pass rate | ≤ 50% | ≤ 20% |
| runs | ≥ 6 | ≥ 10 |
| median LOC | ≥ 150 | ≥ 400 |
| median files | ≥ 2 | ≥ 3 |

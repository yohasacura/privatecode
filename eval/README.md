# The eval

Fifteen tasks on two real projects, each checked by things the model never sees. One
command, one table, a number that says whether a change to the agent made it better.

```bash
npm run eval --prefix core                                   # every task, the default profile
npm run eval --prefix core -- --gates fast                   # under a profile
npm run eval --prefix core -- --only logger-rotation,bp-quote-cost-total
npm run eval --prefix core -- --workspace winopt             # one project's tasks
npm run eval --prefix core -- --label after --baseline eval/results/before.json
```

It needs the llama.cpp server running (`LLAMA_URL`, default `http://127.0.0.1:8080`), the
.NET SDK, and the two projects at `D:\Projects\WindowsOptimizer` and `D:\Projects\black-port`
(`EVAL_WINOPT` / `EVAL_BLACKPORT` point elsewhere). The originals are only ever **read**:
every task works in a fresh copy under the system temp folder, rewritten so it builds
offline, and removed when the task is done (`--keep` leaves it for a look).

Tasks run one after another — the server has one slot. The whole set is 30–60 minutes
depending on the gate profile.

## What a task is

`tasks.ts` holds them. Each is a request in the words a person would use, plus checks:

- **build** — the project's own `dotnet build` passes afterwards
- **hidden tests** — xunit tests from `hidden/<task>/` are dropped into the test project
  *after* the model finishes and must pass, along with every existing test (so a change
  that breaks something else fails too)
- **grep** — named strings present in named files, for the tasks whose project has no test
  harness wired for hidden tests yet

A bugfix task **plants** its bug into the copy first, so the fix is measured against a defect
that really is there. WindowsOptimizer (32 files, WPF) carries the ten tasks with hidden
tests; black-port (two folders, ~600 files, ASP.NET + Next.js) carries five checked by build
and grep.

## What comes out

`results/<label>-<stamp>.json` has everything (per task: every check with its detail, steps,
seconds split into model time and gate time, reads, writes, builds, compiler checks, the
final text). `results/<label>-<stamp>.md` is the table, and the failures with their
reasons. `--baseline` prints what changed against an earlier JSON.

The exit code is 0 only when every task passed.

## Adding a task

Add an entry to `tasks.ts`; for a WindowsOptimizer task, add a test class under
`hidden/<task-id>/` in the namespace `WinOptimizer.Tests.Eval`. A hidden test should reach
new members by reflection (`typeof(Snapshot).GetProperty("SavedAt")`) so a model that named
things differently fails the test rather than the compile of every other test.

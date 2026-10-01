# Driving the real window, 2026-08-22

Everything below was done in the running app, not in a test: `core` on the dev WebSocket
bridge (`npm run host:dev`), the frontend on vite, a real workspace, and the real
llama.cpp server. The point was to find out which of the day's fixes are actually true
where a person would see them, and one open bug was hit by accident on the way.

Setup, for repeating it:

```
npx tsx core/src/host/ws-bridge.ts --workspace <dir> --port 7777   # prints ws://…?token=…
npm run dev --prefix app                                           # vite on 1420
# then open http://localhost:1420/?ws=<the ws url, percent-encoded>
```

## What was exercised, and held

| | |
|---|---|
| boot, three columns, Workspace / History / Terminal tabs | ok |
| git panel: dirty files, staging, commit box | ok |
| a task-shaped send distils a contract and seeds a 5-item plan | ok |
| the understanding check fires before the first write | ok |
| approval card in auto-edit: edits pass, `run_command` asks | ok, and the turn genuinely parks |
| Allow → the command runs and the turn resumes | ok |
| two `write_file` calls batched into one step, with the live `writing · N chars` readout | ok |
| the work itself | correct: `clamp.js` handles `min > max`, and its own test exits 0 |
| the turn ends through the whole gate chain | `verified with contract check — passed`, then `verified with independent diff review — passed` |
| the plan card retires when the contract is satisfied | ok — the 5-item card cleared itself |

Two of the day's fixes were confirmed where they live rather than in a unit test:

- **The understanding check's options are OUTCOMES again** — "clamp(5, 10, 0) returns 10",
  "node src/util/clamp.test.js exits with code 0". That is the R1 regression (a
  `response_format` schema is never rendered, so the rules written in it reached the model as
  zero tokens) visible from the outside: while it was broken the same card offered steps and
  file names.
- **The acceptance gate renders as "verified with contract check — passed"**, and the string
  `exited ?` appears nowhere in the transcript. A gate has no exit code, and the reducer's
  fallback for a failed check used to print one.
- **Ctrl+K over the Switch-workspace dialog opens nothing.** Before the fix it opened a
  palette *underneath* the dialog, whose autofocused input then swallowed every keystroke.

Console is clean apart from three `@tauri-apps/api` errors (`invoke`,
`transformCallback`) — expected when the frontend runs in a plain browser with no Tauri
runtime, not app faults.

## What the run turned up

**"None of these" was unanswerable.** The question card is a multi-select whose Answer
button stays disabled until something is ticked, so a person who wanted none of the contested
readings could only tick something they did not want or leave the turn parked — while
`session.ts` carried a `'They did not want any of them.'` branch nothing could reach. This is
the first audit's Tier-B item, reached here by hand rather than by reading.

Fixed by offering it as a real option (`NONE_OF_THESE` in `understanding.ts`) rather than by
enabling an empty submit: an empty answer already means something else on that path — abort,
a queued run's parked reply, no answer at all — and has to keep meaning "keep the reading you
had, touch nothing". `foldAnswer` excludes the sentence explicitly, because otherwise its own
free-text branch would adopt it as a done-criterion reading "None of these — just do what we
agreed above".

**A second task in one session keeps the first task's plan.** Sending a new task-shaped
message replaces the contract (by design) while `seedTodos` deliberately refuses to clobber
an open plan — so the model ran with a contract about one thing and a plan about another, and
said so in its own reasoning: *"the todo list items are about invoices.ts. The current task is
about clamp."* Not fixed here. It is the same seam the first audit flagged from the other
side (any 220-character paste replaces a running contract), and the two want deciding
together: either a new contract retires the old plan, or a task-shaped message that arrives
over an unsatisfied contract is not a new task at all.

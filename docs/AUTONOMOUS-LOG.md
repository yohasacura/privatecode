# Autonomous work log

Started 2026-08-05. Running until explicitly stopped.

The rule this log exists for: **conversation memory does not survive compaction, git does.**
Anything marked DONE here is committed and verified — do not redo it. Resume at the first
item that is not DONE.

Standing constraints carried from the user, never lifted:

- Deployment is off the table. The release `.exe`, the port-8080 firewall rule and
  `docs/INSTALL.md` stay untouched.
- Balanced unit tests are fine. ONE review round per task, no review-on-review.
- Measure before claiming. Every finding in this project was established by running
  something, not by reading.

## Queue

**All 15 confirmed audit findings are closed** (a759855, 687c671, 3a6fea1, 9230577).
The long-run hardening item is done. What is left below is the throughput item and
whatever the next audit finds.

Next worth doing, in rough order:

1. ~~**Re-audit.**~~ DONE (wf_32665d58-487): 23 raised, 19 confirmed, 4 refuted. Six fixed in
   d54267e, including TWO inside a759855 — the commit whose entire subject was fixing things.
   Auditing your own morning's work before building on it is not optional; it found data
   corruption and a fix that covered every path except the one it was written for.

   All of it is now closed except one, in 5cf1ef8: the cold-cache flag cleared by a cancelled
   step, the rewind that disabled "Put back", `suppressedId` blanking a row of a VIEWED
   session, eviction deleting the user's terminal scrollback, and the streaming test that
   proved nothing (it drove two `tool.call` events for one step — a sequence the core could
   not emit; rewritten to call/result/call/result, and it now checks each card keeps its OWN
   outcome).

   The last two (Terminal tab + collectChanges) are closed in ae522bc. **Every confirmed
   finding from both audits is now fixed.**

   Also fixed on the way: `background-task`'s grandchild test slept a fixed 1500 ms for a
   process to start and failed in full runs while passing alone. Verified against a stash
   that it fails without any of today's changes. It waits for the effect now.
2. ~~**A long live run.**~~ DONE — `core/test/integration/long-turn.test.ts` (d0d324b).
   Two compaction swaps inside one real turn, 253 s, against Qwen3.6. Task completed on the
   far side of having its history replaced twice; flush held; zero orphaned tool replies in
   the rebuilt transcript. Run it with
   `npx vitest run --config vitest.integration.config.ts test/integration/long-turn.test.ts`
   from `core/`, with the server up.

   The lesson worth keeping: the first attempt set the pretend window to 12,000 and proved
   nothing. `compactIfOverWindow` does nothing below 26,400 by design, so the mid-turn path
   never ran — the BACKGROUND trigger fired instead and the output looked plausible. A run
   that exercises none of the code under test is exactly what this kind of test is for.
3. ~~**Execute the tool calls the model proposes.**~~ DONE (6f116d0). The estimate was ~20%;
   measured against the live model it is **53% of the wall clock and 74% of the steps** —
   37.7 s / 10.3 steps before, 17.8 s / 2.7 steps after, n=3 per arm, four independent
   single-line edits to four files, every arm completing all four.

   The estimate was low because it counted only what the OLD behaviour wasted (8% discarded
   arguments + 23% redo steps). It could not count the model batching MORE once the prompt
   stopped saying "use exactly one tool" — which is where the rest of the win is. Both halves
   were needed: the loop change alone, with the old prompt still in place, is arm C.

   Three arms were measured rather than two, and the third is the reason the number is
   trustworthy: arm B (new loop, new prompt, execution restricted to `calls[0]`) came out at
   37.0 s, which is indistinguishable from arm C's 37.7 s. Had I stopped at A vs B I would
   have reported the same figure while comparing against a prompt that does not exist.

   The defect this turned up is the one worth remembering, and it was in a CONSUMER, not in
   the loop: `replayEntries` emitted all of a step's calls and then all of its results, while
   the window pairs them by recency. Three calls in a step meant the first result landed on
   the last card — a restored session showing every multi-call step's results in reverse.
   Harmless while only skipped calls were ever multiple; the shape of every long turn now.
   Found by walking every consumer of `onToolCall`/`onToolResult` before committing, which is
   exactly what the third audit said to do for a change of this shape.

   **The consumer walk, stated** (5f71a7a). Every consumer of `onToolCall`/`onToolResult`,
   and what each one sees now that a step can run several calls:

   | consumer | what it sees | verdict |
   |---|---|---|
   | `host.recordToolOutcome` | one line per call id, incl. the halted one | **was broken** — see below |
   | `Session.captureToolResult` -> work log | one "Ran" line per command, own args | correct, now tested |
   | `Session.notePathWritten` -> `writtenMounts` | every folder written in the step | correct, now tested |
   | `Session.turnFootprint` | `writeCount` +1 per successful write | correct by construction |
   | `LoopDetector` | one `record` per call, keyed on name+args | correct by construction |
   | app reducer `tool.call`/`tool.result` | oldest writing card by name; result by recency | correct, already tested |
   | `collectChanges` (Changes) | one entry per path, `Not run:` skipped | correct, already tested |
   | Terminal tab | one row per command item | correct by construction |
   | `transcript.tsx` `suppressedId` | the last item, which is the awaiting call | correct by construction |
   | `replayEntries` | **all calls then all results** | **was broken** — fixed in 6f116d0 |

   Two of the ten were wrong, and only one of them was caused by the change. The other,
   `recordToolOutcome`, had never worked for a session's FIRST turn: outcomes are written
   during a turn and `sessions/` is created by the transcript flush at the END of it, so every
   append threw ENOENT into a catch documented as covering a cosmetic loss. Turn two onwards
   worked, which is why nothing caught it — every replay test made the directory in
   `beforeEach`, and no host test read the file back. With nothing on disk `assumedOk` guesses
   from the result text, so every failed call in a session's opening turn restored with a tick.

   The lesson: the walk found one defect in the change and one that had been there all along,
   and the second only surfaced because writing the test meant *looking for the file*. Asserting
   the event fired would have passed.

4. ~~**A third audit**~~ DONE (wf_bf0ac8a1-44a): 14 raised, 10 confirmed, 4 refuted. Seven
   distinct defects fixed in 2775de5 — **all of them in the previous rounds of fixing.**

   The number worth keeping: three audits, and each one found defects introduced by the one
   before. Audit 1 found 15 in the feature work; audit 2 found 19, two of them inside
   `a759855`; audit 3 found 10, every one of them mine from the same day. The rate at which
   fixing introduces defects here is not small, and the only thing that caught them was
   auditing the fixes as a separate act.

   Two of the ten were TESTS THAT COULD NOT FAIL, both mine, and both had already been
   "verified" by me in a way that missed it:
   - the flush's crash-ordering test ran no compaction at all, so deleting the entire flush
     block left it green;
   - deleting the skipped-call announcement left every test in BOTH suites green — the app
     test was a correct reducer unit test and the core suite simply had no test driving a
     two-call step with an events recorder.

   Both are now verified by deletion, which is the only check that would have caught either.

   **Still open from it, deliberately not fixed:** nothing. But note the pattern for the next
   round — a fix that adds an EVENT is the dangerous shape, because every existing consumer
   of that event silently gains a case. Both high-severity findings here were that shape.

5. ~~**The regression item 3 created.**~~ DONE (aa8a47c). Batching moved several file-sized
   arguments into ONE generation, and the per-step deadline was a flat timeout over the whole
   step. Live, "create four thorough ~100-line collection classes", n=3 per arm:

   | | wall clock | outcome |
   |---|---|---|
   | after item 3, flat deadline | 90.0 s | **TIMEOUT, 0/4 files, 3/3 runs** |
   | one call per step (the old code) | 165.7 s | done, 4/4 files |
   | after the fix | 135.9 s | done, 4/4 files |

   The turn was killed for producing too much, too fast, in one piece. Attributed by running
   the same task against the reverted loop AND prompt — not by reasoning about it — which is
   the only way to tell a regression from a pre-existing limit.

   The deadline measures SILENCE now, which is what `DEFAULT_STEP_TIMEOUT_MS` and
   `StepStartInfo` had always SAID it measured ("silence is the failure, not the duration").
   The gap between what a comment claims and what the code does had been harmless for as long
   as a step held one call.

   Two things this exposed that were not about the deadline at all:
   - `render.ts` wired delta callbacks only on a TTY, and streaming is opt-in on a callback
     EXISTING. So `--unattended` — a pipe, with the longest steps in the system — was on the
     non-streaming transport, where there is no signal to re-arm from. Now unconditional.
   - The app's countdown counted from the step's start and would have run to zero while the
     model streamed. `step.alive` mirrors the core's clock.

   And a lesson about probes: the first re-measurement after the fix STILL timed out, because
   the probe wired no delta callback and was therefore measuring the non-streaming path. A
   probe that does not reproduce the app's own wiring measures a configuration nobody runs.

6. ~~**The prefill budget.**~~ DONE (a24e56d). The live long-turn test started ending in
   `timeout` and instrumenting it said why: step 6 batched three ~15k-token reads, so step 7
   had to prefill ~46k tokens the server had never seen, which produces NO tokens while it
   happens. The new silence deadline read that as a dead server.

   The gap before a step's first token is not idleness; it is work with a knowable length.
   Measured against the server's own prompt counts in that run: 15,393 new tokens → 36.3 s,
   15,409 → 58.8 s, 11,963 → 25.0 s. So 46,200 is 116-185 s against a flat 90.

   The budget for a first token is now `stepTimeoutMs + newChars/4 × 4 ms`, where newChars is
   what has been appended since the last request. **Live: the long-turn test went from timeout
   to done in 209.9 s, faster than the 253 s it took when it was written.**

   **What `long-turn.test.ts` actually tells you, measured over five runs after the fix: 3
   pass, 2 fail, 209-229 s.** Read the failure before concluding anything — the two are not
   the same kind:
   - `stoppedBecause: 'timeout'` is INFRASTRUCTURE, and it is what the prefill defect looked
     like. No run has produced it since the fix.
   - `expected '…' to contain '// reviewed'` is the MODEL not finishing the task — one of the
     three files never got its line. That is Qwen3.6 on a demanding multi-step task across two
     compactions, not a defect in anything here.

   So a red on this test is a question, not an answer. Re-run it and read the assertion. The
   test is worth keeping at that reliability because the failure it was built to catch is the
   first kind, and that kind is now deterministic.

   Worth keeping: this was already eating the budget before today — one 15k read cost 58.8 s
   of the 90. Batching pushed it over rather than creating it, which is why it had never been
   seen. `PREFILL_MS_PER_TOKEN` had been measured twice, independently, in two files, for two
   budgets that turned out to be the same quantity; it lives in `loop.ts` now and session.ts
   imports it.

7. ~~**A fourth audit.**~~ DONE (wf_7833d83c-802): 16 raised, **9 confirmed**, 7 refuted, all
   fixed in 7f8caec. The nine collapse into six distinct defects.

   **The number that matters: four separate lenses independently found the same defect, and it
   was mine, from the fix three hours earlier.** `step.alive` moved `currentStep.startedAtMs`,
   which the composer also reads for "how long has this step been running" — so the elapsed
   readout showed `0.0s` for the whole of every streaming step, and a NEGATIVE duration
   whenever an animation frame landed after the 250 ms clock tick. The readout exists so a
   long generation reads as "it is working"; the change aimed at making long generations
   possible is what broke it. One field, two questions.

   Two more were the same shape as each other: the composer and the transcript both used
   `items[items.length - 1]` to mean "the call in progress". A step runs its calls in order,
   so by the time call 1 executes, calls 2 and 3 already have cards — `npm test` ran for
   minutes labelled `running write_file`. Pre-existing; item 3 made it routine.

   And one that had nothing to do with today: **the CLI and `--unattended` never recorded tool
   outcomes at all.** Recording lived in `SessionHost`, so a night's run persisted its
   transcript, appeared in the app's session list, and restored with a green tick on every
   failed command. It lives in `Session` now — the one thing every front end goes through.

   The pattern, four audits in: **every audit has found defects introduced by the round of
   fixing before it, without exception.** Audit 1: 15 in the feature work. Audit 2: 19, two
   inside a fix commit. Audit 3: 10, every one from the same day. Audit 4: 9, of which the
   highest-severity was three hours old. Auditing the fixes is not optional here, and the
   evidence is now four for four.

8. **Throughput, the rest.** `tool_choice` is measured and spent (see below). The prompt-prefix
   half is locked by `core/test/prompt-cache.test.ts`. Item 3 took the large one. Nothing
   further is identified.

Everything below this line is history — measurements and closed items, kept because the
reasoning is worth more than the conclusion. The list above is the only live queue.

To start the model server (it is a manual on/off switch that kills the model when the script
exits — run it detached, measure, then stop it rather than holding 16 GB of VRAM):
`powershell -NoProfile -ExecutionPolicy Bypass -File D:\LocalAgentAI\Start-QwenServer.ps1`

## Closed: long-run hardening (both audits, 34 findings raised, 21 fixed)

The step ceiling came off in 6d2e7aa and made everything that had only ever run for ~40
steps load-bearing. Two audits over it and over the fixes themselves; every confirmed finding
is fixed. The ones worth remembering:

- Transcript windowing (687c671). The verifier's measurement shaped it: 9.4 ms/frame of VNode
  diffing at 25k items is the CHEAP half; DOM size and forced layout are what stop the window.
- BackgroundTasks eviction (687c671, 5cf1ef8) — 30 newest finished kept, running ones never
  dropped, and the user's own terminal commands dropped last, because that registry IS the
  Terminal panel's scrollback.
- Checkpoint problems reach the user (3a6fea1). The single-unit path skipped collection, so
  "no git on PATH" was unreportable on every ordinary workspace — the loudest case, and not
  the mid-run disk failure the finding was written about.
- Mid-turn work-log entries and `LOGGED_TOOLS` (9230577).
- `checkpoints.list` takes a limit and History can page (9230577). The `git add -A` cost that
  finding was really about was REFUTED by measurement: ~250 ms per warm snapshot on this
  workspace, ~90 s across a 12-hour turn, 0.2%.

## Measured, and settled: tool_choice is NOT a lever any more

docs/DESIGN.md §7 recorded `required` beating `auto` 4/5 vs 2/5 with 1262 vs 5591 median
thinking tokens. Re-measured against the live model on the spike's OWN task
(`spike/edit_probe.py`'s PathRules.cs), n=3 per arm, same tool list in both arms plus a
`finish` tool so `required` was satisfiable: **1/3 vs 1/3 correct, no thinking runaway in
either arm** (max 676 tokens, against the 5591 recorded). The prompt paragraph "do not
deliberate at length, and do not re-check a decision you have already made" — which
prompt.ts already calls one of the two levers that stop the runaway — has taken it. Do not
build a turn-ending tool for this reason; there is nothing left to win.

Also worth keeping: the first attempt used an easy TypeScript refactor and found no
difference either, but that proved nothing — the task never provoked the failure. And the
checker was wrong at first: it rejected `$@"...""{p}"""`, which is correct C#. A verdict
without the produced text beside it is how a strict checker gets mistaken for a failing model.

## An observation from the live long run, NOT yet a finding

In that run the model read all three files at steps 4-6, and read them AGAIN at steps 11-14 —
about a quarter of the turn spent re-acquiring what it had already had. The cause is not
mysterious: a compaction had removed the contents from its context, so re-reading was the
correct move, not a mistake.

What is NOT established is whether this matters at a real window. The test forces a 30,000-
token window to make swaps happen in minutes; at the real 131,072 there would have been no
swap at all in a turn that size, and the re-reads would not have happened. Two compactions in
fifteen steps is an artefact of the harness.

So: do not "fix" this from the run above. The honest experiment is a turn long enough to
compact at the REAL window, measuring what fraction of steps after a swap are re-acquisition.
If that fraction is large, the lever is what the briefing carries — `COMPACTION_INSTRUCTION`
in core/src/session/compaction.ts already asks for every path touched, but a path is not the
contents, and there may be a cheaper way to hand the model back what it just lost.

## Where the wall clock goes (measured, live model, 7-step turn)

- prefill 403 tok/s, generation **57 tok/s** — a generated token costs 7x a prefilled one.
- prompt cache hit **85.9%**; steps 2-7 prefilled 22-115 tokens each, not thousands. The
  structural property core/test/prompt-cache.test.ts asserts is real in practice.
- speculative decoding: 85% of draft tokens accepted.
- So the only large lever left is generating fewer tokens, and tool_choice is not it.

## Done

- **The prompt-prefix property is now held by a test** (core/test/prompt-cache.test.ts).
  llama.cpp reuses its KV cache by longest common prefix; a diverging prompt re-prefills
  everything, which at 393 tok/s is ~4 min on a 100k conversation — every step, forever, and
  invisible to every behavioural test because the answers are identical either way. Asserted:
  tool list byte-identical across a turn, messages strictly appended, second turn keeps the
  first turn's portion, and buildSystemPrompt is deterministic. Verified the tests have teeth
  by injecting a timestamp: only the determinism one caught it, and the reason is recorded in
  the file (message 0 is reused from the transcript, not rebuilt).

- **Mid-turn checkpoints.** Removing the step ceiling silently made the undo useless for
  long turns: recordTurn snapshots once, AFTER the turn, so hours of work had one point to
  come back to. A running turn now snapshots every 2 min if it has written (configurable,
  0 = every writing step), the work log still diffs the WHOLE turn (turnStartCheckpoint),
  and History names the step so a long turn s several points are told apart.

- **Streaming tool-call arguments.** The client accumulated the fragments and reported
  none of them. Now carried through all four layers: StreamDelta -> AgentEvents.onToolCallDelta
  -> the tool.call.delta protocol event -> a live card in the transcript that opens on the
  tool name, shows the target path as soon as it is written, and grows with the argument.
  The composer stops guessing at the state and reads it. Verified end to end through the host.

## Closed: the parallel-call lever (6f116d0)

Everything below was the case FOR the change; it is kept because the estimate being wrong by
2.5x is the useful part. The measured outcome is in queue item 3 above.



The loop runs `calls[0]` and refuses the rest — "one action per step", deliberate. The model
does not know that, and proposes several often enough to matter.

Measured on a real 13-step turn against the live model (a 4-file edit task):

```
[7] edit_file edit_file edit_file    3 proposed, 1 run
[8] edit_file                        redoing the second
[9] edit_file                        redoing the third
[11] read_file read_file             2 proposed, 1 run
[12] read_file                       redoing the second
```

- steps proposing more than one call: **3 of 13**
- argument characters discarded: 354 of 1065 — ~89 tokens, **8.0%** of the turn's generation,
  about 1.6 s of a 36 s turn
- but the real cost is the REDO STEPS: 3 of 13 steps exist only because the extra calls were
  thrown away. At ~2.8 s per step that is ~8 s of 36 — roughly **23% of the turn**.

So the prize is ~20%, not 8%, and it is not "stop the model wasting tokens" — telling it to
emit one call would save the 8% and none of the 23%, because it would still need one step per
edit. The prize is **executing the calls it proposes**.

The design question, stated honestly, because this changes the agent's core execution
contract and should not be done casually:

- The stated reason for one-per-step is transcript validity — an assistant message with an
  unanswered `tool_call` is invalid. Executing all of them satisfies that too; each gets a
  real answer.
- The unstated reason is that the model should see a result before deciding the next action.
  That is right in general and irrelevant for three edits to three different files, which are
  already generated from the same information.
- The safe shape: run every proposed call in order through the SAME permission gate, and if
  one is refused or fails, answer the remainder with "not executed: an earlier call in this
  step failed" rather than running them. That keeps the property that the model sees a
  failure before more actions land.
- Check before building: `lastToolArgs`, the loop detector, `writeCount` and `writtenMounts`
  are all per-call already, so they should need nothing.

That last bullet was right about the four things it named and wrong about the shape of the
risk. `lastToolArgs` needed nothing — but only because the calls run in SEQUENCE, which is a
property nothing was asserting; and the consumer that did break (`replayEntries`) was not on
the list at all, because it does not read those events, it reconstructs them. The lesson for
the next change of this shape: enumerate the consumers of the ORDER, not only of the data.

## Closed: the fourth audit's refuted findings (wf_7833d83c-802)

Kept because a refutation is a fact about the code, and the next auditor will raise several of
these again. Each was checked by running something, not by reading.

- halting: A batch containing repeats trips the loop detector inside one step, halts it, and blacklists the call for the rest of the session — Every harm claimed is identical to the pre-change behaviour, and the cited evidence for the triggering shape is a misreading. 1. I reproduced the exact scenario and compared it with what the OLD loop actually executed for the same model proposal. Probe A (new

- halting: A denied or user-declined write replaces the successful write to the same path in the Changes tab, taking its diff and "Put back" with it — The finding's causal story is wrong, and everything it points at is byte-identical to before the audited range. 1. The halt path does not "route through" those two strings. In the new loop (D:/LocalAgentAI/PrivateCode/core/src/agent/loop.ts:514-546) t

- clock: A step that times out on the cold-cache budget reports the 90 s warm budget instead, to both the user and the model — The mismatch is real but the claimed harm is not. I reproduced the mechanism (Agent with stepTimeoutMs 90 / firstStepTimeoutMs 540 against a quiet client: the step really waited 543 ms, and both strings said "90 ms"), then traced every consumer of the value. TurnResult.final

- transport: Switching the CLI to chatStream() loses the server's own error text on a 200-that-is-not-a-completion, and replaces it with a false "connection dropped" claim — The failure the finding names does not occur on this server, and where it hypothetically could, the user-facing outcome is not what the finding claims. (1) The concrete trigger is refuted empirically. Against the live llama.cpp 

- outcomes: recordToolOutcome creates .privatecode/ with a bare mkdirSync, bypassing ensurePrivateDir's self-ignore — REFUTED — a guard fires before the first tool can ever produce an outcome, and I measured it. 1. `recordToolOutcome` has exactly one caller in src: `SessionHost.buildAgentEvents().onToolResult` (D:/LocalAgentAI/PrivateCode/core/src/host/host.ts:901). The CLI never calls it. 2. The ho

- tests: The skipped-call announcement is now unprotected — delete it and the whole core suite stays green — The finding concedes the code is correct: every one of its three failure scenarios begins with "delete line 538". Deleting a correct, shipped line is an edit to the source, not an input to the program, so no sequence of user/model actions produces a wrong result. I drove the exact sequence th

- tests: The trailing `flushPending()` in replayEntries is deletable with the entire core suite green — The claimed failure does not exist in the code. Line 238's flushPending() is present and works: running replayEntries on the exact scenario (a transcript whose last message is an assistant message with an unanswered tool_call) emits the tool-call entry, and on a torn batch (calls a/b/c, only a and


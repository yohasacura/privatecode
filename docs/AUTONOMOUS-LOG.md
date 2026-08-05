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

5. **Throughput, the rest.** `tool_choice` is measured and spent (see below). The prompt-prefix
   half is locked by `core/test/prompt-cache.test.ts`. After item 3, the open question is
   whether anything else reduces generated tokens.

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

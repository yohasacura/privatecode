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
3. **Throughput** — see the measured section below. The tool_choice lever is spent; the
   remaining question is whether anything else reduces generated tokens.

4. **A third audit**, over what the last two rounds of fixing changed. The second audit found
   two defects inside `a759855` — the commit whose entire subject was fixing things — so the
   rate at which fixing introduces new defects is not zero and is worth measuring rather than
   assuming. Cover: the flush cursor, the consumed cold-cache flag, the announced skipped
   calls, `closeWritingCalls`, the WeakMap parse cache, the Terminal cap, and
   `sessionBaseline` now being set from a rewind's undo point.

Ordered by value to "very stable, very efficient, large development processes".

1. **Streaming tool-call arguments** — DONE (see below)
   The user diagnosed this himself: "Нейронка генерирует что нужно отредактировать - на это
   тратится время, а я в чате увижу это только тогда когда полное изменение будет
   сгенерированно, а до этого у меня чат просто замирает." The chat freezes for the whole
   time a large `edit_file` argument is generated. Needs the tool-call fragments carried from
   the llama client through the agent events and the protocol into the window — four layers.

2. **Long-run hardening** — IN PROGRESS. Mid-turn checkpoints DONE. Still to look at:
   memory growth across thousands of steps, the work log on a turn that never ends, and
   whether repeated compaction inside one turn degrades the briefing.

   (original note) — after the step ceiling came off (commit 6d2e7aa), a turn can now
   run for hours. Everything that was only ever exercised for ~40 steps is newly load-bearing:
   repeated mid-turn compaction, the work log, checkpoints per turn, memory growth.

3. **Throughput** — get more out of the model per unit of wall clock.

   The prefix half is DONE and locked (see below). The half that needs the live model:
   - `llama-server` is NOT running by default. Start it with
     `powershell -NoProfile -ExecutionPolicy Bypass -File D:\LocalAgentAI\Start-QwenServer.ps1`
     — it is a manual on/off switch that kills the model when the script exits, so run it
     detached, measure, then stop it. Do not leave 16 GB of VRAM held for nothing.
   - The measured lever already in the docs and still unused: `toolChoice: 'required'`
     completes a hard edit 4/5 with 1262 median thinking tokens; `'auto'` completes 2/5 with
     5591 (docs/DESIGN.md §7). That is 4.4x fewer generated tokens AND more reliable. The
     stated blocker is per-STEP selection — "required while work remains, auto once it does
     not" — which needs a signal the loop does not have. Do NOT guess at that signal; measure
     candidate signals against the live model before changing anything.

## Audit findings still open (from wf_a59ed946-0db, 15 confirmed of 32 raised)

Five fixed in a759855, four more in 687c671 and 3a6fea1. Remaining:

- **A six-hour turn is one work-log entry** (core/src/session/worklog.ts:94) — one heading,
  one collapsed diff, at most eight commands. Consider a mid-turn entry alongside the
  mid-turn checkpoint that already exists.
- **Session.turnCommands retains full tool-result text for the whole turn** (session.ts:887)
  and throws almost all of it away. 2-18 MB over 6 h, ~130 MB over a day of large reads.
- **Mid-turn checkpoints run `git add -A` over the whole tree every 2 min** (session.ts:1072);
  a 12-hour turn is up to 360 whole-tree commits, each blocking the step it sits on. MEASURE
  the real cost on this workspace before touching the interval — the audit's own numbers here
  were an upper bound, and the verifier trimmed two of its three claims.

Done from this list:
- Transcript windowing (687c671) — the tail is mounted, the rest is a click away. The
  verifier's measurement is what shaped it: 9.4 ms/frame of VNode diffing at 25k items is
  the CHEAP half; DOM size and forced layout are what actually stop the window.
- BackgroundTasks eviction (687c671) — 30 newest finished kept, running ones never dropped.
- Long-turn completion notification (3a6fea1).
- Checkpoint problems reach the user (3a6fea1) — the single-unit path skipped collection, so
  "no git on PATH" was unreportable on every ordinary workspace.

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

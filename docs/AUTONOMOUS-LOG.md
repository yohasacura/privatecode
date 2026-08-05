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

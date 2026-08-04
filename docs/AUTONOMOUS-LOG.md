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

2. **Long-run hardening** — after the step ceiling came off (commit 6d2e7aa), a turn can now
   run for hours. Everything that was only ever exercised for ~40 steps is newly load-bearing:
   repeated mid-turn compaction, the work log, checkpoints per turn, memory growth.

3. **Throughput** — get more out of the model per unit of wall clock. Measure first:
   where does the time actually go on a long turn.

## Done

- **Streaming tool-call arguments.** The client accumulated the fragments and reported
  none of them. Now carried through all four layers: StreamDelta -> AgentEvents.onToolCallDelta
  -> the tool.call.delta protocol event -> a live card in the transcript that opens on the
  tool name, shows the target path as soon as it is written, and grows with the argument.
  The composer stops guessing at the state and reads it. Verified end to end through the host.

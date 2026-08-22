# PrivateCode — third audit, 2026-08-22 (reproduce-or-it-did-not-happen)

Six read lanes + six adversarial verifiers + one synthesis, 13 agents, 691 tool calls,
45 minutes. **28 raw findings, 25 after dedupe, 1 refuted.**

The rule this round was run under, and the only thing that makes it different from the first
two: **a finding counted only if somebody OBSERVED it** — against the running llama.cpp on
`127.0.0.1:8080`, or by executing the shipped code. Not "read the source and it looks wrong".
Every one of the 25 cleared that bar. The verifier lane threw one finding out for failing it
(`background_task`'s `ready_when.file`, below) and wrote three scope corrections into findings
that were real but overstated.

That discipline paid twice over, in both directions:

- **It killed a plausible-sounding bug.** `background_task`'s `ready_when.file` was reported
  as unable to resolve in a multi-folder workspace. The verifier reproduced the reader's exact
  numbers — and then ran the same case with the folder prefix the system prompt *requires*
  (`appA/ready.txt`) and got `ready: YES` in 1 s. The tool was following the workspace's own
  path convention; the report had tested a spelling the prompt forbids.
- **It corrected three findings that were real but sold too hard.** Item 8's headline
  ("46k tokens of prefill against a 90 s deadline") is not reachable — one message's tool
  calls come from one generation bounded by `DEFAULT_MAX_TOKENS_PER_STEP`. Item 3's "forever
  after" is wrong; the leak is confined to zero-write turns following an unverified one. And
  item 21's "the UI is left with a turn that never ends" was tested and **disproven** —
  `composer.tsx` catches the rejected `send` and the reducer releases the composer.

## Status

**All 25 are fixed, plus the residual the audit left open** (last section). Core 1165 → 1184 tests, app 282 → 286, both typechecks clean.

Item 25 is the exception in kind, not in handling: the audit itself classifies it as a
DECISION rather than a defect, and it was decided — see below.

Three constants were re-measured here rather than taken on the audit's word, because they are
the ones a wrong number is invisible in:

```
tool block, /apply-template + /tokenize : 4794 with, 11 without -> 4783
tool block, /v1/chat prompt_tokens      : 4794 with, 11 without -> 4783
prefill, idle server (3 cold runs)      : 2.04, 2.00, 2.04 ms/token  (491-499 tok/s)
```

Both routes to the tool block agree exactly, and neither is 4,450. The prefill figures are
from an idle slot (wall time equalled the server's own `time_ms`); the audit's 2.20-2.40 came
from a busy one. Either way, nothing came near the 730 tok/s the old constant assumed.

Probes added: `spike/tool-block-tokens.mts`, `spike/prefill-rate-probe.mts`,
`spike/format-placeholder-probe.mts`, `spike/move-across-drives-probe.mts`,
`spike/short-name-probe.mts`, `spike/slots-during-prefill-probe.mts`. Each prints the
measurement its constant or fix rests on.

### Driven in the real window afterwards

One task, start to finish, in the running app against the live server. What it exercised, in
order, all of it visible on screen:

```
contract distilled, plan seeded, item 1 ticked
premise gate REFUSED a write        "2 of your other assumptions did check out"
queued calls folded honestly        "Not run: the turn was interrupted to check something"
understanding check parked the turn "waiting on you · nothing generating"
  ... offering "None of these — just do what we agreed above" as a real option
approval card for run_command       the turn genuinely parked, Allow resumed it
exit 0 in 0.4 s                     "All assertions passed."
verified with contract check — passed
verified with independent diff review — passed
4.4s · 41.0 tok/s
```

`exited ?` appears nowhere. `plan.json` is back to `[]` and the meta reads
`satisfied: True | checkedState: 1,2,3,4,5,6,7,8,9,10 met`. The agent's own work is correct
and its test passes with exit 0, checked by hand outside the app.

**One thing the run turned up, chased down afterwards — and it WAS a bug, just not in the
gates.** The distilled contract rendered "slugs contain only lowercase letters, digits and
single hyphens" as ten EXAMPLE-shaped criteria and none stating the rule, so
`slug('Hello, World!')` still returned `'hello,-world!'` and the audit was right to pass all
ten. See the last section: the general rule became a list of instances, the instances all
held, and nothing in the chain could notice.

---

## Band 1 — the ones worth the round

### 1. `.privatecode` write-deny was bypassed by the NTFS 8.3 short name

`.privatecode/settings.json` is where the next session reads its `permissions`, `hooks` and
`format` rules — and hook and format commands run with **no permission gate at all**. The
engine denies writes there. It denies them on the path the model *spelled*, after a purely
lexical canonicalize, and Windows gives the same directory a second name.

Observed, and re-confirmed here after the fix (`spike/short-name-probe.mts`):

```
8.3 alias for .privatecode : PRIVAT~1
  .privatecode/settings.json   engine=deny   jail=THREW
  PRIVAT~1/settings.json       engine=allow  jail=THREW   <- was: allow, and the write landed
write_file via alias : false | access denied ...
settings.json now    : {"permissions":{"allow":[]}}       <- untouched
```

Before the fix the audit drove it end to end: `write_file` returned
`Replaced PRIVAT~1/settings.json (29 bytes -> 118 bytes)`, `loadFormatRules` then returned the
planted command, and a separate probe ran a settings-supplied format command through
`powershell.exe` with no engine anywhere in the path.

**Fixed** in `Workspace.resolveForWrite`, against the CANONICAL path — the chokepoint every
model-facing write already goes through. Deliberately *not* added to `DENIED_SEGMENTS`: that
list guards reads too, and a session reading its own settings is legitimate. The engine's
lexical deny stays as the fast path. The control the audit ran still holds — `ENV~1` was
already caught, because the jail re-checks canonical names against `DENIED_SEGMENTS`; this was
a gap in *which list*, not in the mechanism.

### 2. `edit_file`'s whitespace fallback double-indented the whole block

`reindent` took the block's own indentation from `lines[0]`. A replacement that opens with a
newline makes that the empty string, so the `had === ''` branch prepended the file's indent to
**every** line, including the ones already correct.

```
before: applySearchReplace(...) -> 'def f(x):\n\n        if y:\n            go()\n...'   (4 -> 8)
        python: IndentationError: unindent does not match any outer indentation level
after : 'def f(x):\n\n    if y:\n        go()\n    return 1\n'                            (4 stays 4)
```

**Fixed** by anchoring on the first non-blank line. A blank line carries no indentation
information and must not be asked for any. This is the same fallback round 2 rewrote; that
rewrite was right about the anchor and wrong about which line to take it from.

### 3. An aborted turn's writes were never verified

`writtenMounts` was cleared at the *start* of every turn, and `verifyAndFix` returns early on
`stoppedBecause !== 'done'`. So: turn 1 writes and is aborted; turn 2 clears the set, writes
nothing, takes the `writesThisTurn === 0` shortcut straight past the build gate, and
`verifyJobs()` filters every folder out.

```
TURN1: aborted  writeCount=1  writesAtLastVerify=0  writtenMounts=['pc-p1-…']  runs.txt ABSENT
TURN2: done     writeCount=1  writtenMounts=[]      ACCEPTANCE GATE RAN        runs.txt ABSENT
       contract.satisfied = true | checkedState = 1,2,3 met
```

**Fixed** in three places, because the counter it should have followed was itself not being
maintained: `writtenMounts` clears only when `writeCount === writesAtLastVerify`; the
zero-write shortcut requires the same; and `verifyOne` now advances `writesAtLastVerify` (it
runs a verify — only `verifyMidTurn` used to say so, which is why the folder set could not
simply follow it).

### 4 + 14. A null audit cancelled the diff review; a failing audit paid for one

These two are one change, not two — the synthesis lane caught the conflict and it is real.
Item 4 wants a null audit to fall *through* to `freshReview`. Item 14 wants `freshReview`
guarded by "the gate came back clean". A null audit is not clean, so implementing 14 as
written would have silently re-created the bug 4 exists to fix.

Item 4, observed with byte-identical traffic except the acceptance answer:

```
valid      stopped=done  schemas seen: [contract, acceptance, review]  reviewRan=true
truncated  stopped=done  schemas seen: [contract, acceptance]          reviewRan=false
```

Item 14's cost: up to `REVIEW_MAX_STEPS` reads plus `REVIEW_MAX_TOKENS` of generation (~286 s
at 42 tok/s) **and** it sets `promptCacheCold`, so the next turn re-prefills from scratch —
196k tokens is ~400 s at the rate measured above. Spent on the one turn that is about to be
handed back for more work.

**Fixed** by making the gate's outcome tri-state: `clean` runs the review, `unmet` skips it,
`could-not-run` runs it — because the review is an independent gate and must not inherit the
audit's transport failure. `break`, not `return`, so the post-fixer verify happens either way.

### 5. `tool_choice: 'required'` is accepted and ignored by this build

The single most consequential finding of the round, and it invalidates a claim in this
project's own docs.

```
required 10.1s HTTP 200 finish=length tool_calls=none content="Hello! 😊\n\nHow can I assist…"
required  8.7s HTTP 200 finish=length tool_calls=none content="Hello! 😊 How can I assist…"
required  9.3s HTTP 200 finish=length tool_calls=none content="Hello! 😊\n\nHow can I help…"
```

`tools=[read_file]`, `tool_choice:'required'`, "Say hello in one word. Do not use any tool."
Prose from the first token, three times out of three: no grammar was applied.

The truncation continuation rests on the opposite premise — it sends `'required'` precisely
because by then talking has already failed. So a continuation that talked came back as an
ordinary message, `runTurn` saw zero calls, and **a step that took no action at all ended the
turn `stoppedBecause: 'done'`.**

**Fixed** by checking the answer instead of trusting the request: a continuation with no
`tool_calls` is a failed step. Its words are carried out rather than discarded — the model did
produce them — but the turn ends `truncated`, honestly. The now-false claims at
`AgentOptions.toolChoice` and `DEFAULT_MAX_TOKENS_PER_STEP` are corrected in place, and
`docs/AUDIT-2026-08-22.md:258`'s clean bill on this no longer holds (that measurement was of
the *named* form).

Worth stating plainly: had round 2's proposed "use `tool_choice` to force the gates" landed,
it would have silently disabled every gate in the harness.

### 6 + 7 + 8. Three constants that multiply into the same allowance

Landed as one change, per the synthesis lane's C2 — `prefillAllowanceMs` is
`(chars/4) × PREFILL_MS_PER_TOKEN`, so these compound.

- **`TOOL_SCHEMA_TOKENS` 4,450 → 4,783.** The previous retune divided the serialised array by
  four. The tokenizer charges 4,783; two independent routes agree exactly (see Status). The
  measurement is now recorded beside the constant so the next retune cannot fall back to
  arithmetic.
- **`PREFILL_MS_PER_TOKEN` 2 → 3.** The comment claimed a ~46% margin over 1.37 ms/token. Ten
  cold prefills across three probes say 2.00-2.40. Two sat exactly on the floor of the real
  range and below it under any load — and a full 196k cold prefill genuinely takes ~401 s
  against the 393 s the old constant granted. **The healthy step was the one at risk.**
- **`firstTokenBudget` was blind to `tool_call` arguments.** A `write_file` message carries
  `content: null` and the whole file in its arguments. Measured: a 69,774-char write moved the
  budget by 12 ms where the same payload as a READ moved it by 34.9 s. Ground truth that those
  bytes are prefilled: 1,289 vs 333 `prompt_tokens` for a 3,832-char argument.

The third one is really a drift bug — `session.ts` had fixed the identical hole and its own
comment says "this was the one place that did not". So the fix is one exported counter
(`messageChars` / `transcriptChars` in `transcript/transcript.ts`) that all four sites now use.
The drift *was* the finding.

**Law 1 note, from the synthesis lane and worth keeping:** correcting the estimate makes it
read *higher*, which makes compaction fire *earlier* — and every compaction is the mid-history
rewrite DESIGN.md calls the worst thing you can do on this architecture. So the *measured*
constant landed (4,783 — exact, no judgement) and the global chars/4 → chars/3.6 density
change did **not**. That is a separate decision, and it needs the compaction trigger
re-measured, not a bundled cleanup.

---

## Band 2

**9. A `**`-glob needed an intervening directory, so DENY rules missed every root-level file.**
`certs/key.pem → deny (rule)`, `key.pem → allow (mode)`, `engine.problems === []`. The
deviation from minimatch was documented — but on the DENY side it failed **open**, the one
direction this engine otherwise refuses to fail in, and nothing told the rule's author that
half of what they wrote did not apply. Fixed in the matcher (`globstar-slash` token, DP walk)
and in the display form. This necessarily widens ALLOW rules the same way, which is what the
author of `edit_file(src/**/*.ts)` means by it — reviewed alongside item 1, as C5 asks.

**10 + 11 + 23. Six harness messages replayed as the person's, and so did a build log.**
`CONTINUE_NUDGE`, the truncation notices, the step-timeout and max-steps appends, and both
checkpoint notices all rendered under `## You`. The verify fixer's `In the "api" folder: `
prefix defeated `HARNESS_OPENERS`'s `startsWith`, and the escalation wrote `]\n` where the
bracket rule needs a blank line. An attachment blob showed the entire file body as the
message, and titled the session from it. Fixed in one pass through `splitUserMessage` in the
order C4 requires (folder prefix → openers → attachment wrapper), with the strings exported as
constants so a rewording cannot drop one out of the list. Round 2 named the one-newline
escalation and shipped only half of it; this is the other half.

**12 + 13. The export ignored the `harness` flag it was added for, and dropped `folder`.**
`replay.ts`'s own comment names `conversationAsMarkdown` as what the flag exists to stop. One
message the person sent came out as three `## You` headings. Separately, `session.ts` emits
`folder` at all four `onVerify` sites and the protocol calls it "the answer to a question a
person actually has" — it was simply not forwarded, so two folders' checks exported as two
identical lines. Both fixed, both now covered.

**15. `acceptanceSchema` forced `met` before `evidence`.** The ask defines `met` *in terms of*
the evidence and `disableThinking` leaves no scratchpad, so the grammar made the model commit
to a verdict and then justify it. That the order is really forced was verified the hard way:
asked explicitly, in the user message, to write the keys in a different order, the server
returned the schema's order anyway. Swapped. **Honest limit:** 3+3 A/B samples showed no
verdict difference — this is a structural inversion, not a measured wrong verdict.

**16. Three gates had no English pin, and their text reaches the person.** `checkAcceptance`
answered a Russian transcript in Russian — and that sentence goes into `contract.checkedState`,
which `renderContract` promotes into **message 0** at every compaction swap, and which
`acceptanceFailureMessage` puts on screen. The diff reviewer, over the same conversation,
answered in English, because its brief is English. Pinned in `checkAcceptance`,
`statePremises` and the compaction briefing; `english-only-output.test.ts` extended to all
three.

**17. The loop retried a 400 the server had already answered.** Hashing every inbound body,
the last four were two byte-identical pairs — four refusals for two logical attempts, on both
the acceptance-fixer and overflow-retry paths. Cheap (a real 220k-token overflow is refused in
637 ms, before any prefill) but pointless, and it hides the real error behind a health check
that always passes. The retry now excludes 4xx.

**18. A format rule spelled `'${FILE}'` handed the formatter the literal string.** One
spelling of six, and it is the one `format/config.ts` *recommends*. The consequence is not
cosmetic: the formatter exits non-zero on every write, feeds the model a phantom error, and
after `MAX_FAILURES` switches formatting off for the session with nothing on screen to say so.
All six now expand, verified with a recorder logging argv against a filename containing a
space (`spike/format-placeholder-probe.mts`).

**19. A throw from `events.onToolCall` left every call in the step unanswered.** `announced:
['c1','c2']  answered: []`. The very next statement is try/caught with a comment spelling out
this exact hazard. Unreachable from the shipped app (`safeSend` swallows it) and live for
`cli/render.ts` and the spikes. Wrapped.

---

## Band 3

**20. `move_file` across drives failed EXDEV *after* creating the destination directories.**
A multi-drive workspace is a designed shape — `FolderSpec` says "absolute otherwise" — and
there was no EXDEV handling anywhere in `core/src`, so cross-drive moves were simply
impossible while still mutating the workspace on the way out, against a comment fifteen lines
above saying a failed call must not. Fixed both halves: a copy+unlink fallback on EXDEV, and
the created directory chain removed when a move fails. Verified on two real volumes:

```
same volume? false
move             : true | Moved appC/src/a.ts -> appD/lib/deep/a.ts
source still there? false     dest bytes "export const a = 1\n"
refused move     : false | Could not move … ENOENT
dirs left behind?  false
```

**21. A healthy long step that outran the transport ceiling was re-run from scratch.** The
step clock bounds SILENCE and only up to the first token (`MAX_COLD_START_MS` = 540 s);
`requestTimeoutMs` bounded the whole request at 600 s. Their budgets do not nest: 540 s of
permitted silence plus ~190 s of permitted generation is ~730 s, so a perfectly healthy step
could outrun the ceiling, get classified as a transport failure, re-run entirely, and escape
as a raw `LlamaRequestError`. Reproduced at a shrunk ceiling against a server streaming deltas
100 ms apart: 2 requests, 3,020 ms = 2× the ceiling. Fixed by flagging our own timeout
(`transportTimeout`), mapping it to `stoppedBecause: 'timeout'`, and raising the ceiling above
the budgets it has to contain. **Not** sized as a wedged-server detector — the step clock is
that, and it measures silence rather than elapsed time.

**22. `summaryBudget`'s warm branch reserved 8k for a request needing ~9.5k.** A `Session`
with `contextLength: 20000` reported a budget of 12,000; the request built from a transcript
filled to it measured **15,879 real tokens** on the live server, leaving 4,121 — enough for
compaction's `MAX_TOKENS` (3,000), not for its `RETRY_MAX_TOKENS` (4,500), which is the retry
that exists for exactly that truncation. The overrun is window-independent, because the tool
block is a fixed cost the budget never knew about. Now subtracted by name.

**24. `runHarnessTurn`'s overflow recovery escaped as a raw HTTP 400.** `send()` wraps its
retry and names the failure; the harness path did not. Also: `compactNow`'s nothing-to-gain
branch nulled `latestPromptTokens` even when that number came from the server's own refusal —
the one measurement that cannot be re-taken. Both fixed.

**25. `read_file`'s line numbering costs 3.09 tokens per line — DECIDED: keep it.**

Measured with the server's own tokenizer, same lines with and without the `${i+1}\t` prefix:
`contract.ts` +25.0%, `loop.ts` +22.4%, `read-file.ts` +25.2%, `session.ts` +23.6%. And the
intuitive fix is **worse**: left-pad-no-tab measured ~60% *more* overhead than the tab, which
is already the cheapest separator tested.

Not changed, on the audit's own reasoning. Law 3: 15,400 saved input tokens are ~900
output-token-equivalents, and generation speed does not degrade with context here. The real
bill is 21-37 s of prefill, paid once per read by the prefix cache. Against that, line numbers
are what lets the model ask for a range and cite a location, and what lets the reviewer point
at one. The audit ranks this last and calls it a decision; the decision is no.

---

## What was checked and came back clean

Named because it was **exercised**, not merely read. Silence elsewhere means nothing.

- **SSE tool-call parsing** — a `parallel` probe produced 4 concurrent `read_file` calls;
  `index` present on 28/28 fragments, `id`+`name` on each index's first fragment only.
- **Mid-argument truncation** — the finish chunk carried `delta={}`, so `client.ts`'s early
  return loses nothing.
- **`response_format: json_schema` genuinely constrains** — it overrode an explicit contrary
  instruction about key order. The gates' reliance on it is sound.
- **The 400 overflow body parses** — a real 220,010-token refusal returned exactly the shape
  `contextOverflowTokens` expects.
- **`reasoning_content` on an input assistant message IS rendered and charged** — 1,121 vs 283
  `prompt_tokens` for a 3,800-char blob, matching what the same blob costs as visible content.
  `appendTruncated`'s carry-forward is genuinely paid for.
- **`promptCacheCold` is not stuck** — 40000 / 192000 / 192000 across three probes. Both
  branches of `summaryBudget` are live.
- **The jail DOES defeat 8.3 aliases for denylisted names** — `ENV~1 → access denied to .env`.
- **`edit_file`'s exact-match path is fine**; only the whitespace fallback corrupted, and only
  with a leading blank line.
- **The unattended runner is protected from item 4** — `lastAcceptanceUnmet()` returns null and
  unattended treats that as not-done.
- **The UI does not wedge on a failed `send`** — item 21's original claim, tested and refuted.

**NOT exercised at all — this audit's silence covers none of it:** MCP servers, browser tools,
checkpoints/git store, outline, skills, memory, hooks beyond item 1's consequence,
`run_command` and the shell permission surface, the Tauri shell itself, the `csharp`/`sql`/
`web` tool families, `decisions.ts`/`worklog.ts` gate behaviour, compaction driven end to end
over a genuinely long real session, and the unattended runner end to end.

## The residual, chased down — and the audit's number does not hold

The audit closed on one loose end: during a 39,330-token cold prefill, "~12 of ~28 `/slots`
polls hit the 3 s timeout", making the prefill-extension backstop that items 7 and 8 lean on
"unreliable by roughly half".

**That frequency does not reproduce.** Driving a real 41,087-token cold prefill and polling
throughout with the shipped 3 s timeout (`spike/slots-during-prefill-probe.mts`):

```
21 polls, 0 timeouts, n_prompt_tokens_processed climbing 2048 -> 40571 in clean 2048 steps
=> 0/21 polls did not answer (0%)
```

But the audit was right about the mechanism, and measuring the LATENCY rather than counting
failures is what shows how thin the margin is. A second run, same probe, recording how long
each answer took:

```
took 2643ms  took 2522ms  took 2620ms  took 2559ms  took 2496ms  took 2607ms
took 2545ms  took 2630ms  took 2613ms  took 2655ms   ... and one at 3007ms -> TIMEOUT
answer latency: median 2607ms, worst 2655ms -> 89% of the 3000ms timeout
=> 1/13 polls did not answer (8%)
```

llama.cpp serves HTTP between decode batches, so during the exact prefill this extension
exists for, `/slots` is the slowest it ever is — and it answers at 89% of the budget it was
given. Not "unreliable by half"; a coin toss on a batch running slightly long. **8%, not 43%
— and every crossing killed a healthy step.**

Three things were wrong, and all three are fixed:

1. **The timeout was 3 s against a 2.6 s answer.** Now 8 s, which the same probe measures at
   34% utilisation, 0/13 failures. It costs nothing to raise: this question is only ever
   asked once a first-token window has already expired, when the alternative to waiting is
   giving up.
2. **`null` meant "stalled".** `slotPrefillProgress` returns `null` for "could not ask", and
   `fire()` sent it down the same branch as "the slot is not moving" — so a step doing
   nothing wrong died because the question about it went unanswered. Now tolerated up to
   three times at a shortened recheck (nothing was learned, so re-establish contact rather
   than wait out a batch), then the step dies as it always did.
3. **A backwards jump in the counter read as a stall** — new, found in the probe output
   rather than in the audit. `n_prompt_tokens_processed` belongs to whatever the SLOT is
   working on and carries the previous task's final value until the next one starts:
   `t+0s processed=23487` from the request before, then `t+1.5s processed=2048` from the one
   being measured. The test is now CHANGED, not GREW.

The cost of (2) is bounded on purpose: three unknown probes at a shortened interval, so an
unreachable `/slots` buys well under a minute of grace and then the step ends. Three existing
timeout tests had to be re-tuned because they exercise a hung server and that path is now
genuinely longer — which is the honest price of not killing healthy prefills.

---

# The rule that became a list of examples

Not from the audit — from driving the app afterwards. The request said *"make slugs contain
only lowercase letters, digits and single hyphens"*. The contract came back as ten criteria,
every one an instance, none the rule. The agent shipped code that passes all ten and violates
the rule, and the audit correctly affirmed 10 of 10.

Reproduced first, on three requests that each carry a general rule
(`spike/distill-rule-probe.mts`). The slug case, twice out of two:

```
run 1: 7 criteria, 0 state the RULE
   inst  The slug() function strips all punctuation characters from input.
   inst  slug('Hello, World!') returns exactly 'hello-world'.
   inst  The function never produces a leading hyphen in its output.
   ...
run 2: 7 criteria, 0 state the RULE
   inst  The slug() function converts all letters to lowercase.
   inst  The slug() function replaces multiple consecutive hyphens with a single hyphen.
   ...
```

Note what the model does: not only examples, but **decomposition into the parts it would
implement**. Every part is true of the shipped code. The closed set — "ONLY these characters"
— is the one thing no part carries, which is exactly why `_` and `&` survived.

**Prose did not fix it.** The ask already forbade generalizing a specific requirement; adding
the mirror sentence naming this failure verbatim, down to the example
`("lowercases", "strips punctuation", "no leading hyphen")`, still produced exactly those
three in the next run. This session has the lesson twice already: **this model follows the
grammar and negotiates with the prose.**

So the fix is structural. `CONTRACT_SCHEMA` gains a required `rules` array, ordered BEFORE
`criteria` — the same property-order lever `acceptanceSchema` uses to put evidence ahead of a
verdict, and one this session verified is genuinely enforced. By the time the model writes the
criteria list it has already had to isolate the rules, and the ask can then tell it not to
re-derive them. `readContract` merges rules into `criteria` (rules first, deduped), so nothing
downstream learns a new shape and no reader can skip a rule by only knowing about criteria.

```
rule survives into the contract:  0/2  ->  9/9 runs across three requests
```

and in the shape that was asked for:

```
RULE  slugs contain only lowercase letters, digits and single hyphens
      — e.g. slug('Hello, World!') returns 'hello-world', not 'hello,-world!'
```

## The half that was not enough

With the rule finally present, the audit **still affirmed it, 3 times out of 3**
(`spike/rule-audit-probe.mts`). It read the implementation, agreed with it, and never
evaluated `slug('Hello, World!')`. Worth being exact about what fixed that, because it is not
what it looks like: the model cannot simulate a regex — in one run it read the chain and
concluded, wrongly, that punctuation *was* stripped. What changed is that
`checkAcceptance` now refuses to affirm a universal claim from code nobody ran:

> A criterion that states a rule over EVERY input needs the rule to have been EXERCISED.
> Reading the implementation and agreeing with it is an assertion, not a demonstration.

Measured both directions, because the first attempt at this wording made the gate a wall —
it demanded a specific breaking input and rejected honest work 3/3:

```
                                    before   first try   shipped
broken work caught                    0/3        3/3        2/3  then 5/5   -> 7/8
honest work affirmed clean            n/a        0/3        3/3  then 4/5   -> 7/8
```

The middle column is the trap: a gate nothing can pass is not a gate. The shipped wording
accepts a run over inputs chosen to break the rule and does not insist on naming every one.

Two separate invocations of the same shipped code, three runs then five, kept apart rather
than pooled silently. Eight runs each way: the broken implementation is caught in seven, and
honest work is affirmed clean in seven. The one honest miss left a single criterion unmet,
which costs a fixer round rather than a wrong verdict.

One more thing the measurement forced: the distiller's invented cases are not merely
redundant. `slug("It's a test!!!") returns 'it-s-a-test'` is a criterion the audit will demand
evidence for, and it holds the task open for work nobody asked for — so the ask now says that
consequence out loud rather than only calling the cases untidy.

**Not solved, improved.** One run in eight still affirms the broken implementation, and one
in eight holds up honest work for an extra round. Against a baseline of 0/3 caught and a live
10-of-10 affirmation of a task that was not done, that is the trade worth having — but the
remaining miss is real, and it is the audit trusting a green run over cases that do not
exercise the rule.

---

# The answers that piled on top of the contract instead of into it

The other half of what the live run turned up. `foldAnswer` reads the understanding check's
answer, and `session.ts` did this with the result:

```ts
contract.criteria = [...contract.criteria, ...criteria].slice(0, 12)
```

A pure append. But the options in that question are readings of the SAME request the contract
was distilled from, so a ticked one is usually a paraphrase of a criterion already in there.
Measured on the real session's own data (`spike/fold-answer-probe.mts`): seven distilled
criteria, three ticks, **ten criteria** — items 8, 9 and 10 restating 2, 4 and 5 in slightly
shorter words. Each duplicate is audited on its own, gets its own plan item, and rides into
message 0 at every compaction.

`foldAnswer` now takes the contract's criteria and returns what it should BECOME. A tick that
aligns with a criterion confirms it rather than adding to it — and may sharpen it, but only
upwards: if the ticked wording covers strictly more, it replaces the criterion in place;
otherwise the criterion stands. Never the other way round, because a checkbox must not be able
to narrow what "done" means. That is the same rule the unpicked half already follows, for the
same reason.

```
the live case          : 7 criteria + 3 ticks -> 7   (was 10)
a tick that says more  : sharpens the criterion in place, still one criterion
a tick that says less  : the fuller wording stands
a genuinely new tick   : still added
```

Judged by `alignReadings` — the audit's own criterion matcher — with a new `readingCovers`
beside it for the "which of these two do we keep" question, on the same stemming and the same
stopword list so the two notions cannot drift. Where the matcher says two lines are not the
same thing, nothing is merged; a test states that boundary explicitly, because the first
version of it asserted a merge the matcher never claimed.

`existing` defaults to empty, so the fold is opt-in and every other caller is unchanged.


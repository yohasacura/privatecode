# Re-measuring everything against KAT-Coder-V2.5-Dev, 2026-08-22

The server stopped serving `Qwen3.6-35B-A3B-UD-Q4_K_XL` and started serving
`KAT-Coder-V2.5-Dev-MTP-APEX-i-quality-v2.gguf`. Every number in `DESIGN.md` §2 was measured
against the old one, and the whole design is arithmetic on those numbers — so they were all
re-taken. Build `b10202`, `--jinja` on, `total_slots: 1`, `n_ctx` 196608.

Probes, all runnable: `spike/throughput-probe.mts`, `spike/prefix-cache-probe.mts`,
`spike/prefix-diagnose.mts`, `spike/tool-choice-probe.mts`, `spike/constrain-probe.mts`,
`spike/gate-cost-probe.mts`, `spike/temperature-kat-probe.mts`,
`spike/acceptance-coverage-probe.mts`.

## 1. It is a FINE-TUNE of the model this project was designed for

Not a different model family: `KAT-Coder-V2.5-Dev` is **built on Qwen3.6-35B-A3B** and
post-trained by Kwaipilot with the KAT-V2.5 recipe — SFT on 127K examples, then RL — 35B
total, 3B active, Apache 2.0 (<https://huggingface.co/Kwaipilot/KAT-Coder-V2.5-Dev>). The
GGUF agrees: `general.architecture = qwen35moe`, 41 blocks, 256 experts, 8 used,
`nextn_predict_layers 1` (MTP), `full_attention_interval 4` with SSM parameters, tokenizer
pre `qwen35`. Trained context 262144, served 196608.

**So everything DESIGN.md reasons about the base model still applies** — the three laws, the
tool-call wire format, the recurrent-block economics. What changed is post-training
behaviour and the throughput numbers below, not the architecture.

Two things the model card records that this codebase should know:

- **Parallel tool calls were a training pathology.** "The model increasingly tended to issue
  a large number of parallel tool calls within a single turn — occasionally exceeding 70
  calls", suppressed with a reward penalty. `agent/prompt.ts` actively ENCOURAGES batching,
  and `agent/loop.ts` bounds a step by result CHARACTERS, not by call count — so a batch of
  cheap-result calls (70 `list_dir`s) is bounded by nothing. Observed live it behaves
  (83 calls over 35 steps, ~2.4 per step), so this is a latent risk, not a current fault.
- **`preserve_thinking` is documented by the model authors** as the way to keep reasoning
  across history. It is measured a NO-OP here (§3), so that is a llama.cpp-side gap in this
  build rather than a model one.

The chat template is Qwen-derived and was diffed against the old one. The two properties this
codebase depends on are unchanged:

- `tools` renders in a system block at the very FRONT of the prompt, **before** the system
  message;
- `preserve_thinking` / `ns.last_query_index` still control whether an assistant message keeps
  its `<think>` block.

New in this template: it raises on a system message that is not first, on an unknown role, and
on a message list with no user message at all.

## 2. Throughput — output got dearer, prefill got cheaper

| quantity | on record (Qwen3.6) | measured (KAT-Coder) |
|---|---|---|
| prefill | 545 tok/s | **726–739 tok/s** (at 8k and 24k) |
| generation | 60.6 tok/s | **41.7–42.9 tok/s** |
| MTP draft acceptance | 0.73–0.76 | **0.46–0.52** on real generation |

So **one output token now costs ~17 input tokens**, not 13. Law 2 is more true than it was,
not less: diff-style edits and short tool results matter more than before. Note the acceptance
figure is 100% on the two-token replies and ~50% on real prose — the low-token rows are not
evidence of anything.

## 3. Where a gate's time actually goes — and it is not where the static analysis said

Measured with the server's own `prompt_progress.cache`, which reports how much of the prompt
it did not have to process.

**The tools array is the whole cost.** One acceptance gate on a mid-session context:

| | prompt cached | re-prefill | wall |
|---|---|---|---|
| as the harness sent it (one-tool array) | **0.0%** | 34,347 tok | **56.7 s** |
| identical tools array | 98.4% | **549 tok** | **0.8 s** |

Measured against a clean re-warm (`spike/append-cost-probe.mts`). For scale, an ORDINARY
step — appending an assistant call and its tool reply — costs 1,228 tokens on the same
conversation. **A gate is now cheaper than one more step**, and there is nothing left to win.

(An earlier run of this measurement reported 4,186 tokens / 7.6 s. That probe alternated
between several different prompts, which shuffles llama.cpp's RAM prefix cache; with the
conversation re-warmed immediately before the gate, the real figure is 549.)

Three corrections to what was written before any of this was measured:

- **Returning to the conversation afterwards is free.** It was predicted to cost a second full
  prefill. It does not: llama.cpp keeps several prompt prefixes in RAM (`--cache-ram`,
  default 8192 MiB, and one full 196k context is ~4 GiB of KV), and the measured return is
  100% cached. So a gate costs its own prefill once, not twice.
- **The appended `user` message costs almost nothing**, and the `last_query_index` theory of
  why it might was wrong — see the next point.
- **`preserve_thinking` as a per-request kwarg is redundant here, not broken.** The launcher
  (`local-standard-server`, `ArgumentBuilder.cs`) already starts the server with
  **`--reasoning-preserve`** — "preserve reasoning trace in the full history, not just the
  last" — and `/props` reports `chat_template_caps.supports_preserve_reasoning: true`. So the
  behaviour is on globally and asking for it again changes nothing. Verified directly: a
  FINISHED turn's thinking is carried into the prompt (1,442 tokens for two assistant
  messages; removing it from the payload drops the prompt from 1,800 to 358 tokens).

That last point has a consequence beyond the gates, in §8.

## 4. How to force a structured answer without paying for it

The gates needed their one-tool array only to guarantee a shape. Three candidates, all with
the session's own unchanged tools array present:

| mechanism | constrains? | prompt untouched? |
|---|---|---|
| named `tool_choice` (`{type:'function',function:{name}}`) | **no** — accepted and ignored | yes |
| GBNF `grammar` | rejected: *"Cannot use custom grammar constraints with tools"* | — |
| **`response_format: json_schema`** | **yes, 5/5** | **yes — 99.1% cached** |

The named-`tool_choice` result is the important one. Offered read_file / search_code /
report_acceptance and told to call the last, on a prompt that invited a read, the model called
`read_file` **5 times out of 5**. Every gate checks `call.function.name !== '<expected>'` and
returns null, so shipping that "fix" would have left the acceptance gate, the premise gate and
the understanding check silently never running, while every test and every log looked healthy.

`response_format` constrained 5/5 on the same adversarial prompt. It is what the gates now use
(`core/src/session/forced-json.ts`).

## 5. Temperature: no change warranted

`sampling.ts` pins 0.6 and cites `SPIKE-TEMPERATURE.md`, which measured Qwen3.6. This model's
GGUF carries `general.sampling.temp = 1` (top_k 20 and top_p 0.95 agree with what is sent).
Re-run with the original method — one fixed hard edit, `tool_choice: 'required'`, a 15-tool
array, n=6 per arm:

| temperature | usable | wall median | thinking median | truncated |
|---|---|---|---|---|
| 0.6 (pinned today) | **6/6** | 5.6 s | 58 tok | 0 |
| 1.0 (model metadata) | **6/6** | 5.9 s | 56 tok | 0 |

No difference, so **the value stays at 0.6**. What is worth recording is why the question is
now much less interesting: this model thinks ~58 tokens on the task where Qwen3.6 thought
1192–1991. The bimodal thinking runaway that the 0.6 pin exists to prevent did not appear in
either arm. The pin is no longer load-bearing; it is simply not doing any harm.

## 6. The acceptance audit, against the real model

Six criteria, a transcript that genuinely did about half the work, five rounds:

- The audit is properly skeptical — it never once closed the task, and named the missing
  reproduction test and the unrun suite every time.
- It reported on all six criteria in 4 of 5 rounds.
- In 1 of 5 it paraphrased every criterion so heavily ("Gap-free under concurrency") that one
  paraphrase matched nothing, leaving a criterion **never reported on**. Before
  `withUnreportedCriteria`, that is exactly the round that would have been recorded as met.

So the guard fires on real traffic at roughly the rate the audit predicted, and the gate holds
the task open when it does.

## 7. `presence_penalty`: measured, not adopted

The model card's example code sets `presence_penalty: 1.5`; this client sends none. Tested
the same way DRY was tested when it was switched on for a day and measured out again
(`spike/presence-penalty-probe.mts`, n=3 per arm):

| | five paths x three listings, verbatim | asked for 40 identical lines |
|---|---|---|
| `presence_penalty 0` (today) | **45/45** | 39 exact repetitions |
| `presence_penalty 1.5` (model card) | **45/45** | 39 exact repetitions |

It neither corrupts identifiers — the failure that killed DRY — nor suppresses a degenerate
repetition. It does nothing here, in either direction, so **it is not adopted**: a sampling
parameter that provably changes nothing is pure risk on the day the model changes again.

This is the same shape as the DRY result already recorded in `sampling.ts`: the penalty
loses to the instruction wherever the model has no plausible alternative token, which is
exactly the case a coding agent lives in.

## 8. `--reasoning-preserve` is load-bearing, and DESIGN.md's §4 row about it is now false

`DESIGN.md` §4 says: *"Past completed turns drop their thinking (matches Qwen's template);
thinking is preserved WITHIN the current turn across tool round-trips."* The second half
holds. **The first half does not**, because the server is started with
`--reasoning-preserve`: every finished turn keeps its full reasoning in the prompt, forever.

This is not a misconfiguration — it is what makes the prompt genuinely append-only across
turn boundaries, and it is why the conversation measures 100% cached after a gate. Turning it
off would reclaim context and make every new user message re-prefill from the previous turn's
first assistant message. Given this app's shape — long autonomous turns, few user messages —
keeping it on is the right trade, and it should stay on. The context accounting is honest
about the cost: `transcript.ts` and `session.ts` both count `reasoning_content` in the fill
estimate, so nothing is under-counting.

What it does change is the arithmetic of running out of room. Thinking accumulates at roughly
600-1400 tokens per finished step and is never reclaimed, and reclaiming it is what
compaction ends up doing — at the price of ~2,500 GENERATED tokens, which at 42 tok/s is a
full minute of the user's time.

**An opportunity, not yet built:** dropping `reasoning_content` from turns that are already
FINISHED would reclaim a large fraction of the window for the price of one re-prefill and
*zero generation* — measurably cheaper than a compaction, and lossless for everything except
the model's own old deliberation, which the template was designed to discard anyway. It would
cost one re-prefill at the moment it fires. That is a policy decision (it trades the
append-only property at that instant), so it is recorded here rather than implemented.

## 9. The reviewer misses the cross-file defect, against a prompt that forbids exactly that

`spike/reviewer-probe.mts` plants a defect that is invisible in the patch: the diff makes
`InvoiceService.allocate` take a row lock and is perfectly correct on its own, while a SECOND
service in a file the diff never touches still reads the same counter unlocked. Run against
this model, the reviewer **found it, named it, and deliberately did not report it**:

> One thing I noticed but am **not** reporting: `src/credit-note.ts` has the identical
> read-then-update pattern without a transaction or row lock. That's a pre-existing bug in a
> different service. The ask was specifically about invoice numbers, so this is out of scope.

Verdict: no defects. The turn ends reviewed and clean over a goal that is not met.

This is not the `response_format` conversion — `REVIEW_SYSTEM` and `buildReviewBrief` are
untouched by it, and the decision is visibly made in the READING turn, before the verdict call
exists. It is a straight instruction-following miss, and the instruction could hardly be more
explicit: REVIEW_SYSTEM already says *"Say so, and name the file, even when that file is
nowhere in the diff"*, *"SCOPE limits what may be changed, not what may be true"*, and — 
naming the produced behaviour precisely — *"A finding that ends 'however this is out of
scope' is worse than silence."*

So it is this project's own law demonstrating itself: **instructions do not route behaviour
(0/703); structure does.** Three paragraphs of correct, emphatic prose lost to one habit.

The fix therefore has to be structural rather than more prose. The reviewer currently
volunteers a list, which lets "in scope" and "is a defect" collapse into one judgement. Asking
it the goal question SEPARATELY and under force — a required `goalMet: boolean` beside
`where`, answered about the goal rather than about the diff — would make the out-of-scope
escape hatch inexpressible instead of merely discouraged. Not built; recorded as the next
thing to try, with a probe that already reproduces the failure.

### Reproduced a second time, in a full live session

`spike/full-session-probe.mts`, run again after the whole Tier-B/C batch: 37 steps, 24.9 min,
no retries, no timeouts, no compaction. Both gates fired and both passed —
`{met:6, unmet:0, kind:'criteria'}` and `{met:0, unmet:0, kind:'review'}` — and the planted
cross-file defect was **still on disk at the end**, `src/credit-note.ts` untouched.

That outcome is correct for every gate except one, which is the point:

- The six distilled criteria are all about invoice numbering. Nothing in the contract says
  "and the same bug nowhere else", so the acceptance audit affirming 6/6 is honest.
- The diff review is the ONLY gate chartered to notice that the goal is unmet because the
  same problem survives somewhere the change did not reach — `REVIEW_SYSTEM` says exactly
  that, twice. It ran, and reported nothing.

An earlier run of the same probe did fix `credit-note.ts`, but on the model's own initiative
while addressing three unrelated findings the reviewer had raised about the test — not
because the reviewer named it. So the reviewer has now missed this defect in both recorded
runs, and the one time it was fixed was luck.

This is the strongest open item in the codebase: a turn can end reviewed, audited, verified
green and *done* over a goal that is not met. The fix is structural — a required `goalMet`
answered about the GOAL rather than about the diff, so "out of scope" stops being an
expressible way to decline — and it is not built.

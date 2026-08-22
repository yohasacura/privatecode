# PrivateCode — second audit, 2026-08-22 (post Tier-A / forced-json)

Read-only audit by 6 area readers + 6 adversarial verifiers, three of the lanes pointed at
the changes made earlier the same day. 38 raw findings, **33 survived** refutation, 5 refuted.
It found **three regressions in that morning's work**, which is what it was asked to do.

## Status

**Everything in sections 0, A, B and the actionable half of C is DONE**, each with a test.
Core 1114 -> 1159 tests, app 281 -> 282, both typechecks clean throughout.

Fixed here: R1-R4 (the three regressions plus the stale cache flags), A4 (a failed audit was
indistinguishable from a clean one, so an unattended run could report `done` on a task nothing
had checked), A5 (the reviewer's verdict swapped the tools array over the fattest transcript
in the system), B1-B4, B6-B15, and from C: the compaction tool block, both stale prefill
constants, and `background_task`'s unvalidated `ready_when`.

**B5 was taken after all, in the safer order.** The three open decisions were resolved by
measuring rather than by preference — see below. Every gate in the harness now carries the
session's own tool array; the only remaining `tools: [X]` swap is `groupLines`, which rides
no transcript and is documented in place as deliberate.

The three §C decisions, and what decided them:

- **Compaction budget, leg 2.** The 40k cap was justified by a COLD prefill ("sizing it to
  the window produced a request that took as long as the problem it was solving"). Leg 1
  inverted that: the request now shares the tool block and system message, so sending the
  whole transcript is a pure append while capping it makes `fitForSummary` drop the middle —
  and dropping the middle is a mutation that re-reads ~40k tokens for nothing. Resolved by
  keeping the cap for the case it was measured on and only that one: `summaryBudget()` now
  reads `promptCacheCold`, which the session already maintains for the step clock.
- **`fillMarksSeen`.** Per CYCLE. The nudge is advice about an imminent compaction, and there
  is one every cycle; once-per-session meant every cycle after the first was silent, so on a
  long run the warning that mattered was the one nobody was there for. Cleared at the swap.
- **`edit_file`'s whitespace fallback.** Fixed rather than left. That branch is entered
  *because* the model's whitespace did not match, so its indentation is the half already
  known to be wrong; the replacement is now re-anchored onto the indentation the matched
  window actually had, with the block's internal structure preserved.

And the strongest item, which was not in this document at all:

- **The reviewer's goal question is now structural** (`SPIKE-KAT-CODER.md` §9). It used to be
  asked for a list of defects, which let "is it a defect" and "is it in scope" collapse into
  one judgement it could decline — watched twice finding the planted cross-file defect,
  naming it, and returning an empty list. `goalMet` is now a required boolean asked about the
  GOAL, so "out of scope" is not an expressible answer. Live: the planted defect went from
  MISSED (twice) to **FOUND**, with the file and the reason named.

Superseded note, kept for the record:

**B5 had been deferred:** §D says do B3 or B5, not both; B3 (fix `distillContext`'s
clip) is the conservative half and is done. B5 deletes `distillContext` and converts two more
gates — the same recipe that produced R1 — and is worth doing only with the prose-migration
step done first and a live measurement after. Left as a decision.

Also left as decisions, as §C frames them: the compaction budget's leg 2, `fillMarksSeen`'s
per-session vs per-cycle intent, and `edit_file`'s whitespace-tolerant fallback.

One finding this document did not have, added later from a live run and worth more than most
of what is below: `docs/SPIKE-KAT-CODER.md` §9 — the diff reviewer sees the planted
cross-file defect, names it, and declines to report it as "out of scope", against a prompt
that forbids exactly that in three places.

---

# Follow-up plan — PrivateCode audit, 2026-08-22 (post-Tier-A / forced-json session)

## 0. Regressions first — things this session's changes broke

Three confirmed regressions, plus one "regression by omission". These are the urgent set.

**R1. Every `description` in the three converted schemas is now invisible to the model.**
`core/src/session/understanding.ts:91-99`, `core/src/session/contract.ts:933-935`, `core/src/session/premises.ts:65-74`; placement at `core/src/llama/client.ts:142-147`.
A `json_schema` is compiled to a GBNF grammar and contributes **zero prompt tokens** — measured live twice (identical request with and without `response_format`: `prompt_n 521 / cache_n 517`; a second probe with ~480 chars of `description`: 266 prompt tokens both ways). ~3.3k chars of load-bearing instruction that was rendered at the front of the prompt before `fc03242` is now dead text. Reproduced: the shipped reading gate returns `"change the invoice number generation logic in InvoiceService.cs"` — a step *and* a file, the two things the invisible description forbids — and those lines are what `buildQuestion` shows the user as tick-boxes. The English pin is now unguarded by anything (`readOnce`'s ask, `understanding.ts:168-175`, has no language clause), and `core/test/english-only-output.test.ts:35-39,66-69` passes only because `capture()` was changed to stringify `response_format`.
**Fix:** move the load-bearing sentences into the rendered user message — `understanding.ts:168-175`, `premises.ts:304-310` (needs the folder-prefix half), `contract.ts:971-975`. Keep schemas for shape only. Re-point `english-only-output.test.ts` at `sent`, not at `response_format`.
Two comments now assert the opposite of the truth and must be corrected in the same patch: `understanding.ts:57-59` and `contract.ts:951-953`.

**R2. The plan card un-ticks a completed step because the audit *didn't mention* it.**
`core/src/session/session.ts:2429-2432`, fed by `core/src/session/contract.ts:1054-1057`.
A `met:true` paraphrase the matcher cannot place leaves the index uncovered; `withUnreportedCriteria` appends the criterion **verbatim**, so `unmatched` is empty, the `unmatched.length > 0` guard at `session.ts:2411` does *not* fire, and `syncTodosWithAudit` flips the user's ticked todo back to `pending`. `checkedState` is written as "N UNMET (the audit did not report on this criterion)". Pre-fix the box stayed ticked and the gate closed — this is strictly new damage on a complete task.
**Fix:** carry provenance on the report (`unreported: true`, or a separate list) and let `syncTodosWithAudit` un-tick only on gaps the audit actually asserted. An unreported criterion renders as "not audited this round", not UNMET.

**R3. `$FILE` in single quotes, or adjacent to another token, no longer substitutes.**
`core/src/format/runner.ts:63-65` emits `$FILE = '<path>'; ` and line 95 concatenates the rule verbatim, leaving expansion to PowerShell. Probed on this machine (`powershell.exe -NoProfile`): bare → `src/a b.ts`; `'$FILE'` → literal `$FILE`; `$FILE.bak` → empty; `$FILEX` → empty. Under the previous `split('$FILE').join(path)` (per `docs/AUDIT-2026-08-22.md:29`) all three worked. `npx prettier --write '$FILE'` now runs against the literal string, exits 2, feeds the model a phantom formatter error on every write, and after `MAX_FAILURES = 3` formatting is off for the session with no on-screen signal. `format/config.ts:80` only checks `includes('$FILE')`, so nothing is rejected at load; `formatter.test.ts` only ever uses bare `$FILE`.
**Fix:** rewrite `'$FILE'`/`"$FILE"` → `$FILE` in the rule text before prepending the assignment, and reject at load (beside `config.ts:80`) any `$FILE` followed by a word char or a dot, naming the rule. Also correct `config.ts:27` — the path passed is mount-relative, not workspace-relative (`runner.ts:93`).

**R4 (regression by omission). Three call sites still declare the cache displaced after the rewrite removed the divergence.**
`session.ts:941-945`, `:1180-1181`, `:1241-1245` set `compactionDisplacedCache` and `promptCacheCold` on the claim that "the check's prompt diverges from the conversation (different tool list)" — while line 947 passes `this.stepSchemas()`. Per `SPIKE-KAT-CODER.md §3` the gate is an 88.2%-cached append and the return is 100% cached. Cost is real, not cosmetic: `session.ts:3434-3437` returns a StepPreamble → `loop.ts:626-631` zeroes `charsAtLastRequest` → `firstTokenBudget` prices the whole prompt fresh → the next step (and the acceptance fixer built at `session.ts:965`) runs on `coldStartTimeout()` instead of the ordinary budget. A wedged server after a gate is caught minutes late.
**Fix:** drop both assignments at the three converted sites and correct the comments. Keep them at `freshReview` (`session.ts:1018-1019`) and `runBackgroundCompaction` (`session.ts:3125`), which really are fresh contexts.

Explicitly **not** regressions, despite being framed as such by the lanes: the `forcedJson` null-swallow (#2) and the flag-before-generation persistence (#4) are byte-for-byte pre-existing — `git show fc03242^` shows the same `catch { return null }` and the same flag block. Do not let the follow-up commit message claim otherwise.

---

## A. Do now

Ranked by value/(effort × risk). A1–A3 are the regressions above; A4 is the highest-value correctness item; A5 the highest-value speed item.

| # | Item | Where | Cost / failure | Fix | Effort |
|---|---|---|---|---|---|
| **A1** | R1 — schema descriptions unrendered | `understanding.ts:91`, `contract.ts:933`, `premises.ts:65` | Reading gate emits steps-and-files as user-facing options; English pin unguarded; two comments false | Move prose to the ask; schema for shape only | S |
| **A2** | R2 — un-tick on "not reported" | `session.ts:2429` | Completed step un-ticked, false UNMET in `checkedState`, a wasted fixer round on a finished task | `unreported` provenance flag | S |
| **A3** | R3 — `$FILE` quoting | `format/runner.ts:64` | Formatting dies silently 3 edits in; model chases a phantom error | Normalise quoted forms + load-time reject | S |
| **A4** | Unattended run cannot tell "audit could not run" from "nothing unmet" | `session.ts:950`, `unattended.ts:203-208` | `forcedJson` returns null (transport, truncation, empty `items`) → `lastUnmetCount` stays at its `0` initialiser (`session.ts:3220`, only writer is `:956`) → run reports **done** on a task never audited once | Discriminated `forcedJson` result + `lastAcceptanceRan` / `number \| null`; unattended treats "could not audit" as `blocked` | S–M |
| **A5** | `reviewVerdict` swaps the tools array over the fattest transcript in the system | `contract.ts:1209-1211` | Re-prefills the whole reviewer transcript from zero at the end of **every writing task**: ~19k tok = **26 s** modest, ~60k tok = **82 s** large. Measured: 21-tool vs 1-tool renderings share 1171 chars; vs no-tools, 19 chars | Convert to `forcedJson` with `REVIEW_SCHEMA` + the reviewer's own 5 schemas passed down from `session.ts:1124`. `disableThinking` does **not** void the prefix (measured: common prefix 1196/1196) | S |
| **A6** | R4 — stale cache-displaced flags | `session.ts:944` | Post-gate steps run on `coldStartTimeout()` for a re-prefill that no longer happens | Drop 2 assignments × 3 sites | S |

**A4 must land before A5 and before any further `forcedJson` conversion.** Every conversion widens the surface of the silent-null swallow; converting `reviewVerdict`, `distillContract` and `decomposeTodos` onto a helper that turns a 400 or a transport failure into "nothing to report" is how a one-turn observability defect becomes a task-wide one.

Sub-items folded into A4 (same helper, same patch):
- `forced-json.ts:64-71` never reads `result.finishReason` (it exists, `types.ts:124`), so a `length` truncation under the grammar is indistinguishable from a refusal.
- `contract.ts:1014`: `{"items":[]}` is legal under `ACCEPTANCE_SCHEMA` (no `minItems`) and I generated one live with `finish_reason: stop`. It returns null and therefore **bypasses `withUnreportedCriteria` entirely** — the Tier A4 fix does not cover its own degenerate case. Add `minItems: 1` and return `{unmet: [], met: 0, metCriteria: []}` instead of null.
- `session.ts:1178-1179` / `:1238-1239` persist `premisesChecked` / `understood` **before** the generation. A transport failure retires both checks for the whole task and across a resume. Persist only on a real answer; a genuine refusal keeps today's behaviour. Note the gates call `client.chat` directly, so `loop.ts:1092-1122`'s one-shot `waitHealthy` retry does not cover them.

---

## B. Worth doing

Ordered within the group by value/(effort × risk).

1. **`withUnreportedCriteria` double-reports the paraphrased criterion** — `contract.ts:1042-1060`. `unmet.length` can exceed `criteria.length`; the fixer gets the same criterion twice with contradictory reasons, one of which ("the audit did not report on this") no edit can close; counts read "5 met, 2 unmet" of 6; `clean` never latches so the next done-turn re-pays the gate. Fix: bind the single unmatched item to the single uncovered criterion; drop unmatched paraphrases from `unmet` once their criteria are added. *(Ship with A2 — same function, same test file. `contract.test.ts:116-130` only tests the paraphrase the matcher **can** place.)*
2. **Verify fingerprint is one slot for all folders** — `session.ts:3207`, key built per-folder at `:2265`, stored shared, overwritten with `'ok'` at `:2250`. Two writable folders (`api` green, `web` red) → the full 6,000-char build log re-appended at **every** write boundary: ~16k wasted prompt tokens per refactor, permanently, in an append-only transcript. Fix: `Map<string,string>` keyed on `job.folder`. No test covers multi-folder (`verify-dedup.test.ts`, `midturn-feedback.test.ts` are single-folder).
3. **`distillContext`'s 2,000-char clip skips tool_call arguments** — `contract.ts:176-183`. `typeof m.content !== 'string'` short-circuits on `content: null`, so a write-heavy tail (whole files in `tool_calls[0].function.arguments`, bounded only by `DEFAULT_MAX_TOKENS_PER_STEP = 8000`) is returned unclipped — and `content: ''` short-circuits the length test too, so *no* tool-call message is ever clipped by any path. The codebase already learned this twice (`compaction.ts:126-131`, `session.ts:3276-3286`). Fix: size with `approxTokensOf`.
4. **Stale `turnStartIndex` threaded by value across a compaction** — `session.ts:2060` → `:862` → `:980` → `:1016`. A fixer turn's `beforeStep` compacts (210→9 messages); the field is remapped at `:3056`, the captured local is not; `slice(190)` yields `[]`, `diff.length` is 0, `freshReview` returns before the reviewer is built and before any `onAcceptance({kind:'review'})` — the A6 ambiguity through a different door, on the largest turns. The comment at `:2056` names this exact hazard one line before the value is captured. Fix: read `this.turnStartIndex` at point of use; drop the parameter.
5. **`distillContract` + `decomposeTodos` pay cold prefills at task start** — `contract.ts:208-211`, `:563-566`; call sites `session.ts:1990-1992`, `:2379-2381`. Three mutually distinct tools arrays → three distinct cold prefixes. Steady-state waste ≈ **11 s/task** (the leading `[CONTRACT_TOOL + message 0]` block does repeat across tasks and llama.cpp retains several prefixes); much larger on task 1 and under B3's clip hole (2 × 44 s). `decomposeTodos` is conditional (`session.ts:2371-2379`: ≥4 criteria or interfaces present). Fix: convert both to `forcedJson` with `stepSchemas()` and **delete `distillContext`** — send the full transcript. The justification at `contract.ts:167-171` is circular: the tool list is only different because these two callers make it different. *Do B3 or B5, not both — B5 subsumes it.*
6. **Every harness fixer message replays as the person's own** — `replay.ts:156`, invariant stated at `:139-140`. `acceptanceFailureMessage` (`contract.ts:1064`), `reviewFailureMessage` (`contract.ts:1247`), `verifyFailureMessage` (`verify/runner.ts:80`) and `OVERFLOW_RETRY_NOTE` (`session.ts:474`) start with unbracketed prose; the escalation at `session.ts:1383` uses one newline so `replay.ts:188`'s `/^\r?\n\r?\n/` fails too. On resume they render in the `›` caret row; `export.ts:24-26` writes them under `## You`; `session-search.ts:43-49` searches them as "what a PERSON said". `session.ts:2277-2281` *is* correctly wrapped, which proves the convention. Zero test coverage. Fix: export the four openers as constants and flag them `harness: true` in `replayEntries`.
7. **Hook / formatter disable themselves on a legitimate non-zero exit** — `hooks.ts:135`, `format/runner.ts:106`. `npm run lint` finding problems is counted identically to a broken command; after 3 the hook is skipped (`hooks.ts:122`) with no note, and the formatter returns `{ran:false, note:undefined}` so `edit-file.ts:314` adds nothing either. `MAX_FAILURES`'s own comment says the intent is "a broken command must cost time once". Fix: count only the catch arms (`hooks.ts:141`, `runner.ts:120`); if a cap on non-zero exits is still wanted, emit a note the first time it trips.
8. **`browser` screenshot returns a path no multi-folder workspace can resolve** — `browser.ts:329` assembles `.privatecode/state/browser/<name>` from constants instead of `workspace.display(abs)`. `Workspace.resolve` (`workspace.ts:255-265`) throws. The decisive victim is the UI's own render: `transcript.tsx:901` matches the anchored regex, `:769-782` calls `fs.read`, `host.ts:1594` resolves and throws — so the inline image, the only reason the PNG is saved (`browser.ts:333-335`), renders as an error. Fresh instance of the bug `output-log.ts:72-79` records fixing for `spillToLog`. Same patch: `shotCounter` (`browser.ts:77`) is a module global from 0, silently overwriting `shot-001.png` from the previous run.
9. **Gate results ride the verify channel** — `host.ts:913-920` emits `command`/`ok`/`attempt` only, so `state.ts:982-987` falls to the `exited ${exitCode ?? '?'}` arm: *"verified with **contract check: 4 met, 2 unmet** — exited ?"*, in the transcript and in `export.ts:51`. Worse, `session.ts:1297` fires the same `onAcceptance` from the **understanding gate** with `met: criteria.length` (the count of *newly added* criteria) and `unmet: 0` — asserting a contract check passed before any work has been audited. Fix: separate protocol event; stop routing criteria growth through `onAcceptance`.
10. **Fixer turns have no context-overflow recovery** — the `contextOverflowTokens` catch at `session.ts:2028-2055` wraps `agent.runTurn` only; `:967`, `:1028`, `:1353`, `:1387` are bare awaits and `send()` has no `catch` (`:2126-2131`). A throw skips `recordTurn`, the meta save, the tail `appendMessages` and `maybeStartBackgroundCompaction`. The window does recover (`composer.tsx:559-575` → `send-failed`), but **an unattended run misclassifies the throw as transport** (`unattended.ts:141-158`) and re-sends into the same over-full transcript with `latestPromptTokens` never corrected — three overflows reported as `server-unreachable` against a healthy server. Fix: one helper reproducing the main path's recovery for all four call sites.
11. **The acceptance schema makes the model retype every criterion** — `contract.ts:929` requires `criterion: {type:'string'}` while `:968-970` already numbers them. ~180 output tokens/round × 2 rounds (`MAX_ACCEPTANCE_ROUNDS = 2`, `session.ts:423`) ≈ **8.6 s/task** at 42 tok/s, and the free-form restatement is the *source* of the paraphrase-matching apparatus. Fix: `index: {type:'integer', minimum:1, maximum:n}` — requires making `ACCEPTANCE_SCHEMA` per-call (it is currently a module const at `:917`). **This retires `matchCriterionIndex` on the audit path and thereby retires most of A2 and B1** — see §D.
12. **`csharp_nav` indexes only the primary folder** — `csharp-nav.ts:92-95`, `Workspace.root` = `mounts[0].root` (`workspace.ts:165-167`). With a primary that contains *some* C# and the symbol in an attached folder, `Program.cs:326/357` returns `ok:true` with `no symbol named "X"` and `csharp-nav.ts:119-126` prints it — a confident false denial, stable for the session (`nav-process.ts:235` only clears `loadedRoot`). Rows are also relativised against the primary (`nav-process.ts:249-255`), so out-of-root hits come back as raw absolute paths no other tool can address. Fix: index every mount, or pick the mount holding the .sln and name it in the result.
13. **Compaction briefing section 4 duplicates the appended inventory** — `compaction.ts:49-51` vs `:627-636`, joined at `session.ts:2946`. ~320 output tokens ≈ **7.6 s** per compaction, restating open todos the harness prints from the live store two lines later. Drop section 4 and renumber. **Keep section 2** — the instruction asks for "what changed and why", and `continuationInventory` supplies paths and file bodies, never rationale. Note the 4,022/4,298-token overruns at `compaction.ts:216-222` are attributed in-code to thinking, and `disableThinking: true` already fixed that — do not re-bank that saving.
14. **Workspace panel re-scans every repo on every tool result** — `App.tsx:220-221` counts every resolved tool (reads, `todo_write`, everything) and passes it as `reloadKey` at `:780`; `WorkspaceTab` is mounted from launch (`context-panel.tsx:65`) and both effects depend on it. Each bump = `describeFolder` + `discoverRepos` per mount = git process spawns plus two uncached recursive readdirs (`checkpoints/units.ts:62-89`, MAX_DEPTH 6 / MAX_DIRS 5000), on the same laptop running the agent's tools, to refresh a listing a read tool cannot have changed. `tree.tsx:226-244` already does the correct filtered version of the same signal. The contract comment at `context-panel.tsx:43` describes behaviour `App.tsx` does not implement. *(Local CPU, not prefill — the llama numbers do not apply.)*
15. **`edit_file`'s diff describes pre-format bytes when the formatter writes then exits non-zero** — `runner.ts:105-118` returns `text: null` without re-reading, `edit-file.ts:315-320` therefore keeps `outcome.text`, and `:340` renders a diff of bytes no longer on disk — breaking the invariant `edit-file.ts:306-311` states as the reason formatting lives inside the write tool. Needs a fixer-linter rule (`eslint --fix`), not the documented `prettier --write`. Fix: re-read after the command regardless of exit code.

---

## C. Noted / needs a decision

- **Compaction summary sends no tools at all** — `compaction.ts:207-224` + `client.ts:135` (`if (req.tools?.length)`). Measured no-tools/with-tools common prefix: **19 characters**, so the comment at `compaction.ts:194-206` ("prefill ≈ 0") is false and DESIGN.md §4's ~90 s budget is really ~177 s. Leg 1 (pass `stepSchemas()` alongside `toolChoice:'none'`) is cheap and safe and recovers the ~4.8k tool block + system message. Leg 2 (raise `summaryBudget()` from 40,000 back to `contextLength − SUMMARY_OUTPUT_RESERVE` so `fitForSummary` stops dropping the middle at the 140k trigger) is where the claimed ~55 s and the accuracy win live — **and it is a decision, not a fix**: the 40k cap exists because "sizing it to the window produced a request that took as long as the problem it was solving" (`session.ts:301-308`), reasoning that was correct for a cold prefill. Do leg 1; measure; only then decide leg 2. Fires once per ~140k tokens, not per task.
- **Prefill constants are sized against the old model** — `PREFILL_MS_PER_TOKEN = 4` (`loop.ts:38`) encodes 250 tok/s against a measured 726–739; `TOOL_SCHEMA_TOKENS = 2_600` (`session.ts:470`, measured on 15 tools) against a re-measured 4,779 for today's 21-tool array (`tools/default-set.ts:74-78`). Costs no healthy step any time — 196k at 730 tok/s is 269 s, inside `MAX_COLD_START_MS` — it only means a wedged server stalls the window for the full 9 minutes instead of ~3.5. Proposed: 2 ms/token, 4,800 tokens, reconcile the third contradictory figure at `session.ts:3416`, then re-examine the 540 s ceiling. **Retune only after A6 lands** — A6 removes the spurious cold-start budgets that make the ceiling bite.
- **Reviewer has no turn-level result budget** — `session.ts:1113-1115` bounds one step (96,000 chars), `loop.ts:715` resets it per step, and the reviewer Agent has no compaction. Overflow needs ~936k chars across 6 steps (≈16 max-size reads); the outcome is an unreviewed turn, i.e. the pre-review status quo. The cheap half — make `freshReview` emit an explicit "review could not run" — is already covered by A4's discriminated-result work; take it there.
- **Retry re-arms the core clock but not the window's countdown** — `loop.ts:1127-1129` vs `host.ts:1258` (`step.retry` with no payload) and `state.ts:784-804` (spread keeps the stale `firstTokenTimeoutMs`). Display-only: a 120k-char transcript gives the core 210 s against the app's ~90 s, so the readout sits at "0s to timeout" for ~2 minutes of a healthy cold prefill (not the eight claimed — that needs ~450k chars). Fix is mechanical: have `onStepRetry` carry the budget the way `onContinuation` does.
- **`saveMeta` swallows a first-save failure** — `store.ts:245-251`; `list()` keys entirely off `*.meta.json` (`:166-189`) and is the only writer of `problems`. Self-heals on the next of the ~8 per-turn `saveMeta` calls, and a directory-level fault surfaces via `appendMessages`, which still throws. What is genuinely lost is the signal. Keep the swallow, record `lastWriteError`.
- **`fillMarksSeen` never clears** — `session.ts:3225`. Every compaction cycle after the first is unannounced. **This contradicts its own documented intent** ("said once per session and never again"), so it is a design-preference change, not a defect. Decide: is the pre-compaction "write it down" nudge per-session or per-cycle? If per-cycle, one line beside `session.ts:3045`.
- **`turnRunning` is false for a whole unattended run** — `composer.tsx:374-379` dispatches no `turn-started`; `host.ts:1891-1914` emits no `turn.done`. `status.tsx:53` therefore polls `/health` every 10 s straight through generation on a single-slot server — cheap, since llama.cpp answers health off the HTTP thread, but it is exactly what its own comment forbids. The same root cause keeps AUDIT-2026-08-22 **B6** alive: all four `closeWritingCalls` sites are off a run's path, so an abandoned writing card pulses until morning. Fix both in the `run.turn`/`run.ended` reducer cases.
- **`background_task.ready_when.file` resolves mount-prefixed while the process runs in the primary root** — `background-task.ts:191-192` (jail refusal and absent file collapse to a permanent `ready: no`), `:341` (cwd hard-coded to the primary), `:332-337` (preview always says "workspace root"). Narrower than first stated: `prompt.ts:103-105` trains the model to write the prefixed form, which resolves. Bundle with Tier C1's unvalidated `ready_when` cast (`:322`) and the branch-order bug (`:188-192` silently ignores `port` when `log_contains` is also present).
- **`edit_file`'s whitespace-tolerant fallback inserts the model's indentation** — `search-replace.ts:70-75` discards the matched window whole. Corrupts Python/YAML precisely when the model was already unsure about layout. Rarely entered (`SPIKE-EDIT-PROBE.md`: every non-empty anchor matched byte-for-byte) and `edit-file.ts:340` shows the mangled result back in the same reply. `search-replace.test.ts:26-32` currently bakes the behaviour in.

---

## D. Conflicts, law checks, and what must be measured

**Conflicts / ordering**

1. **A4 gates A5, B5 and any further conversion.** Each conversion moves another gate onto `forcedJson`'s blanket `catch { return null }`. Land the discriminated result first.
2. **A1 gates A5 and B5.** `REVIEW_TOOL`, `CONTRACT_TOOL` and `PLAN_TOOL` carry their instructions in `description` fields exactly as the three converted schemas did. Converting them without first moving that prose into the ask **reproduces R1 three more times**. The conversion recipe must be: prose → user message, schema → shape only.
3. **B11 subsumes A2 and B1.** An integer `index` deletes `matchCriterionIndex` from the audit path, and with it both the un-tick regression and the double-report. But A2 is a live regression and B11 is a schema restructure — ship A2's provenance flag now, B11 next, then delete the dead matcher. Do not attempt them as one patch.
4. **B3 vs B5.** Fixing `distillContext`'s clip and deleting `distillContext` are alternatives. B5 is the better fix (Law 1 + Law 3); B3 is the fallback if B5 is deferred.
5. **A6 vs C's constant retune.** A6 removes the unwarranted cold-start budgets; retuning `PREFILL_MS_PER_TOKEN` *also* shortens them. Doing both blind risks over-tightening a genuinely cold path (`freshReview`, `runBackgroundCompaction`, resume). Land A6, then measure, then retune.
6. **A3 vs B7.** Both touch the formatter's failure path. A3 removes the *cause* of the spurious failures; B7 removes the *silent-disable* consequence. B7 alone would leave the model chasing a phantom error forever; A3 alone leaves the real `MAX_FAILURES` trap for legitimate linters. Ship A3 first.

**Three-law check (DESIGN.md §2)**

- No proposed fix violates **Law 1 (append-only)**. Every conversion in A5/B5 moves a request *onto* the shared prefix rather than off it; C's compaction leg 2 makes the summary request a genuine append instead of a middle-dropped rebuild — it is the most Law-1-aligned change in the list.
- **Law 2 (output ≈17× input)** *favours* A1 and B5: both trade rendered input tokens (cheap, cached) for behaviour that currently costs output tokens and fixer rounds. B11 and B13 are pure Law-2 wins. Nothing here adds output tokens.
- **Law 3 (long context nearly free at generation)** is the argument for deleting `distillContext` (B5) and for leg 2 of the compaction item: clipping context to save prefill only pays when the prefix is warm, and these prompts are cold *because* of the tools swap, not because of their length.
- One thing to watch, not a violation: A1 lengthens the gate's user message. Since the ask is the *tail* of the prompt, this costs only its own tokens at 730 tok/s (~0.5 s for 3.3k chars) and does not disturb the cached prefix.

**Believe only after a live measurement**

- A5's 26–82 s. The mechanism is measured (19-char / 1171-char common prefixes; `enable_thinking:false` appends only `\n</think>\n\n`); the saving on a real reviewer transcript is not.
- C's compaction item, both legs. Leg 1's recovery is arithmetic; leg 2's ~55 s and its interaction with the 3,000-token output cap need a real compaction timed end to end.
- The retuned `PREFILL_MS_PER_TOKEN = 2`. 1.36 ms was measured on an idle GPU; the margin for a GPU also driving a display is a guess.
- B5's steady-state 11 s. It depends on llama.cpp retaining the previous task's `[CONTRACT_TOOL + message 0]` prefix, which is asserted from the multi-prefix behaviour in `SPIKE-KAT-CODER.md §3`, not measured for this specific pair.

---

## E. What the audit did **not** find

- **The forced-JSON conversion itself works.** All three shipped schemas (reading, acceptance, premises) compile and generate against the live server; `response_format: json_schema` constrains as documented and leaves the prompt byte-identical. The prefix-preservation goal of `fc03242` was achieved — the gates are appends now. The single defect is that the descriptions went with the tools array (R1), not that the mechanism is wrong.
- **Thirteen of the fifteen Tier A fixes survived adversarial review intact.** Only two produced collateral: `withUnreportedCriteria` (A2/B1) and the `$FILE` assignment (A3). The shell injection itself is genuinely closed — `src/a b;calc.exe;c.ts` arrives at a native exe as one argv entry.
- **No lane raised anything against the permissions engine.** The `.privatecode` multi-folder write deny and the `sql_deploy` family match came back clean, and no jail escape was found: `Workspace.resolve` holds everywhere it is called (it is what *catches* the browser-screenshot and `background_task` bugs). The documented hardlink limitation is unchanged and was not re-raised.
- **No transcript-integrity or data-loss finding.** `appendMessages` and `appendCompactionSwap` still throw by design; the `.jsonl` is never silently lost. The one persistence finding (`saveMeta`) is about a missing signal, not missing bytes.
- **Sampling and the step loop's core contract came back clean.** No finding against `llama/sampling.ts`, `loop-detector.ts`, `mounts.ts`, `outline/`, `checkpoints/`, `mcp/`, or the tool registry's shape. Temperature (0.6 ≡ 1.0), thinking preservation, and the one-call-per-step contract were not challenged by any lane.
- **The premise quote-span fix, `splitUserMessage`, `foldAnswer`'s two defects, the compactAt session-switch sites and the Ctrl+K palette ordering** drew no follow-up finding of any kind.
- **The main turn's own prompt path is not leaking cache anywhere.** Every speed finding is on a *harness* request (review verdict, distill, decompose, compaction summary) — the conversation's own step-to-step prefix is intact.
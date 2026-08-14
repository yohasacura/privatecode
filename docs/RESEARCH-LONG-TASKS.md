# Long, multi-file tasks: what is known, and what to do about it here

Written 2026-08-14, after a measured 27-minute run of this tool against a real C# backend
and a read of the current literature. The measurements are ours and reproducible; the
literature is cited. Where the two disagree, the measurement wins.

## The finding that reframes the problem

**A large context window is not a resource to fill. Filling it makes the model worse.**

Context rot is measured, not folklore: across 18 frontier models — including the Qwen3
family this tool targets — accuracy drops non-uniformly as input grows, by 30–50 % *well
before* the advertised limit, and ten of twelve models fell below half their short-context
score by 32K tokens ([Chroma](https://www.trychroma.com/research/context-rot),
[summary](https://www.morphllm.com/context-rot)). The mechanism reported is semantic
similarity decay: the harder the answer is to distinguish from its surroundings, the faster
it collapses — and *coherent* input degrades attention faster than shuffled input, which is
precisely what a transcript full of related source files is.

So "модель теряется на большой задаче" is not a metaphor and not a prompt problem. By the
time this agent has read twenty files it is at 60–80k tokens, and its effective reasoning is
materially below what it was at 10k. **Every token not in the window is a token that cannot
confuse it.**

This changes the goal. It is not "postpone compaction" — it is "never approach the window at
all".

## What we measured here

One 27-minute run, 62 requests, `SmallCrm.Application`, Qwen3.6-35B-A3B at 131k:

| | |
|---|---|
| prefilled | **394 552 tokens** in 986 s (400 tok/s) |
| generated | **29 177 tokens** in 537 s (54 tok/s) |
| ratio | **13.5 : 1** |
| compaction | 8.5 min of 27 = **31 %** of the run |
| post-swap transcript | ~43k tokens (trigger fires at 105k) |
| artifact quality | 76 files cited, **zero hallucinated paths** |

Two thirds of the wall clock was spent re-ingesting context. The quality result matters as
much as the cost one: the model was not confused or inventing — **it was starving on
throughput**. That is a different problem from the one prompt engineering fixes.

Also measured, killing two plausible theories cheaply:

- The server **can** rewind its KV cache to a shorter common prefix (a diverging request
  re-prefilled 18 of 11 912 tokens). Recurrent Gated DeltaNet blocks are not why compaction
  is expensive.
- `chars/4` is an honest token estimate for this content (**3.85** chars/token measured over
  C#, TS, TSX and markdown), so the budgets built on it are sound.

## What the literature says works

**Ranked repository maps.** Aider parses the repo with tree-sitter, builds a graph of symbol
references, and runs PageRank over it — files referenced by important files rank high even
when never mentioned. The map is budgeted (~1k tokens) and **re-ranked around the files
currently in play**. Their benchmarks report materially higher edit accuracy than naive file
inclusion ([Aider](https://aider.chat/2023/10/22/repomap.html),
[architecture](https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system)).

**Context isolation via subagents.** A worker gets its module's interface summary and the
task, never the whole codebase; the parent never sees the worker's transcript. Reported gains
are large ([Anthropic's multi-agent result, 90.2 % over single-agent, is the figure usually
cited](https://www.tembo.io/blog/claude-code-subagents)).

**Compression, selection, summarisation** as distinct operations rather than one "compact"
step — LLMLingua, ACON, ReSum, AgentFold — plus persistent memory that survives sessions
(HippoRAG for facts, ExpeL for lessons learned)
([survey](https://github.com/RUC-NLPIR/Awesome-Long-Horizon-Agents)).

**Hierarchical planning and self-verification** — decompose, then verify each step rather
than the whole (Plan-and-Solve, Reflexion, process reward models; same survey).

A caution on sourcing: several of the 2026 arXiv PDFs above were read through an automated
summariser, and the specific percentages they report should be treated as indicative rather
than quoted. The Chroma context-rot result and the Aider design are first-party and solid.

## What to do here, in order

### 1. Rank the repo map, and re-rank it around the work

We already build a structural map — names and outlines. Aider's result says the ranking is
what makes a map worth its tokens, and **we now have something Aider does not: a real
reference graph.** `csharp_nav` (Roslyn) knows actual C# references, not heuristic ones;
tree-sitter covers the TS side. Rank by reference count, weight toward whatever the current
task has touched, keep the budget small.

This is the highest-confidence item on the list: proven externally, and the hard part —
the graph — was built this week for another reason.

> **Shipped, then found broken, then fixed — 2026-08-14.** Two claims in the paragraph above
> were wrong in the build that shipped. The ranker never used Roslyn at all; it collected
> definers from depth-0 tree-sitter entries, which in C# is the NAMESPACE, so the graph had
> **0 usable edges** and PageRank returned its restart vector — the "ranked" map was
> alphabetical order on every C# repository, verified by comparing its output to a plain sort.
> Fixed by taking definers to depth 1 (0 edges → 108). `bin`/`obj` were also being walked, so
> 10 of 40 mapped files were generated `.g.cs`; and files with no grammar were dropped, so
> `MainWindow.xaml` — the largest file in the workspace and the most-read file in the longest
> session — had never appeared in any map. Both fixed.
>
> Wiring the ranking to Roslyn's *real* reference graph, as this paragraph promised, is still
> not done. It remains the strongest open item for C#.

### 2. Stop reading whole files

`read_file` caps at 60 000 characters — **15.6k tokens, 12 % of the window, in one call.**
Given context rot, that is not merely expensive, it is corrosive. Concretely: outline first
for anything large, ranges by default, and let `csharp_nav` answer structural questions that
currently cost a read. Measured today: a `references` query returned in 0.3 s what would
otherwise have been five file reads.

> **The cap is now 24 000, and on this workspace it never fires.** The median whole read is
> 1 764 characters and the largest `.cs` read whole is 15 250 — 64 % of the limit. Shaping
> fired 2 times in 151 whole reads, both on `.xaml`, which has no grammar, so both degraded
> to a head clip. The premise of this item does not hold here: the cost is not one big read,
> it is **183 small ones in a single session** (≈165k tokens at the median file size, more
> than the window). The lever is the number of reads, not the size of one.
>
> **And the last sentence turned out to be the load-bearing one.** Seven fresh sessions,
> one structural question each, none naming Roslyn or the tool: **six opened with
> `csharp_nav`**, the five plan-mode ones made zero `read_file` calls between them, and the
> two normal-mode ones each read a 20-30 line window of exactly the lines it had pointed at,
> out of files of 439 and 50 lines. Navigating instead of reading is not a hope any more.

### 3. Durable project knowledge, with invalidation

The user works on **one project, repeatedly**, and every session re-derives the same
architecture from the same files. A digest the agent maintains across sessions is the
obvious fix and the obvious trap: a file that confidently describes code that has since
changed is worse than no file. So each entry must record what it was derived from and expire
when those files change. Without invalidation this becomes folklore.

### 4. The plan lives in a file, not in the transcript

Todos survive compaction (they are in the store, and now ride the briefing), but a long task
needs more: steps with explicit done-criteria, updated as work proceeds, outside the context
that gets summarised away. Today's run showed the shape of the problem — ten folders, and
after compaction the only thing holding the task's structure was one briefing paragraph.

### 5. Subagents — still no, and now for a measured reason

The design doc ruled these out on `-np 1` grounds. Today's numbers put a figure on it: a
subagent's conversation shares no prefix with the parent's, so returning costs a full
re-prefill — **~98 s at the 43k we measured**, each way. The isolation is genuinely valuable
and the arithmetic is genuinely bad on a single-slot server. Revisit only if the server ever
runs `-np 2`.

## The one-line version

The window is not the budget — **attention is**. Everything above is one idea applied four
ways: put less in, and make what goes in earn its place.

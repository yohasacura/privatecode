# Spike 3: production strategy for reliable edits


## S1. tool_choice=required, max_tokens=3000


**usable edits 3/6** (called 3, byte-exact 3, anchor miss 0, empty arg 0, no call 3, truncated 3)
- wall: median **42.4 s**, max 53.5 s
- thinking: median 2086 tok, max 2361 tok

## S2. Two-phase: reason under a 1200-token cap, then force the call

- run 1: phase 1 already called the tool (792 think tok)
- run 2: phase 1 already called the tool (535 think tok)
- run 3: phase 1 already called the tool (485 think tok)
- run 4: phase 1 already called the tool (846 think tok)
- run 5: phase 1 already called the tool (821 think tok)
- run 6: phase 1 already called the tool (934 think tok)

**usable edits 6/6** (called 6, byte-exact 6, anchor miss 0, empty arg 0, no call 0, truncated 0)
- wall: median **18.6 s**, max 20.3 s
- thinking: median 806 tok, max 934 tok

## S3. tool_choice=required + anti-deliberation system prompt


**usable edits 6/6** (called 6, byte-exact 6, anchor miss 0, empty arg 0, no call 0, truncated 0)
- wall: median **15.7 s**, max 32.5 s
- thinking: median 686 tok, max 1445 tok

## Summary

| strategy | usable edits | wall median | wall max | thinking median |
|---|---|---|---|---|
| S1 forced+cap3000 | **3/6** | 42.4 s | 53.5 s | 2086 tok |
| S2 two-phase | **6/6** | 18.6 s | 20.3 s | 806 tok |
| S3 terse+forced | **6/6** | 15.7 s | 32.5 s | 686 tok |
# Spike 4: does temperature cause the thinking spiral?

Held fixed: same task, `tool_choice=required`, `max_tokens=4000`, n=6 per arm.


## T1. temp 0.1, standard system prompt

- run 1: think 1365 tok, 29.6 s, finish=tool_calls, call=yes
- run 2: think 1697 tok, 38.5 s, finish=tool_calls, call=yes
- run 3: think 3215 tok, 71.3 s, finish=length, call=NO
- run 4: think 3382 tok, 73.3 s, finish=length, call=NO
- run 5: think 3192 tok, 72.0 s, finish=length, call=NO
- run 6: think 1149 tok, 27.3 s, finish=tool_calls, call=yes

**usable edits 3/6** (called 3, byte-exact 3, anchor miss 0, empty arg 0, no call 3, truncated 3)
- wall: median **54.9 s**, max 73.3 s
- thinking: median 2444 tok, max 3382 tok

## T2. temp 0.6, standard system prompt (Qwen's recommendation)

- run 1: think 1961 tok, 45.1 s, finish=tool_calls, call=yes
- run 2: think 1991 tok, 47.4 s, finish=tool_calls, call=yes
- run 3: think 1442 tok, 34.7 s, finish=tool_calls, call=yes
- run 4: think 1848 tok, 45.9 s, finish=tool_calls, call=yes
- run 5: think 1279 tok, 30.3 s, finish=tool_calls, call=yes
- run 6: think 1192 tok, 29.8 s, finish=tool_calls, call=yes

**usable edits 6/6** (called 6, byte-exact 6, anchor miss 0, empty arg 0, no call 0, truncated 0)
- wall: median **39.9 s**, max 47.4 s
- thinking: median 1645 tok, max 1991 tok

## T3. temp 0.6 + anti-deliberation prompt (candidate production config)

- run 1: think 1223 tok, 29.6 s, finish=tool_calls, call=yes
- run 2: think 1671 tok, 39.8 s, finish=tool_calls, call=yes
- run 3: think 1434 tok, 35.2 s, finish=tool_calls, call=yes
- run 4: think 1288 tok, 31.5 s, finish=tool_calls, call=yes
- run 5: think 1695 tok, 40.7 s, finish=tool_calls, call=yes
- run 6: think 1583 tok, 36.7 s, finish=tool_calls, call=yes

**usable edits 6/6** (called 6, byte-exact 6, anchor miss 0, empty arg 0, no call 0, truncated 0)
- wall: median **35.9 s**, max 40.7 s
- thinking: median 1508 tok, max 1695 tok

## Summary

| arm | usable edits | truncated | wall median | wall max | thinking median | thinking max |
|---|---|---|---|---|---|---|
| T1 | **3/6** | 3 | 54.9 s | 73.3 s | 2444 tok | —|
| T2 | **6/6** | 0 | 39.9 s | 47.4 s | 1645 tok | —|
| T3 | **6/6** | 0 | 35.9 s | 40.7 s | 1508 tok | —|
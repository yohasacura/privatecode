# Spike follow-up: why experiment 4 failed


## A. Original conditions (max_tokens=2000, tool_choice=auto) — reproduce the failure

- run 1: NO CALL  finish_reason=length  thinking≈1575tok  content=0ch  content_head=''
- run 2: NO CALL  finish_reason=length  thinking≈1602tok  content=0ch  content_head=''
- run 3: NO CALL  finish_reason=length  thinking≈1468tok  content=0ch  content_head=''
- run 4: NO CALL  finish_reason=length  thinking≈1587tok  content=0ch  content_head=''

**called 1/5** · anchor byte-exact 1 · whitespace-tolerant 0 · no call 4 · truncated by max_tokens 4
- thinking: median 1587 tok, max 1611 tok
- total output: median 2000 tok
- wall time: median 30.0 s, max 31.2 s

## B. Same task, max_tokens=8000 — does the cap explain it?

- run 1: NO CALL  finish_reason=length  thinking≈6119tok  content=0ch  content_head=''
- run 3: NO CALL  finish_reason=length  thinking≈5591tok  content=0ch  content_head=''
- run 5: NO CALL  finish_reason=length  thinking≈5897tok  content=0ch  content_head=''

**called 2/5** · anchor byte-exact 2 · whitespace-tolerant 0 · no call 3 · truncated by max_tokens 3
- thinking: median 5591 tok, max 6119 tok
- total output: median 8000 tok
- wall time: median 119.2 s, max 119.7 s

## C. max_tokens=8000 + tool_choice=required

- run 1: NO CALL  finish_reason=length  thinking≈6285tok  content=0ch  content_head=''

**called 4/5** · anchor byte-exact 4 · whitespace-tolerant 0 · no call 1 · truncated by max_tokens 1
- thinking: median 1262 tok, max 6285 tok
- total output: median 1605 tok
- wall time: median 24.0 s, max 116.1 s

## D. Small, escaping-free file (control)

- run 2: empty search_text
- run 4: empty search_text

**called 5/5** · anchor byte-exact 3 · whitespace-tolerant 0 · no call 0 · truncated by max_tokens 0
- thinking: median 310 tok, max 1688 tok
- total output: median 429 tok
- wall time: median 6.9 s, max 30.9 s
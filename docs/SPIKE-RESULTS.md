# PrivateCode spike results

Server: `http://127.0.0.1:8080`


## 0. Server facts

- build: `b10202-155372596`
- model: `D:\LocalAgentAI\models\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`
- n_ctx (per slot): **131072**
- total_slots: 1
- chat template: 8057 chars; mentions tool_call: True; mentions think: True

## 1. Native tool calls + reasoning separation (no grammar)

- first run: tool=`search_code` args=`{"pattern":"login.*token|token.*login|validate.*token|token.*valid"}`
- `<think>` leaked into content: **False**
- reasoning_content present: **True** (~63 tokens)
- MTP draft acceptance this run: **0.76**

**6/6 well-formed tool calls**, 0 failures, 6/6 carried reasoning_content
- generation: **60.6 tok/s** mean
- thinking length: ~66 tokens mean (≈2 s at 30.5 tok/s)

## 2. Explicit GBNF grammar vs the thinking block

- content: ``
- valid JSON under grammar: **False**
- reasoning survived the grammar: **True** (~11 tokens)

> Grammar is applied **lazily** — thinking is unconstrained, only the answer is forced. The two-call split is then a choice (per-phase temperature), not a necessity.

## 3. Forced tool call (tool_choice=required) — the permission-grammar mechanism


**6/6** stayed inside the read-only tool set with valid arguments; 0 escaped it; 0 failed
- reasoning still produced under tool_choice=required: 6/6

> This is the plan-mode mechanism: if restricting the offered tool set is honoured 100% of the time, plan mode needs no post-hoc rejection at all.

## 4. JSON escaping stress — is 'payload outside JSON' actually needed?

- run 1: no tool call
- run 2: no tool call
- run 3: no tool call
- run 5: no tool call

**1/5 byte-exact anchors**, 0 whitespace-tolerant, 4 unusable
- output: 1898 tokens mean ⇒ **62 s** per edit at 30.5 tok/s
- rewriting this whole file instead would be ~209 tokens ⇒ 7 s (0.1× more)

> Byte-exact anchoring is the risk that decides SEARCH/REPLACE. If exact match is unreliable, the matcher must normalise whitespace and re-ask on miss.

## 5. Two-call split — does the second call reuse the warm prefix?

- call 1: 107 tokens generated, prefill 521 tokens @ 238 t/s
- call 2: prefill 562 tokens @ 92 t/s
- call 2 wall time: **1.7 s** for 78 generated tokens

> If call 2's wall time is close to (generated tokens / 30.5), the prefix was cached and splitting a turn into two calls is effectively free.

## 6. Prefix cache: append-only vs mutating history (THE design law)

- cold  : prefill 14852 tokens, 27.3 s wall, 547 t/s
- append: prefill 14873 tokens, 0.5 s wall, 63 t/s
- mutate: prefill 14873 tokens, 27.7 s wall, 544 t/s

**mutate / append wall-time ratio: 56.5×** for a one-word change near the start of a ~14852-token history.
> A large ratio confirms law 1: the prompt must be append-only, and any context management that edits history mid-session is disqualified.

---

Total spike time: 3.9 min
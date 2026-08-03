# PrivateCode streaming spike (Plan 3, Task 2)

Server: `http://127.0.0.1:8080`


## Q1: SSE delta shapes — prose vs forced tool call

### (a) prose answer
- 203 SSE events total (including terminal `[DONE]`)
- first `delta.reasoning_content` event: #1; last one: #200; first `delta.content` event: #None
- first 3 raw events:
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null}}],"created":1785737652,"id":"chatcmpl-hTp5OMePKoKZ7Uf5hSWkY95uBA68r1xz","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"Here"}}],"created":1785737652,"id":"chatcmpl-hTp5OMePKoKZ7Uf5hSWkY95uBA68r1xz","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"'s"}}],"created":1785737652,"id":"chatcmpl-hTp5OMePKoKZ7Uf5hSWkY95uBA68r1xz","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
- last 3 raw events (before `[DONE]`):
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"4"}}],"created":1785737655,"id":"chatcmpl-hTp5OMePKoKZ7Uf5hSWkY95uBA68r1xz","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"3"}}],"created":1785737655,"id":"chatcmpl-hTp5OMePKoKZ7Uf5hSWkY95uBA68r1xz","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":"length","index":0,"delta":{}}],"created":1785737655,"id":"chatcmpl-hTp5OMePKoKZ7Uf5hSWkY95uBA68r1xz","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk","timings":{"cache_n":0,"prompt_n":24,"prompt_ms":506.539,"prompt_per_token_ms":21.105791666666665,"prompt_per_second":47.38035965641343,"predicted_n":200,"predicted_ms":2951.448,"predicted_per_token_ms":14.75724,"predicted_per_second":67.76334870206082,"draft_n":189,"draft_n_accepted":135}}
```
- terminal line: `[DONE]`

### (b) forced tool call (`tool_choice: 'required'`)
- 83 SSE events total
- events carrying a `delta.tool_calls` fragment: 10 (indices 71..80)
- first 5 tool_call delta events:
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"id":"ULfexkLUbv3T2kd7jgLQtIgzXc0zwxs9","type":"function","function":{"name":"record_answer","arguments":"{"}}]}}],"created":1785737657,"id":"chatcmpl-GBXIYrUdswq3WUvupkZzaQyCpw1QRLMf","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"value\":\""}}]}}],"created":1785737657,"id":"chatcmpl-GBXIYrUdswq3WUvupkZzaQyCpw1QRLMf","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"4"}}]}}],"created":1785737657,"id":"chatcmpl-GBXIYrUdswq3WUvupkZzaQyCpw1QRLMf","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"2"}}]}}],"created":1785737657,"id":"chatcmpl-GBXIYrUdswq3WUvupkZzaQyCpw1QRLMf","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\""}}]}}],"created":1785737658,"id":"chatcmpl-GBXIYrUdswq3WUvupkZzaQyCpw1QRLMf","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
- last 3 events (incl. finish_reason):
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"9"}}]}}],"created":1785737658,"id":"chatcmpl-GBXIYrUdswq3WUvupkZzaQyCpw1QRLMf","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}],"created":1785737658,"id":"chatcmpl-GBXIYrUdswq3WUvupkZzaQyCpw1QRLMf","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}],"created":1785737658,"id":"chatcmpl-GBXIYrUdswq3WUvupkZzaQyCpw1QRLMf","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk","timings":{"cache_n":0,"prompt_n":318,"prompt_ms":1160.927,"prompt_per_token_ms":3.650713836477987,"prompt_per_second":273.91903194602247,"predicted_n":113,"predicted_ms":1696.37,"predicted_per_token_ms":15.01212389380531,"predicted_per_second":66.61282621126287,"draft_n":96,"draft_n_accepted":83}}
```

## Q2: does the final chunk carry timings/usage? effect of include_usage

### without stream_options
- last 4 raw events:
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":" **"}}],"created":1785737658,"id":"chatcmpl-jdHD58hLz76hXGiDlcozAsoMaWOZFs5i","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"An"}}],"created":1785737658,"id":"chatcmpl-jdHD58hLz76hXGiDlcozAsoMaWOZFs5i","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"alyze"}}],"created":1785737658,"id":"chatcmpl-jdHD58hLz76hXGiDlcozAsoMaWOZFs5i","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":"length","index":0,"delta":{}}],"created":1785737658,"id":"chatcmpl-jdHD58hLz76hXGiDlcozAsoMaWOZFs5i","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk","timings":{"cache_n":9,"prompt_n":4,"prompt_ms":78.581,"prompt_per_token_ms":19.64525,"prompt_per_second":50.9028900115804,"predicted_n":10,"predicted_ms":142.71,"predicted_per_token_ms":14.271,"predicted_per_second":70.07217433956976,"draft_n":6,"draft_n_accepted":6}}
```
- any event carries `timings`: **True**
- any event carries non-null `usage`: **False**

### with stream_options={'include_usage': True}
- 14 events total (vs 13 without) — an EXTRA terminal event appears
- last 4 raw events:
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"An"}}],"created":1785737659,"id":"chatcmpl-himVZEJh6NCIuZrb7E5TwU9nmd6589ev","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"alyze"}}],"created":1785737659,"id":"chatcmpl-himVZEJh6NCIuZrb7E5TwU9nmd6589ev","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":"length","index":0,"delta":{}}],"created":1785737659,"id":"chatcmpl-himVZEJh6NCIuZrb7E5TwU9nmd6589ev","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[],"created":1785737659,"id":"chatcmpl-himVZEJh6NCIuZrb7E5TwU9nmd6589ev","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk","usage":{"completion_tokens":10,"prompt_tokens":13,"total_tokens":23,"prompt_tokens_details":{"cached_tokens":9}},"timings":{"cache_n":9,"prompt_n":4,"prompt_ms":90.034,"prompt_per_token_ms":22.5085,"prompt_per_second":44.42766066152787,"predicted_n":10,"predicted_ms":139.326,"predicted_per_token_ms":13.932599999999999,"predicted_per_second":71.77411251309879,"draft_n":6,"draft_n_accepted":6}}
```
- any event carries `timings`: **True**
- any event carries non-null `usage`: **True**

## Q3: finish_reason arrival + a length-truncated stream

- `finish_reason` set on 1 event(s) out of 13
  - event #11: finish_reason=`length`, delta={} (empty: True)
```json
{"choices":[{"finish_reason":"length","index":0,"delta":{}}],"created":1785737659,"id":"chatcmpl-6ZvAu06v9oYJIXdXIpdPx9gFZrdAorIH","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk","timings":{"cache_n":9,"prompt_n":4,"prompt_ms":77.567,"prompt_per_token_ms":19.39175,"prompt_per_second":51.56832158005338,"predicted_n":10,"predicted_ms":127.63,"predicted_per_token_ms":12.763,"predicted_per_second":78.35148476063621,"draft_n":6,"draft_n_accepted":6}}
```

### max_tokens=60, prompt designed to run long (expect finish_reason='length')
- 63 events total
- last 3 raw events:
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":" is"}}],"created":1785737660,"id":"chatcmpl-7stqULHzaTdwclpxlzKg1SmSxd4da00B","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":" the"}}],"created":1785737660,"id":"chatcmpl-7stqULHzaTdwclpxlzKg1SmSxd4da00B","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk"}
```
```json
{"choices":[{"finish_reason":"length","index":0,"delta":{}}],"created":1785737660,"id":"chatcmpl-7stqULHzaTdwclpxlzKg1SmSxd4da00B","model":"Qwen3.6-35B-A3B","system_fingerprint":"b10202-155372596","object":"chat.completion.chunk","timings":{"cache_n":0,"prompt_n":24,"prompt_ms":221.604,"prompt_per_token_ms":9.233500000000001,"prompt_per_second":108.30129420046569,"predicted_n":60,"predicted_ms":957.669,"predicted_per_token_ms":15.96115,"predicted_per_second":62.652127196348644,"draft_n":54,"draft_n_accepted":39}}
```
- final finish_reason observed: **length**

## Q4: mid-stream abort -> slot-release latency (the -np 1 risk)

- trial 1: aborted after 30 non-empty delta events
  follow-up: wall=0.578s, timings.prompt_ms=184.7, timings.predicted_ms=246.3 => inferred slot-wait gap = wall - (prompt_ms+predicted_ms) = **0.147s**
- trial 2: aborted after 30 non-empty delta events
  follow-up: wall=0.522s, timings.prompt_ms=83.8, timings.predicted_ms=255.3 => inferred slot-wait gap = wall - (prompt_ms+predicted_ms) = **0.182s**
- trial 3: aborted after 30 non-empty delta events
  follow-up: wall=0.511s, timings.prompt_ms=84.7, timings.predicted_ms=252.3 => inferred slot-wait gap = wall - (prompt_ms+predicted_ms) = **0.174s**

**slot-wait gap across 3 trials — min/median/max: 0.147s / 0.174s / 0.182s**

## Q5: cache_prompt prefix reuse under streaming

- first  request: prompt_ms=2602.722, prompt_n=2034, cache_n=0
- second request (identical prefix): prompt_ms=86.546, prompt_n=4, cache_n=2030
- speedup: 30.1x faster prompt processing on the cached prefix

## Q6: tool-call argument-fragment JSON validity per accumulation step

- 15 argument fragments received
- valid-JSON-when-parsed at 1/15 accumulation steps
- first step that parses: **14** (last index is 14)
- parses at EVERY step from first success to the end: **True**
- final accumulated arguments: `{"value":"The answer is 42.","confidence":0.9}`
- per-step parse results: [False, False, False, False, False, False, False, False, False, False, False, False, False, False, True]

---

Total spike time: 0.3 min

## Consequences for Tasks 3/4/5

**What a TS streaming client must actually read, per SSE `data:` event
(`choices[0]` unless noted):**

| Field path | Behaviour observed |
|---|---|
| `delta.role` + `delta.content: null` | First event of every stream; a pure "assistant started" marker, no text. |
| `delta.reasoning_content` (string) | Arrives as many small fragments (often 1 token, sometimes a merged multi-char piece). All reasoning fragments arrive **before** any `delta.content` fragment — no interleaving observed. Concatenate in order. |
| `delta.content` (string) | Same fragment shape, arrives strictly after reasoning is done — **but see contradiction below: it may never arrive at all.** |
| `delta.tool_calls[].index` | Present on every tool_call fragment; use it to route fragments to the right call slot (parallel calls weren't exercised here — only single-call `tool_choice: 'required'` — but the index field is exactly the OpenAI parallel-tool-call convention). |
| `delta.tool_calls[].id`, `.type`, `.function.name` | Present **only on the first fragment** of a given tool call. Do not expect them again. |
| `delta.tool_calls[].function.arguments` | Character/token fragments of the JSON string. **Must be concatenated across the whole call before parsing** — see Q6. |
| `choices[0].finish_reason` | Arrives on its **own terminal chunk** with `delta: {}` (empty object) — never attached to the last content/reasoning/tool_call chunk. Observed values: `"length"` (max_tokens hit) and `"tool_calls"` (forced/emitted tool call). This chunk **already carries `timings`** (llama.cpp extension) with no extra flag needed. |
| `usage` | `null`/absent unless the request set `stream_options: {include_usage: true}`. When set, it does **not** get merged into the finish_reason chunk — it arrives in one **additional** terminal chunk afterward, with `choices: []` (empty array, not even an empty delta) and both `usage` and a second copy of `timings`. |
| terminal line | Literal `data: [DONE]` (no JSON body) always ends the stream, one line after `[DONE]` for both include_usage on/off cases (just one extra chunk is inserted before it when include_usage is on). |

**Direct answers, 1–6:**

1. Reasoning streams first via `delta.reasoning_content` fragments, then (if
   budget remains) content streams via `delta.content` fragments; the two
   never interleave in either the prose or forced-tool-call run. Tool-call
   fragments arrive via `delta.tool_calls[{index, id, type, function.name,
   function.arguments}]`, with `id`/`type`/`name` only on the first fragment
   and `arguments` split across ~10 fragments for a 2-key JSON object.
2. Final chunk (the `finish_reason` chunk) **already carries `timings`**
   whether or not `include_usage` is set. `usage` requires
   `stream_options: {include_usage: true}` and then arrives in a **separate,
   later chunk** (`choices: []`), not merged into the finish_reason chunk.
3. `finish_reason` arrives on its own terminal chunk with an empty `delta:
   {}`, never on the last content-bearing chunk. A `max_tokens: 60` run
   truncates cleanly with `finish_reason: "length"` on that same kind of
   empty-delta terminal chunk.
4. Abort → immediate new non-stream request, 3 trials: slot-wait gap
   **min 0.147 s / median 0.174 s / max 0.182 s** — far inside the plan's
   ≤~2 s assumption. The `-np 1` single-slot risk is real in principle but
   not observed in practice at this scale; llama.cpp appears to detect the
   dropped connection almost immediately (well under one token's generation
   time) rather than waiting for the aborted request to run to completion.
5. Confirmed working under streaming: a ~2034-token prefix cost
   `prompt_ms: 2602.7` cold; the identical-prefix follow-up request cost
   `prompt_ms: 86.5` with `cache_n: 2030` — a **30.1× speedup**, streaming
   does not defeat `cache_prompt`.
6. **Only at the very last accumulation step**, not at every prefix. Across
   15 fragments accumulating `{"value":"The answer is 42.","confidence":0.9}`,
   `JSON.parse`-equivalent succeeded at just 1 of 15 steps (the final one);
   all 14 earlier prefixes are invalid JSON (unclosed braces/strings). Once
   valid, every subsequent step stays valid (there's only one after it, so
   this is a weak claim from n=1 run — treat "stays valid once complete" as
   plausible, not proven, for calls with more fragments after completion).

**Contradictions with the plan — 2 found, plus 1 undocumented risk:**

- **Partial contradiction on Q2/finding "final chunk carries timings+usage":**
  `timings` rides the finish_reason chunk for free, but `usage` does **not**
  — and when requested via `include_usage`, it shows up as a *distinct extra
  chunk* rather than being folded into the finish_reason chunk. A TS client
  that assumes "read usage off the same chunk as finish_reason" will read
  `undefined`. **Recommendation:** always set
  `stream_options: {include_usage: true}` if Task 3/5 need token counts
  (e.g. for compaction budget tracking), and have the stream parser treat
  `choices: []` chunks as a distinct "usage/timings-only" event type, not an
  error or a no-op.
- **Real contradiction on Q6:** the plan's phrasing ("llama.cpp's grammar
  suggests yes") is wrong for the fragment-by-fragment case — argument
  fragments are **not** valid JSON at every prefix, only at the end. Any
  design that tries to optimistically `JSON.parse` a partial tool call for
  progressive UI (e.g., to show a live-updating diff before the call
  finishes) will fail on every attempt except the last and must swallow
  those failures silently, not surface them as errors. **Recommendation:**
  Task 3's client should buffer `function.arguments` fragments per `index`
  and only attempt to parse once `finish_reason === "tool_calls"` (or stream
  end) is seen for that call.
- **Undocumented risk found, not in the original 6 questions:** in the Q1(a)
  prose run at `max_tokens: 200`, the model spent the **entire** budget on
  `reasoning_content` and emitted **zero** `delta.content` fragments before
  hitting `finish_reason: "length"`. This is consistent with
  `docs/DESIGN.md`'s already-documented "thinking runaway" failure mode
  (section 7), but it specifically means: a naive streaming client that
  waits for `delta.content` to render "the answer" can sit idle for the
  whole generation and then show **nothing** on a length-truncated turn.
  Task 3/5 should render `reasoning_content` distinctly (e.g., a collapsed
  "thinking…" region) as it streams, not only `content`, or a truncated turn
  looks broken/empty to the user.
- **Minor quirk, not a contradiction but worth flagging for whoever debugs
  Task 3 against `/props`:** `GET /props` currently reports
  `default_generation_settings.params.reasoning_format: "none"`, yet every
  request in this spike (and in the Plan-1 spike, `docs/DESIGN.md` §7)
  actually returns separated `reasoning_content` — i.e., the server **is**
  running with deepseek-style reasoning splitting in practice, `/props`
  just doesn't reflect it accurately. Don't use `/props` to detect this
  capability at runtime; detect it empirically (a `reasoning_content` key
  appearing in the first non-trivial delta) instead.
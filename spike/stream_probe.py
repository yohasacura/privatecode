#!/usr/bin/env python3
"""
PrivateCode streaming spike (Plan 3, Task 2).

Measures the actual SSE streaming behaviour of the live llama.cpp server so
Tasks 3-5 (the TS streaming client, Ctrl+C abort handling, and prompt
compaction) are built against reality, not assumption. Six questions, each
answered with raw captured output. See docs/SPIKE-STREAMING.md for the
write-up this script produces.

Requires: a running llama.cpp server on port 8080, started --jinja
--reasoning-format deepseek (already the case for this project; see
docs/DESIGN.md section 7). Only ONE slot (-np 1) -> every probe below runs
strictly sequentially, never concurrently. Python stdlib only
(http.client, json, time, statistics).

Usage:
    python spike/stream_probe.py                 # all 6 questions
    python spike/stream_probe.py --only 1,4       # selected questions
"""

import argparse
import http.client
import json
import statistics
import sys
import time
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8080
MODEL = "Qwen3.6-35B-A3B"

# Sampling params match spike/grammar_spike.py exactly.
TEMPERATURE = 0.6
TOP_P = 0.95
TOP_K = 20
MIN_P = 0.0

REPORT: list[str] = []
RESULTS: dict = {}

SIMPLE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "record_answer",
            "description": "Record the final answer to the user's question.",
            "parameters": {
                "type": "object",
                "properties": {
                    "value": {"type": "string", "description": "The answer, as a full sentence."},
                    "confidence": {"type": "number", "description": "0..1 confidence."},
                },
                "required": ["value"],
            },
        },
    }
]


# --------------------------------------------------------------------------- io

def banner(title: str):
    line = "=" * 78
    print(f"\n{line}\n  {title}\n{line}")
    REPORT.append(f"\n## {title}\n")


def note(s: str = ""):
    print(s)
    REPORT.append(s)


def code(s: str, lang: str = "json"):
    print(s if len(s) < 400 else s[:400] + " …[truncated]")
    REPORT.append(f"```{lang}\n{s}\n```")


def _headers():
    return {"Content-Type": "application/json", "Authorization": "Bearer x"}


def build_payload(messages, *, stream, tools=None, tool_choice=None,
                   max_tokens=200, stream_options=None, cache_prompt=True):
    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": TEMPERATURE,
        "top_p": TOP_P,
        "top_k": TOP_K,
        "min_p": MIN_P,
        "max_tokens": max_tokens,
        "stream": stream,
        "cache_prompt": cache_prompt,
    }
    if tools:
        payload["tools"] = tools
    if tool_choice:
        payload["tool_choice"] = tool_choice
    if stream_options:
        payload["stream_options"] = stream_options
    return payload


def open_stream(payload, timeout=180):
    """Open a streaming POST. Caller iterates iter_sse(resp) then MUST conn.close()."""
    conn = http.client.HTTPConnection(HOST, PORT, timeout=timeout)
    body = json.dumps(payload).encode()
    conn.request("POST", "/v1/chat/completions", body=body, headers=_headers())
    resp = conn.getresponse()
    return conn, resp


def iter_sse(resp):
    """Yield (raw_data_str, parsed_json_or_None) for each `data:` SSE event."""
    while True:
        line = resp.readline()
        if not line:
            break
        line = line.rstrip(b"\r\n")
        if not line.startswith(b"data:"):
            continue  # blank line / other SSE fields, ignore
        data = line[5:].strip()
        if data == b"[DONE]":
            yield ("[DONE]", None)
            break
        try:
            yield (data.decode(), json.loads(data))
        except Exception:
            yield (data.decode(errors="replace"), None)


def post_json(payload, timeout=180):
    conn = http.client.HTTPConnection(HOST, PORT, timeout=timeout)
    body = json.dumps(payload).encode()
    t0 = time.perf_counter()
    conn.request("POST", "/v1/chat/completions", body=body, headers=_headers())
    resp = conn.getresponse()
    data = json.loads(resp.read())
    wall = time.perf_counter() - t0
    conn.close()
    return data, wall


def server_up() -> bool:
    try:
        conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
        conn.request("GET", "/props")
        r = conn.getresponse()
        r.read()
        conn.close()
        return r.status == 200
    except Exception as e:
        note(f"**Server unreachable at {HOST}:{PORT}**: {e!r}")
        return False


# -------------------------------------------------------------------- experiments

def q1_delta_shapes():
    banner("Q1: SSE delta shapes — prose vs forced tool call")

    # --- (a) prose answer ---------------------------------------------------
    note("### (a) prose answer")
    messages = [{"role": "user",
                 "content": "Name the largest planet in our solar system, then explain briefly why."}]
    payload = build_payload(messages, stream=True, max_tokens=200)
    conn, resp = open_stream(payload)
    events = []
    try:
        for raw, ev in iter_sse(resp):
            events.append((raw, ev))
    finally:
        conn.close()

    note(f"- {len(events)} SSE events total (including terminal `[DONE]`)")
    first_reason = next((i for i, (r, e) in enumerate(events)
                          if e and e["choices"][0]["delta"].get("reasoning_content")), None)
    last_reason = max((i for i, (r, e) in enumerate(events)
                        if e and e["choices"][0]["delta"].get("reasoning_content")), default=None)
    first_content = next((i for i, (r, e) in enumerate(events)
                           if e and e["choices"][0]["delta"].get("content")), None)
    note(f"- first `delta.reasoning_content` event: #{first_reason}; "
         f"last one: #{last_reason}; first `delta.content` event: #{first_content}")
    if last_reason is not None and first_content is not None:
        note(f"- reasoning and content **{'do NOT' if last_reason < first_content else 'DO'} interleave** "
             f"(all reasoning events precede all content events: {last_reason < first_content})")
    note("- first 3 raw events:")
    for raw, ev in events[:3]:
        code(raw)
    note("- last 3 raw events (before `[DONE]`):")
    for raw, ev in events[-4:-1]:
        code(raw)
    note(f"- terminal line: `{events[-1][0]}`")
    RESULTS["q1a"] = {"n_events": len(events), "first_reason": first_reason,
                       "last_reason": last_reason, "first_content": first_content}

    # --- (b) forced tool call ------------------------------------------------
    note("\n### (b) forced tool call (`tool_choice: 'required'`)")
    messages2 = [{"role": "user",
                  "content": "Record the answer 42 with confidence 0.9 using the tool."}]
    payload2 = build_payload(messages2, stream=True, tools=SIMPLE_TOOLS,
                              tool_choice="required", max_tokens=200)
    conn2, resp2 = open_stream(payload2)
    events2 = []
    try:
        for raw, ev in iter_sse(resp2):
            events2.append((raw, ev))
    finally:
        conn2.close()

    note(f"- {len(events2)} SSE events total")
    tc_idx = [i for i, (r, e) in enumerate(events2)
              if e and e["choices"][0]["delta"].get("tool_calls")]
    note(f"- events carrying a `delta.tool_calls` fragment: {len(tc_idx)} "
         f"(indices {tc_idx[0]}..{tc_idx[-1]})" if tc_idx else "- **no tool_calls delta seen**")
    note("- first 5 tool_call delta events:")
    for i in tc_idx[:5]:
        code(events2[i][0])
    note("- last 3 events (incl. finish_reason):")
    for raw, ev in events2[-4:-1]:
        code(raw)
    RESULTS["q1b"] = {"n_events": len(events2), "tc_event_indices": tc_idx}


def q2_final_chunk_metadata():
    banner("Q2: does the final chunk carry timings/usage? effect of include_usage")
    messages = [{"role": "user", "content": "Say OK."}]

    note("### without stream_options")
    payload = build_payload(messages, stream=True, max_tokens=10)
    conn, resp = open_stream(payload)
    events = []
    try:
        for raw, ev in iter_sse(resp):
            events.append((raw, ev))
    finally:
        conn.close()
    note("- last 4 raw events:")
    for raw, ev in events[-5:-1]:
        code(raw)
    has_timings = any(e and "timings" in e for r, e in events)
    has_usage = any(e and e.get("usage") for r, e in events)
    note(f"- any event carries `timings`: **{has_timings}**")
    note(f"- any event carries non-null `usage`: **{has_usage}**")

    note("\n### with stream_options={'include_usage': True}")
    payload2 = build_payload(messages, stream=True, max_tokens=10,
                              stream_options={"include_usage": True})
    conn2, resp2 = open_stream(payload2)
    events2 = []
    try:
        for raw, ev in iter_sse(resp2):
            events2.append((raw, ev))
    finally:
        conn2.close()
    note(f"- {len(events2)} events total (vs {len(events)} without) — "
         f"{'an EXTRA terminal event appears' if len(events2) > len(events) else 'same event count'}")
    note("- last 4 raw events:")
    for raw, ev in events2[-5:-1]:
        code(raw)
    has_timings2 = any(e and "timings" in e for r, e in events2)
    has_usage2 = any(e and e.get("usage") for r, e in events2)
    note(f"- any event carries `timings`: **{has_timings2}**")
    note(f"- any event carries non-null `usage`: **{has_usage2}**")
    RESULTS["q2"] = {"without": {"timings": has_timings, "usage": has_usage},
                       "with_include_usage": {"timings": has_timings2, "usage": has_usage2}}


def q3_finish_reason():
    banner("Q3: finish_reason arrival + a length-truncated stream")
    messages = [{"role": "user", "content": "Say OK."}]
    payload = build_payload(messages, stream=True, max_tokens=10)
    conn, resp = open_stream(payload)
    events = []
    try:
        for raw, ev in iter_sse(resp):
            events.append((raw, ev))
    finally:
        conn.close()
    fr = [(i, r, e) for i, (r, e) in enumerate(events)
          if e and e["choices"][0].get("finish_reason")]
    note(f"- `finish_reason` set on {len(fr)} event(s) out of {len(events)}")
    for i, r, e in fr:
        delta = e["choices"][0].get("delta") or {}
        note(f"  - event #{i}: finish_reason=`{e['choices'][0]['finish_reason']}`, "
             f"delta={delta!r} (empty: {not delta})")
        code(r)

    note("\n### max_tokens=60, prompt designed to run long (expect finish_reason='length')")
    messages2 = [{"role": "user",
                  "content": "Write a long, detailed essay about the history of the Roman Empire."}]
    payload2 = build_payload(messages2, stream=True, max_tokens=60)
    conn2, resp2 = open_stream(payload2)
    events2 = []
    try:
        for raw, ev in iter_sse(resp2):
            events2.append((raw, ev))
    finally:
        conn2.close()
    note(f"- {len(events2)} events total")
    note("- last 3 raw events:")
    for raw, ev in events2[-4:-1]:
        code(raw)
    last_fr = next((e["choices"][0].get("finish_reason") for r, e in reversed(events2) if e), None)
    note(f"- final finish_reason observed: **{last_fr}**")
    RESULTS["q3"] = {"finish_events": len(fr), "length_run_finish_reason": last_fr}


def q4_abort_slot_release(repeats=3):
    banner("Q4: mid-stream abort -> slot-release latency (the -np 1 risk)")
    gaps = []
    for trial in range(repeats):
        messages = [{"role": "user",
                     "content": "Count slowly from one to one hundred, one number per line, "
                                "with a short unique comment on each line."}]
        payload = build_payload(messages, stream=True, max_tokens=500)
        conn, resp = open_stream(payload)
        count = 0
        try:
            for raw, ev in iter_sse(resp):
                if ev is None:
                    continue
                delta = ev["choices"][0].get("delta", {})
                if delta.get("content") or delta.get("reasoning_content"):
                    count += 1
                if count >= 30:
                    break
        finally:
            t_close0 = time.perf_counter()
            conn.close()  # abrupt close mid-generation, no graceful stream drain
        note(f"- trial {trial + 1}: aborted after {count} non-empty delta events")

        # IMMEDIATELY (no sleep) issue a fresh non-stream request.
        follow_payload = build_payload(
            [{"role": "user", "content": "Say the single word READY."}],
            stream=False, max_tokens=20)
        data, wall = post_json(follow_payload, timeout=60)
        t = data.get("timings", {}) or {}
        prompt_ms = t.get("prompt_ms", 0) or 0
        predicted_ms = t.get("predicted_ms", 0) or 0
        gap = wall - (prompt_ms / 1000.0) - (predicted_ms / 1000.0)
        gaps.append(gap)
        note(f"  follow-up: wall={wall:.3f}s, timings.prompt_ms={prompt_ms:.1f}, "
             f"timings.predicted_ms={predicted_ms:.1f} "
             f"=> inferred slot-wait gap = wall - (prompt_ms+predicted_ms) = **{gap:.3f}s**")

    note("")
    note(f"**slot-wait gap across {repeats} trials — min/median/max: "
         f"{min(gaps):.3f}s / {statistics.median(gaps):.3f}s / {max(gaps):.3f}s**")
    RESULTS["q4"] = {"gaps_s": gaps, "min": min(gaps), "median": statistics.median(gaps),
                       "max": max(gaps)}


def q5_cache_prompt_streaming():
    banner("Q5: cache_prompt prefix reuse under streaming")
    long_prefix = ("You are a helpful assistant. Here is reference material:\n" +
                   "The quick brown fox jumps over the lazy dog. " * 200)
    messages = [{"role": "system", "content": long_prefix},
                {"role": "user", "content": "Reply with just the word OK."}]
    payload = build_payload(messages, stream=True, max_tokens=5,
                             stream_options={"include_usage": True})

    def run_once():
        conn, resp = open_stream(payload)
        events = []
        try:
            for raw, ev in iter_sse(resp):
                events.append((raw, ev))
        finally:
            conn.close()
        timings = None
        for r, e in reversed(events):
            if e and e.get("timings"):
                timings = e["timings"]
                break
        return timings, events

    t1, ev1 = run_once()
    t2, ev2 = run_once()
    if t1 is None or t2 is None:
        note("- **no `timings` object appeared in the streamed response** "
             "(see Q2 for whether include_usage changes this) — cannot confirm prompt_ms "
             "directly from the stream; falling back to raw final-event dump below.")
        note("- first request final event:")
        code(ev1[-2][0] if len(ev1) >= 2 else "(n/a)")
        note("- second request final event:")
        code(ev2[-2][0] if len(ev2) >= 2 else "(n/a)")
    else:
        note(f"- first  request: prompt_ms={t1.get('prompt_ms')}, prompt_n={t1.get('prompt_n')}, "
             f"cache_n={t1.get('cache_n')}")
        note(f"- second request (identical prefix): prompt_ms={t2.get('prompt_ms')}, "
             f"prompt_n={t2.get('prompt_n')}, cache_n={t2.get('cache_n')}")
        if t1.get("prompt_ms") and t2.get("prompt_ms") is not None:
            note(f"- speedup: {t1['prompt_ms'] / max(t2['prompt_ms'], 0.001):.1f}x faster prompt "
                 f"processing on the cached prefix")
    RESULTS["q5"] = {"first": t1, "second": t2}


def q6_tool_call_fragment_integrity():
    banner("Q6: tool-call argument-fragment JSON validity per accumulation step")
    messages = [{"role": "user",
                 "content": "Record the answer 42 with confidence 0.9 using the tool. "
                            "Make the value field a full sentence explanation, not just a number."}]
    payload = build_payload(messages, stream=True, tools=SIMPLE_TOOLS,
                             tool_choice="required", max_tokens=300)
    conn, resp = open_stream(payload)
    frags = []
    try:
        for raw, ev in iter_sse(resp):
            if ev is None:
                continue
            delta = ev["choices"][0].get("delta", {})
            for tc in (delta.get("tool_calls") or []):
                fn = tc.get("function", {})
                if fn.get("arguments"):
                    frags.append(fn["arguments"])
    finally:
        conn.close()

    note(f"- {len(frags)} argument fragments received")
    acc = ""
    parse_ok = []
    first_ok = None
    for i, f in enumerate(frags):
        acc += f
        ok = False
        try:
            json.loads(acc)
            ok = True
            if first_ok is None:
                first_ok = i
        except Exception:
            pass
        parse_ok.append(ok)
    valid_count = sum(parse_ok)
    note(f"- valid-JSON-when-parsed at {valid_count}/{len(frags)} accumulation steps")
    note(f"- first step that parses: **{first_ok}** (last index is {len(frags) - 1})")
    note(f"- parses at EVERY step from first success to the end: "
         f"**{all(parse_ok[first_ok:]) if first_ok is not None else 'n/a'}**")
    note(f"- final accumulated arguments: `{acc}`")
    note(f"- per-step parse results: {parse_ok}")
    RESULTS["q6"] = {"n_frags": len(frags), "valid_count": valid_count,
                       "first_ok_step": first_ok, "final_args": acc, "parse_ok": parse_ok}


EXPERIMENTS = {
    1: q1_delta_shapes,
    2: q2_final_chunk_metadata,
    3: q3_finish_reason,
    4: q4_abort_slot_release,
    5: q5_cache_prompt_streaming,
    6: q6_tool_call_fragment_integrity,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated question numbers")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] /
                                          "docs" / "SPIKE-STREAMING.md"))
    args = ap.parse_args()

    REPORT.append("# PrivateCode streaming spike (Plan 3, Task 2)\n")
    REPORT.append(f"Server: `http://{HOST}:{PORT}`\n")

    if not server_up():
        sys.exit(1)

    chosen = [int(x) for x in args.only.split(",") if x.strip()] or sorted(EXPERIMENTS)
    t0 = time.perf_counter()
    for k in chosen:
        try:
            EXPERIMENTS[k]()
        except Exception as e:
            note(f"\n**question {k} crashed:** {e!r}")
    note(f"\n---\n\nTotal spike time: {(time.perf_counter() - t0) / 60:.1f} min")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(REPORT), encoding="utf-8")
    (out.parent / "SPIKE-STREAMING.json").write_text(
        json.dumps(RESULTS, indent=2), encoding="utf-8")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()

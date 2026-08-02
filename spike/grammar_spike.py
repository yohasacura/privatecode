#!/usr/bin/env python3
"""
PrivateCode design spike.

Verifies, against the real llama.cpp server, the load-bearing assumptions behind
PrivateCode's design before a single line of the app is written.

Requires: a running Start-QwenServer.ps1 (port 8080). Python stdlib only.

Usage:
    python grammar_spike.py                       # all experiments
    python grammar_spike.py --only 1,6            # selected experiments
    python grammar_spike.py --base-url http://192.168.20.37:8080
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = "http://127.0.0.1:8080"
REPORT: list[str] = []
RESULTS: dict[str, dict] = {}


# --------------------------------------------------------------------------- io

def _post(path: str, payload: dict, timeout: int = 900) -> tuple[dict, float]:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE_URL + path,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer x"},
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    return data, time.perf_counter() - t0


def _get(path: str, timeout: int = 10):
    try:
        with urllib.request.urlopen(BASE_URL + path, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def chat(messages, *, tools=None, grammar=None, response_format=None,
         temperature=0.6, max_tokens=1200, stop=None, tool_choice=None,
         chat_template_kwargs=None, timeout=900):
    """One /v1/chat/completions call. Returns (message, meta)."""
    payload = {
        "model": "Qwen3.6-35B-A3B",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
        "cache_prompt": True,
    }
    if tools:
        payload["tools"] = tools
    if tool_choice:
        payload["tool_choice"] = tool_choice
    if grammar:
        payload["grammar"] = grammar
    if response_format:
        payload["response_format"] = response_format
    if stop:
        payload["stop"] = stop
    if chat_template_kwargs:
        payload["chat_template_kwargs"] = chat_template_kwargs

    try:
        data, wall = _post("/v1/chat/completions", payload, timeout=timeout)
    except urllib.error.HTTPError as e:
        return None, {"error": f"HTTP {e.code}: {e.read()[:600].decode(errors='replace')}",
                      "wall": 0.0}
    except Exception as e:
        return None, {"error": repr(e), "wall": 0.0}

    msg = data["choices"][0]["message"]
    usage = data.get("usage", {}) or {}
    t = data.get("timings", {}) or {}
    meta = {
        "wall": wall,
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        # llama.cpp reports these when available; fall back to wall clock
        "prompt_ms": t.get("prompt_ms"),
        "predicted_ms": t.get("predicted_ms"),
        "prompt_per_second": t.get("prompt_per_second"),
        "predicted_per_second": t.get("predicted_per_second"),
        "draft_n": t.get("draft_n"),
        "draft_n_accepted": t.get("draft_n_accepted"),
        "finish_reason": data["choices"][0].get("finish_reason"),
        "raw_timings": t,
    }
    return msg, meta


def gen_speed(meta) -> float:
    if meta.get("predicted_per_second"):
        return meta["predicted_per_second"]
    ct, wall = meta.get("completion_tokens"), meta.get("wall")
    return (ct / wall) if (ct and wall) else float("nan")


# ------------------------------------------------------------------ test fixtures

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative path."},
                    "start_line": {"type": "integer"},
                    "end_line": {"type": "integer"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_code",
            "description": "Search the workspace with a regular expression (ripgrep).",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "glob": {"type": "string"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": (
                "Replace an exact fragment of a file. search_text must match the file "
                "byte-for-byte; replace_text is what it becomes."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "search_text": {"type": "string"},
                    "replace_text": {"type": "string"},
                },
                "required": ["path", "search_text", "replace_text"],
            },
        },
    },
]

SYSTEM = (
    "You are a coding agent working in a local workspace. "
    "Use the provided tools to inspect and modify files. "
    "Call exactly one tool per step."
)

# A file whose content is hostile to JSON string escaping: quotes, backslashes,
# regex, verbatim strings, newlines.
NASTY_FILE = r'''using System;
using System.Text.RegularExpressions;

namespace Demo
{
    public static class PathRules
    {
        // matches "C:\Users\name\file.txt" and reports the "drive" group
        private static readonly Regex Windows = new Regex(
            @"^(?<drive>[A-Za-z]):\\(?:[^\\/:*?""<>|\r\n]+\\)*[^\\/:*?""<>|\r\n]*$",
            RegexOptions.Compiled);

        public static string Describe(string p)
        {
            if (string.IsNullOrEmpty(p)) return "empty";
            var m = Windows.Match(p);
            if (!m.Success) return "not a windows path";
            return $"drive=\"{m.Groups["drive"].Value}\"\tlen={p.Length}\n";
        }
    }
}
'''


def banner(title: str):
    line = "=" * 78
    print(f"\n{line}\n  {title}\n{line}")
    REPORT.append(f"\n## {title}\n")


def note(s: str = ""):
    print(s)
    REPORT.append(s)


# -------------------------------------------------------------------- experiments

def exp0_server_facts():
    banner("0. Server facts")
    props = _get("/props")
    if not props:
        note("**Server unreachable.** Start it with Start-QwenServer.bat and re-run.")
        return False
    gen = props.get("default_generation_settings", {}) or {}
    note(f"- build: `{props.get('build_info')}`")
    note(f"- model: `{props.get('model_path')}`")
    note(f"- n_ctx (per slot): **{gen.get('n_ctx')}**")
    note(f"- total_slots: {props.get('total_slots')}")
    tmpl = props.get("chat_template") or ""
    note(f"- chat template: {len(tmpl)} chars; "
         f"mentions tool_call: {'<tool_call>' in tmpl}; "
         f"mentions think: {'think' in tmpl}")
    RESULTS["server"] = {"n_ctx": gen.get("n_ctx"), "slots": props.get("total_slots"),
                         "build": props.get("build_info")}
    return True


def exp1_native_tool_calls(n=6):
    """Does the model emit native tool_calls, and does reasoning come back separately?"""
    banner("1. Native tool calls + reasoning separation (no grammar)")
    msgs = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content":
            "The login handler rejects valid tokens. Find where the token is validated."},
    ]
    ok, malformed, with_reasoning, speeds, reason_tokens = 0, 0, 0, [], []
    for i in range(n):
        msg, meta = chat(msgs, tools=TOOLS)
        if msg is None:
            note(f"- run {i+1}: **ERROR** {meta.get('error')}")
            malformed += 1
            continue
        tc = msg.get("tool_calls") or []
        rc = msg.get("reasoning_content") or ""
        content = msg.get("content") or ""
        if rc:
            with_reasoning += 1
            reason_tokens.append(len(rc) // 4)
        if tc:
            try:
                json.loads(tc[0]["function"]["arguments"])
                ok += 1
            except Exception:
                malformed += 1
                note(f"- run {i+1}: tool_calls present but arguments are not valid JSON")
        else:
            malformed += 1
            note(f"- run {i+1}: **no tool_calls**; content starts: {content[:120]!r}")
        speeds.append(gen_speed(meta))
        if i == 0:
            note(f"- first run: tool=`{tc[0]['function']['name'] if tc else None}` "
                 f"args=`{(tc[0]['function']['arguments'] if tc else '')[:160]}`")
            note(f"- `<think>` leaked into content: **{'<think>' in content}**")
            note(f"- reasoning_content present: **{bool(rc)}** (~{len(rc)//4} tokens)")
            if meta.get("draft_n"):
                acc = meta["draft_n_accepted"] / max(1, meta["draft_n"])
                note(f"- MTP draft acceptance this run: **{acc:.2f}**")
    note(f"\n**{ok}/{n} well-formed tool calls**, {malformed} failures, "
         f"{with_reasoning}/{n} carried reasoning_content")
    if speeds:
        note(f"- generation: **{sum(speeds)/len(speeds):.1f} tok/s** mean")
    if reason_tokens:
        note(f"- thinking length: ~{sum(reason_tokens)//len(reason_tokens)} tokens mean "
             f"(≈{sum(reason_tokens)/len(reason_tokens)/30.5:.0f} s at 30.5 tok/s)")
    RESULTS["native"] = {"ok": ok, "n": n, "reasoning": with_reasoning,
                         "mean_tok_s": (sum(speeds)/len(speeds)) if speeds else None}


def exp2_grammar_vs_thinking():
    """Does an explicit GBNF grammar kill the thinking block?"""
    banner("2. Explicit GBNF grammar vs the thinking block")
    grammar = r'''
root   ::= "{" ws "\"path\"" ws ":" ws string ws "}"
string ::= "\"" ([^"\\] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4}))* "\""
ws     ::= [ \t\n]*
'''
    msgs = [
        {"role": "system", "content": "Reply with a JSON object naming the file to open."},
        {"role": "user", "content": "Which file holds the token validation? Guess a path."},
    ]
    msg, meta = chat(msgs, grammar=grammar, max_tokens=800)
    if msg is None:
        note(f"**ERROR** {meta.get('error')}")
        note("\n> If this is an HTTP 400, this build may not accept a raw `grammar` field "
             "on /v1/chat/completions. The tool-call path (experiment 3) is what matters.")
        RESULTS["grammar_raw"] = {"supported": False, "error": meta.get("error")}
        return
    rc = msg.get("reasoning_content") or ""
    content = msg.get("content") or ""
    valid = False
    try:
        json.loads(content)
        valid = True
    except Exception:
        pass
    note(f"- content: `{content[:200]}`")
    note(f"- valid JSON under grammar: **{valid}**")
    note(f"- reasoning survived the grammar: **{bool(rc)}** (~{len(rc)//4} tokens)")
    note("")
    if rc:
        note("> Grammar is applied **lazily** — thinking is unconstrained, only the answer "
             "is forced. The two-call split is then a choice (per-phase temperature), "
             "not a necessity.")
    else:
        note("> Grammar appears to bind from the first token, suppressing thinking. "
             "The two-call split becomes **mandatory**: reason first with a stop "
             "sequence, then emit the call under grammar.")
    RESULTS["grammar_raw"] = {"supported": True, "valid_json": valid,
                              "thinking_survived": bool(rc)}


def exp3_constrained_tool_calls(n=6):
    """tool_choice=required — the closest thing to 'the model cannot not call a tool'."""
    banner("3. Forced tool call (tool_choice=required) — the permission-grammar mechanism")
    msgs = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": "Fix the failing login test."},
    ]
    read_only = [t for t in TOOLS if t["function"]["name"] in ("read_file", "search_code")]
    ok, wrote, failed, thinking = 0, 0, 0, 0
    for i in range(n):
        msg, meta = chat(msgs, tools=read_only, tool_choice="required", temperature=0.1)
        if msg is None:
            note(f"- run {i+1}: **ERROR** {meta.get('error')}")
            failed += 1
            continue
        tc = msg.get("tool_calls") or []
        if msg.get("reasoning_content"):
            thinking += 1
        if not tc:
            failed += 1
            note(f"- run {i+1}: no tool call despite tool_choice=required")
            continue
        name = tc[0]["function"]["name"]
        if name not in ("read_file", "search_code"):
            wrote += 1
            note(f"- run {i+1}: **called a tool outside the offered set**: {name}")
        else:
            try:
                json.loads(tc[0]["function"]["arguments"])
                ok += 1
            except Exception:
                failed += 1
    note(f"\n**{ok}/{n}** stayed inside the read-only tool set with valid arguments; "
         f"{wrote} escaped it; {failed} failed")
    note(f"- reasoning still produced under tool_choice=required: {thinking}/{n}")
    note("")
    note("> This is the plan-mode mechanism: if restricting the offered tool set is "
         "honoured 100% of the time, plan mode needs no post-hoc rejection at all.")
    RESULTS["forced"] = {"ok": ok, "n": n, "escaped": wrote, "failed": failed}


def exp4_escaping_stress(n=5):
    """Can it put backslash/quote-heavy C# through a JSON string argument correctly?"""
    banner("4. JSON escaping stress — is 'payload outside JSON' actually needed?")
    msgs = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content":
            "Here is `PathRules.cs`:\n\n```csharp\n" + NASTY_FILE + "```\n\n"
            "Change the Describe method so that when the path is not a Windows path it "
            "returns the string  not a windows path: \"<p>\"  with the path in escaped "
            "quotes. Use edit_file. search_text must match the file exactly."},
    ]
    exact, near, broken, out_tokens = 0, 0, 0, []
    for i in range(n):
        msg, meta = chat(msgs, tools=TOOLS, temperature=0.1, max_tokens=2000)
        if msg is None:
            note(f"- run {i+1}: **ERROR** {meta.get('error')}")
            broken += 1
            continue
        out_tokens.append(meta.get("completion_tokens") or 0)
        tc = msg.get("tool_calls") or []
        if not tc:
            broken += 1
            note(f"- run {i+1}: no tool call")
            continue
        try:
            args = json.loads(tc[0]["function"]["arguments"])
        except Exception as e:
            broken += 1
            note(f"- run {i+1}: **arguments not valid JSON** ({e})")
            continue
        needle = args.get("search_text", "")
        if not needle:
            broken += 1
            continue
        if needle in NASTY_FILE:
            exact += 1
        elif needle.strip() and re.sub(r"\s+", " ", needle.strip()) in \
                re.sub(r"\s+", " ", NASTY_FILE):
            near += 1
            note(f"- run {i+1}: search_text matches only after whitespace normalisation")
        else:
            broken += 1
            note(f"- run {i+1}: search_text does NOT occur in the file; first line: "
                 f"{needle.splitlines()[0][:100]!r}")
    note(f"\n**{exact}/{n} byte-exact anchors**, {near} whitespace-tolerant, {broken} unusable")
    if out_tokens:
        mean = sum(out_tokens) / len(out_tokens)
        note(f"- output: {mean:.0f} tokens mean ⇒ **{mean/30.5:.0f} s** per edit at 30.5 tok/s")
        full = len(NASTY_FILE) / 3.2
        note(f"- rewriting this whole file instead would be ~{full:.0f} tokens "
             f"⇒ {full/30.5:.0f} s ({full/max(mean,1):.1f}× more)")
    note("")
    note("> Byte-exact anchoring is the risk that decides SEARCH/REPLACE. If exact match "
         "is unreliable, the matcher must normalise whitespace and re-ask on miss.")
    RESULTS["escaping"] = {"exact": exact, "near": near, "broken": broken, "n": n,
                           "mean_out_tokens": (sum(out_tokens)/len(out_tokens)) if out_tokens else None}


def exp5_two_call_split():
    """Reason with one call (stopped at the boundary), emit the call with another."""
    banner("5. Two-call split — does the second call reuse the warm prefix?")
    msgs = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content":
            "Decide which single file to open first to debug a failing login test, "
            "then call the tool."},
    ]
    m1, meta1 = chat(msgs, tools=TOOLS, temperature=0.6, max_tokens=900)
    if m1 is None:
        note(f"**ERROR on call 1** {meta1.get('error')}")
        return
    note(f"- call 1: {meta1.get('completion_tokens')} tokens generated, "
         f"prefill {meta1.get('prompt_tokens')} tokens "
         f"@ {meta1.get('prompt_per_second') or float('nan'):.0f} t/s")

    # Second call: identical prefix, plus whatever call 1 produced. Prefill should be
    # tiny if the slot's cache is being reused.
    follow = msgs + [{"role": "assistant",
                      "content": (m1.get("content") or "")[:400] or "Opening the file."}]
    m2, meta2 = chat(follow + [{"role": "user", "content": "Now call the tool."}],
                     tools=TOOLS, tool_choice="required", temperature=0.1, max_tokens=400)
    if m2 is None:
        note(f"**ERROR on call 2** {meta2.get('error')}")
        return
    pp = meta2.get("prompt_per_second")
    note(f"- call 2: prefill {meta2.get('prompt_tokens')} tokens "
         f"@ {pp:.0f} t/s" if pp else f"- call 2: prefill {meta2.get('prompt_tokens')} tokens")
    note(f"- call 2 wall time: **{meta2['wall']:.1f} s** for "
         f"{meta2.get('completion_tokens')} generated tokens")
    note("")
    note("> If call 2's wall time is close to (generated tokens / 30.5), the prefix was "
         "cached and splitting a turn into two calls is effectively free.")
    RESULTS["split"] = {"call2_wall": meta2["wall"],
                        "call2_completion": meta2.get("completion_tokens")}


def exp6_prefix_cache_law():
    """The central design law: append is cheap, mutating history is not."""
    banner("6. Prefix cache: append-only vs mutating history (THE design law)")
    filler = "\n".join(
        f"    public int Field{i} {{ get; set; }}  // column {i} of the ledger table"
        for i in range(600)
    )
    base = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"Here is a generated model class:\n```csharp\n"
                                    f"public class Ledger\n{{\n{filler}\n}}\n```\n"
                                    f"Reply with the single word OK."},
    ]

    _, m_cold = chat(base, max_tokens=4, temperature=0.1)
    note(f"- cold  : prefill {m_cold.get('prompt_tokens')} tokens, "
         f"{m_cold['wall']:.1f} s wall"
         + (f", {m_cold['prompt_per_second']:.0f} t/s" if m_cold.get('prompt_per_second') else ""))

    appended = base + [
        {"role": "assistant", "content": "OK"},
        {"role": "user", "content": "Still OK? Reply OK."},
    ]
    _, m_app = chat(appended, max_tokens=4, temperature=0.1)
    note(f"- append: prefill {m_app.get('prompt_tokens')} tokens, "
         f"{m_app['wall']:.1f} s wall"
         + (f", {m_app['prompt_per_second']:.0f} t/s" if m_app.get('prompt_per_second') else ""))

    mutated = [base[0],
               {"role": "user", "content": base[1]["content"].replace("Field0 ", "FieldZero ", 1)},
               {"role": "assistant", "content": "OK"},
               {"role": "user", "content": "Still OK? Reply OK."}]
    _, m_mut = chat(mutated, max_tokens=4, temperature=0.1)
    note(f"- mutate: prefill {m_mut.get('prompt_tokens')} tokens, "
         f"{m_mut['wall']:.1f} s wall"
         + (f", {m_mut['prompt_per_second']:.0f} t/s" if m_mut.get('prompt_per_second') else ""))

    note("")
    if m_app["wall"] > 0:
        note(f"**mutate / append wall-time ratio: {m_mut['wall'] / m_app['wall']:.1f}×** "
             f"for a one-word change near the start of a ~{m_cold.get('prompt_tokens')}-token history.")
    note("> A large ratio confirms law 1: the prompt must be append-only, and any "
         "context management that edits history mid-session is disqualified.")
    RESULTS["cache"] = {"cold_wall": m_cold["wall"], "append_wall": m_app["wall"],
                        "mutate_wall": m_mut["wall"],
                        "prompt_tokens": m_cold.get("prompt_tokens")}


EXPERIMENTS = {
    1: exp1_native_tool_calls,
    2: exp2_grammar_vs_thinking,
    3: exp3_constrained_tool_calls,
    4: exp4_escaping_stress,
    5: exp5_two_call_split,
    6: exp6_prefix_cache_law,
}


def main():
    global BASE_URL
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=BASE_URL)
    ap.add_argument("--only", default="", help="comma-separated experiment numbers")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] /
                                        "docs" / "SPIKE-RESULTS.md"))
    args = ap.parse_args()
    BASE_URL = args.base_url.rstrip("/")

    REPORT.append("# PrivateCode spike results\n")
    REPORT.append(f"Server: `{BASE_URL}`\n")

    if not exp0_server_facts():
        sys.exit(1)

    chosen = [int(x) for x in args.only.split(",") if x.strip()] or sorted(EXPERIMENTS)
    t0 = time.perf_counter()
    for k in chosen:
        try:
            EXPERIMENTS[k]()
        except Exception as e:
            note(f"\n**experiment {k} crashed:** {e!r}")
    note(f"\n---\n\nTotal spike time: {(time.perf_counter()-t0)/60:.1f} min")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(REPORT), encoding="utf-8")
    (out.parent / "SPIKE-RESULTS.json").write_text(
        json.dumps(RESULTS, indent=2), encoding="utf-8")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Third spike: pick the production strategy for getting an edit out of the model.

Established so far:
  - thinking runs away on hard edits (up to 6119 tokens / 120 s) and raising max_tokens
    does not help, it just buys a longer spiral
  - tool_choice=required cuts median thinking 5591 -> 1262 and doubles the call rate
  - every non-empty SEARCH anchor produced so far was byte-exact
  - empty required-string arguments do occur and pass schema validation

Question: which strategy gives the highest call rate at bounded latency?

  S1  tool_choice=required, moderate cap
  S2  two-phase: reason under a small cap, then force the call on a second request
      (the design's per-phase split, now load-bearing rather than cosmetic)
  S3  tool_choice=required + a system-prompt nudge against long deliberation
"""

import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from grammar_spike import NASTY_FILE, TOOLS, SYSTEM, chat, note, banner, REPORT  # noqa: E402
import grammar_spike  # noqa: E402

grammar_spike.BASE_URL = "http://127.0.0.1:8080"

TASK = ("Here is `PathRules.cs`:\n\n```csharp\n" + NASTY_FILE + "```\n\n"
        "Change the Describe method so that when the path is not a Windows path it "
        "returns the string  not a windows path: \"<p>\"  with the path in escaped "
        "quotes. Use edit_file. search_text must match the file exactly.")

TERSE = (SYSTEM + " Decide quickly and act. Do not deliberate at length: pick the "
         "smallest edit that satisfies the request and call the tool. If you find "
         "yourself re-checking a decision you already made, stop and call the tool.")

N = 6


def score(msg, meta, rec):
    """Classify one attempt into rec (a dict of counters)."""
    rec["wall"].append(meta["wall"])
    rec["out"].append(meta.get("completion_tokens") or 0)
    rec["think"].append(len(msg.get("reasoning_content") or "") // 4 if msg else 0)
    if msg is None:
        rec["error"] += 1
        return
    if meta.get("finish_reason") == "length":
        rec["truncated"] += 1
    tc = msg.get("tool_calls") or []
    if not tc:
        rec["no_call"] += 1
        return
    rec["called"] += 1
    try:
        args = json.loads(tc[0]["function"]["arguments"])
    except Exception:
        rec["bad_json"] += 1
        return
    needle = args.get("search_text", "")
    if not needle.strip():
        rec["empty_arg"] += 1
    elif needle in NASTY_FILE:
        rec["exact"] += 1
    else:
        rec["miss"] += 1


def blank():
    return {"called": 0, "exact": 0, "miss": 0, "empty_arg": 0, "bad_json": 0,
            "no_call": 0, "truncated": 0, "error": 0,
            "wall": [], "out": [], "think": []}


def report(label, rec, n):
    note(f"\n**usable edits {rec['exact']}/{n}** "
         f"(called {rec['called']}, byte-exact {rec['exact']}, anchor miss {rec['miss']}, "
         f"empty arg {rec['empty_arg']}, no call {rec['no_call']}, truncated {rec['truncated']})")
    if rec["wall"]:
        note(f"- wall: median **{statistics.median(rec['wall']):.1f} s**, "
             f"max {max(rec['wall']):.1f} s")
    if rec["think"]:
        note(f"- thinking: median {statistics.median(rec['think']):.0f} tok, "
             f"max {max(rec['think'])} tok")
    return {"label": label, **{k: v for k, v in rec.items()
                               if k not in ("wall", "out", "think")},
            "wall_median": statistics.median(rec["wall"]) if rec["wall"] else None,
            "wall_max": max(rec["wall"]) if rec["wall"] else None,
            "think_median": statistics.median(rec["think"]) if rec["think"] else None}


def s1_forced_capped():
    banner("S1. tool_choice=required, max_tokens=3000")
    rec = blank()
    for _ in range(N):
        msg, meta = chat([{"role": "system", "content": SYSTEM},
                          {"role": "user", "content": TASK}],
                         tools=TOOLS, tool_choice="required",
                         temperature=0.1, max_tokens=3000)
        score(msg, meta, rec)
    return report("S1 forced+cap3000", rec, N)


def s2_two_phase():
    banner("S2. Two-phase: reason under a 1200-token cap, then force the call")
    rec = blank()
    for i in range(N):
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": TASK}]
        t0 = time.perf_counter()
        m1, meta1 = chat(msgs, tools=TOOLS, temperature=0.6, max_tokens=1200)
        phase1_think = len((m1 or {}).get("reasoning_content") or "") // 4
        # If phase 1 already produced the call, take it.
        if m1 and (m1.get("tool_calls") or []):
            meta1["wall"] = time.perf_counter() - t0
            score(m1, meta1, rec)
            note(f"- run {i+1}: phase 1 already called the tool "
                 f"({phase1_think} think tok)")
            continue
        # Otherwise carry the partial reasoning forward and force commitment.
        carry = msgs + [{
            "role": "user",
            "content": "Stop deliberating. Emit the edit_file call now, with a "
                       "search_text copied verbatim from the file above."}]
        m2, meta2 = chat(carry, tools=TOOLS, tool_choice="required",
                         temperature=0.1, max_tokens=2500)
        meta2["wall"] = time.perf_counter() - t0
        score(m2, meta2, rec)
        note(f"- run {i+1}: phase 1 spent {phase1_think} think tok, "
             f"phase 2 {'called' if m2 and m2.get('tool_calls') else 'did not call'}")
    return report("S2 two-phase", rec, N)


def s3_terse_system():
    banner("S3. tool_choice=required + anti-deliberation system prompt")
    rec = blank()
    for _ in range(N):
        msg, meta = chat([{"role": "system", "content": TERSE},
                          {"role": "user", "content": TASK}],
                         tools=TOOLS, tool_choice="required",
                         temperature=0.1, max_tokens=3000)
        score(msg, meta, rec)
    return report("S3 terse+forced", rec, N)


def main():
    REPORT.clear()
    REPORT.append("# Spike 3: production strategy for reliable edits\n")
    out = [s1_forced_capped(), s2_two_phase(), s3_terse_system()]

    banner("Summary")
    note("| strategy | usable edits | wall median | wall max | thinking median |")
    note("|---|---|---|---|---|")
    for r in out:
        note(f"| {r['label']} | **{r['exact']}/{N}** | {r['wall_median']:.1f} s | "
             f"{r['wall_max']:.1f} s | {r['think_median']:.0f} tok |")

    docs = Path(__file__).resolve().parents[1] / "docs"
    (docs / "SPIKE-STRATEGY.md").write_text("\n".join(REPORT), encoding="utf-8")
    (docs / "SPIKE-STRATEGY.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nWrote {docs / 'SPIKE-STRATEGY.md'}")


if __name__ == "__main__":
    main()

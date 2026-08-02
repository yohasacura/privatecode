#!/usr/bin/env python3
"""
Follow-up probe for spike experiment 4.

Experiment 4 produced a tool call in only 1 of 5 runs, with mean output 1898 tokens
against a max_tokens cap of 2000. Hypothesis: the cap truncated the model mid-thinking,
so it never reached the tool call. This probe separates that from a real failure to edit.

Also measures what an agent must handle in production:
  - how long thinking actually runs on an editing task
  - whether byte-exact SEARCH anchors are achievable
  - whether whitespace-tolerant matching rescues the misses
"""

import json
import re
import statistics
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from grammar_spike import NASTY_FILE, TOOLS, SYSTEM, chat, note, banner, REPORT  # noqa: E402
import grammar_spike  # noqa: E402

grammar_spike.BASE_URL = "http://127.0.0.1:8080"

TASK = ("Here is `PathRules.cs`:\n\n```csharp\n" + NASTY_FILE + "```\n\n"
        "Change the Describe method so that when the path is not a Windows path it "
        "returns the string  not a windows path: \"<p>\"  with the path in escaped "
        "quotes. Use edit_file. search_text must match the file exactly.")

SMALL_FILE = '''def slugify(title):
    return title.lower().replace(" ", "-")
'''
SMALL_TASK = ("Here is `slug.py`:\n\n```python\n" + SMALL_FILE + "```\n\n"
              "Also strip punctuation. Use edit_file.")


def run_case(label, *, task, max_tokens, tool_choice=None, n=5):
    banner(f"{label}")
    called, exact, near, missed, truncated = 0, 0, 0, 0, 0
    think_tokens, total_tokens, walls = [], [], []
    haystack = NASTY_FILE if task is TASK else SMALL_FILE

    for i in range(n):
        msg, meta = chat(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": task}],
            tools=TOOLS, temperature=0.1, max_tokens=max_tokens, tool_choice=tool_choice,
        )
        if msg is None:
            note(f"- run {i+1}: ERROR {meta.get('error')}")
            continue

        fr = meta.get("finish_reason")
        rc = msg.get("reasoning_content") or ""
        content = msg.get("content") or ""
        tc = msg.get("tool_calls") or []
        think_tokens.append(len(rc) // 4)
        total_tokens.append(meta.get("completion_tokens") or 0)
        walls.append(meta["wall"])

        if fr == "length":
            truncated += 1
        if not tc:
            missed += 1
            note(f"- run {i+1}: NO CALL  finish_reason={fr}  "
                 f"thinking≈{len(rc)//4}tok  content={len(content)}ch  "
                 f"content_head={content[:90]!r}")
            continue

        called += 1
        try:
            args = json.loads(tc[0]["function"]["arguments"])
        except Exception as e:
            note(f"- run {i+1}: arguments not valid JSON: {e}")
            continue
        needle = args.get("search_text", "")
        if needle and needle in haystack:
            exact += 1
        elif needle and re.sub(r"\s+", " ", needle.strip()) in re.sub(r"\s+", " ", haystack):
            near += 1
            note(f"- run {i+1}: anchor matches only after whitespace normalisation")
        else:
            note(f"- run {i+1}: anchor NOT found. head={needle.splitlines()[0][:90]!r}"
                 if needle else f"- run {i+1}: empty search_text")

    note(f"\n**called {called}/{n}** · anchor byte-exact {exact} · "
         f"whitespace-tolerant {near} · no call {missed} · truncated by max_tokens {truncated}")
    if think_tokens:
        note(f"- thinking: median {statistics.median(think_tokens):.0f} tok, "
             f"max {max(think_tokens)} tok")
    if total_tokens:
        note(f"- total output: median {statistics.median(total_tokens):.0f} tok")
    if walls:
        note(f"- wall time: median {statistics.median(walls):.1f} s, max {max(walls):.1f} s")
    return {"called": called, "n": n, "exact": exact, "near": near,
            "missed": missed, "truncated": truncated,
            "think_median": statistics.median(think_tokens) if think_tokens else None,
            "wall_median": statistics.median(walls) if walls else None}


def main():
    REPORT.clear()
    REPORT.append("# Spike follow-up: why experiment 4 failed\n")
    out = {}
    out["A_cap2000"] = run_case(
        "A. Original conditions (max_tokens=2000, tool_choice=auto) — reproduce the failure",
        task=TASK, max_tokens=2000)
    out["B_cap8000"] = run_case(
        "B. Same task, max_tokens=8000 — does the cap explain it?",
        task=TASK, max_tokens=8000)
    out["C_forced"] = run_case(
        "C. max_tokens=8000 + tool_choice=required",
        task=TASK, max_tokens=8000, tool_choice="required")
    out["D_small"] = run_case(
        "D. Small, escaping-free file (control)",
        task=SMALL_TASK, max_tokens=8000)

    docs = Path(__file__).resolve().parents[1] / "docs"
    (docs / "SPIKE-EDIT-PROBE.md").write_text("\n".join(REPORT), encoding="utf-8")
    (docs / "SPIKE-EDIT-PROBE.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nWrote {docs / 'SPIKE-EDIT-PROBE.md'}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Fourth spike: is low temperature the cause of the thinking spiral?

Every runaway observed so far (1587 / 2086 / 5591 / 6119 / 6285 thinking tokens)
happened at temperature 0.1. No runaway was seen at 0.6. But the comparisons were
confounded: the low-temperature runs also used a different system prompt and cap.

This isolates temperature. Everything else is held fixed:
  same task, same system prompt (except arm T3), same cap, tool_choice=required.

The design currently specifies temp 0.1 for the tool-emitting phase on the theory that
creativity hurts structured output. If temperature is the cause, that decision is wrong
and must be reversed before any code is written.
"""

import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from grammar_spike import NASTY_FILE, TOOLS, SYSTEM, chat, note, banner, REPORT  # noqa: E402
from strategy_probe import TASK, TERSE, blank, score, report  # noqa: E402
import grammar_spike  # noqa: E402

grammar_spike.BASE_URL = "http://127.0.0.1:8080"

N = 6
CAP = 4000


def arm(label, *, temperature, system, top_p=0.95, top_k=20):
    banner(label)
    rec = blank()
    for i in range(N):
        msg, meta = chat([{"role": "system", "content": system},
                          {"role": "user", "content": TASK}],
                         tools=TOOLS, tool_choice="required",
                         temperature=temperature, max_tokens=CAP)
        score(msg, meta, rec)
        th = len((msg or {}).get("reasoning_content") or "") // 4
        note(f"- run {i+1}: think {th} tok, {meta['wall']:.1f} s, "
             f"finish={meta.get('finish_reason')}, "
             f"call={'yes' if msg and msg.get('tool_calls') else 'NO'}")
    return report(label, rec, N)


def main():
    REPORT.clear()
    REPORT.append("# Spike 4: does temperature cause the thinking spiral?\n")
    REPORT.append(f"Held fixed: same task, `tool_choice=required`, `max_tokens={CAP}`, "
                  f"n={N} per arm.\n")

    out = [
        arm("T1. temp 0.1, standard system prompt", temperature=0.1, system=SYSTEM),
        arm("T2. temp 0.6, standard system prompt (Qwen's recommendation)",
            temperature=0.6, system=SYSTEM),
        arm("T3. temp 0.6 + anti-deliberation prompt (candidate production config)",
            temperature=0.6, system=TERSE),
    ]

    banner("Summary")
    note("| arm | usable edits | truncated | wall median | wall max | thinking median | thinking max |")
    note("|---|---|---|---|---|---|---|")
    for r in out:
        note(f"| {r['label'].split('.')[0]} | **{r['exact']}/{N}** | {r['truncated']} | "
             f"{r['wall_median']:.1f} s | {r['wall_max']:.1f} s | "
             f"{r['think_median']:.0f} tok | —|")

    docs = Path(__file__).resolve().parents[1] / "docs"
    (docs / "SPIKE-TEMPERATURE.md").write_text("\n".join(REPORT), encoding="utf-8")
    (docs / "SPIKE-TEMPERATURE.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nWrote {docs / 'SPIKE-TEMPERATURE.md'}")


if __name__ == "__main__":
    main()

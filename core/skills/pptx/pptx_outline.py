"""Print the outline of a .pptx deck: one block per slide with its layout, title, text
frames (with bullet levels), tables, pictures and speaker notes.

    python pptx_outline.py deck.pptx          human-readable
    python pptx_outline.py deck.pptx --json   one JSON document

Needs python-pptx (`python -m pip install python-pptx`).
"""
from __future__ import annotations

import json
import sys

try:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
except ImportError:  # pragma: no cover - the skill's SKILL.md says how to install it
    sys.stderr.write("python-pptx is not installed: python -m pip install python-pptx\n")
    sys.exit(2)


def paragraphs(text_frame) -> list[dict]:
    out = []
    for p in text_frame.paragraphs:
        text = "".join(run.text for run in p.runs).strip()
        if text:
            out.append({"level": p.level, "text": text})
    return out


def walk(shapes, into: dict) -> None:
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            walk(shape.shapes, into)
            continue
        if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
            into["pictures"].append({"name": shape.name, "width_in": round(shape.width / 914400, 2), "height_in": round(shape.height / 914400, 2)})
            continue
        if getattr(shape, "has_table", False) and shape.has_table:
            rows = []
            for row in shape.table.rows:
                rows.append([cell.text.strip() for cell in row.cells])
            into["tables"].append({"name": shape.name, "rows": rows})
            continue
        if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
            paras = paragraphs(shape.text_frame)
            if paras:
                into["texts"].append({"name": shape.name, "placeholder": shape.is_placeholder, "paragraphs": paras})


def slide_info(index: int, slide) -> dict:
    title = ""
    if slide.shapes.title is not None and slide.shapes.title.has_text_frame:
        title = slide.shapes.title.text_frame.text.strip()
    info = {"index": index, "layout": slide.slide_layout.name, "title": title, "texts": [], "tables": [], "pictures": [], "notes": ""}
    walk(slide.shapes, info)
    # The title's own frame is listed under texts too; drop it there so it is not shown twice.
    info["texts"] = [t for t in info["texts"] if not (title and len(t["paragraphs"]) == 1 and t["paragraphs"][0]["text"] == title)]
    if slide.has_notes_slide:
        info["notes"] = slide.notes_slide.notes_text_frame.text.strip()
    return info


def render(deck: dict) -> str:
    lines = [f"{deck['file']}: {len(deck['slides'])} slides, {deck['width_in']}x{deck['height_in']} in"]
    for s in deck["slides"]:
        lines.append("")
        lines.append(f"Slide {s['index']} - layout \"{s['layout']}\"")
        if s["title"]:
            lines.append(f"  Title: {s['title']}")
        for t in s["texts"]:
            for p in t["paragraphs"]:
                lines.append(f"  {'  ' * p['level']}- {p['text']}")
        for t in s["tables"]:
            lines.append(f"  Table {len(t['rows'])}x{len(t['rows'][0]) if t['rows'] else 0}:")
            for row in t["rows"]:
                lines.append("    | " + " | ".join(row) + " |")
        for p in s["pictures"]:
            lines.append(f"  Picture: {p['name']} ({p['width_in']}x{p['height_in']} in)")
        if s["notes"]:
            lines.append(f"  Notes: {s['notes']}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        sys.stderr.write(__doc__)
        return 1
    prs = Presentation(args[0])
    deck = {
        "file": args[0],
        "width_in": round(prs.slide_width / 914400, 2),
        "height_in": round(prs.slide_height / 914400, 2),
        "slides": [slide_info(i, slide) for i, slide in enumerate(prs.slides, start=1)],
    }
    if "--json" in argv:
        print(json.dumps(deck, ensure_ascii=False, indent=2))
    else:
        print(render(deck))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

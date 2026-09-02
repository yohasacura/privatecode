"""Replace text throughout a .pptx deck, keeping the formatting of the run that held it.

    python pptx_replace.py in.pptx out.pptx "old=>new" ["old2=>new2" ...]

Every slide, every text frame, table cell and note is searched. A pair that changed
nothing is reported: the text is probably split across differently formatted runs — print
the outline (pptx_outline.py) and look for the pieces. Needs python-pptx.
"""
from __future__ import annotations

import sys

try:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
except ImportError:  # pragma: no cover
    sys.stderr.write("python-pptx is not installed: python -m pip install python-pptx\n")
    sys.exit(2)


def replace_in_frame(text_frame, old: str, new: str) -> int:
    count = 0
    for p in text_frame.paragraphs:
        runs = list(p.runs)
        for run in runs:
            if old in run.text:
                count += run.text.count(old)
                run.text = run.text.replace(old, new)
        # Split across runs: the paragraph holds it, no single run does. Put the whole
        # paragraph's text into the first run (its formatting) and empty the others.
        joined = "".join(r.text for r in runs)
        if old in joined and runs:
            count += joined.count(old)
            runs[0].text = joined.replace(old, new)
            for r in runs[1:]:
                r.text = ""
    return count


def walk(shapes, old: str, new: str) -> int:
    count = 0
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            count += walk(shape.shapes, old, new)
            continue
        if getattr(shape, "has_table", False) and shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    count += replace_in_frame(cell.text_frame, old, new)
            continue
        if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
            count += replace_in_frame(shape.text_frame, old, new)
    return count


def main(argv: list[str]) -> int:
    if len(argv) < 3 or any("=>" not in pair for pair in argv[2:]):
        sys.stderr.write(__doc__)
        return 1
    prs = Presentation(argv[0])
    for pair in argv[2:]:
        old, new = pair.split("=>", 1)
        count = 0
        for slide in prs.slides:
            count += walk(slide.shapes, old, new)
            if slide.has_notes_slide:
                count += replace_in_frame(slide.notes_slide.notes_text_frame, old, new)
        print(f"{old!r} -> {new!r}: {count} place(s)")
    prs.save(argv[1])
    print(f"wrote {argv[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

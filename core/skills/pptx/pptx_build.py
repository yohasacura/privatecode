"""Build a .pptx deck from a Markdown outline.

    python pptx_build.py outline.md out.pptx [--template deck.pptx] [--keep-slides]

Outline:
    # Deck title                 the title slide; the paragraph after it is the subtitle
    ## Slide title               a new slide ("Title and Content" layout)
    - bullet / two spaces per   bullets with levels
      - sub-bullet
    plain line                   a bullet-less paragraph in the body
    | a | b |                    a table (first row is the header)
    ![alt](path.png)             a picture, path relative to the outline file
    > notes: text                speaker notes (every `>` line on the slide)
    ---                          ignored

With --template the template's "Title Slide" / "Title and Content" layouts are used and
its existing slides are dropped (kept with --keep-slides). Needs python-pptx.
"""
from __future__ import annotations

import os
import re
import sys

try:
    from pptx import Presentation
    from pptx.util import Inches, Pt
except ImportError:  # pragma: no cover
    sys.stderr.write("python-pptx is not installed: python -m pip install python-pptx\n")
    sys.exit(2)


class Slide:
    def __init__(self, title: str, kind: str) -> None:
        self.title = title
        self.kind = kind  # "title" or "content"
        self.subtitle: list[str] = []
        self.items: list[tuple[int, str]] = []  # (level, text); level -1 = plain paragraph
        self.table: list[list[str]] = []
        self.pictures: list[str] = []
        self.notes: list[str] = []


def parse(text: str) -> list[Slide]:
    slides: list[Slide] = []
    current: Slide | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.strip() == "---":
            continue
        if line.startswith("# "):
            current = Slide(line[2:].strip(), "title")
            slides.append(current)
            continue
        if line.startswith("## "):
            current = Slide(line[3:].strip(), "content")
            slides.append(current)
            continue
        if current is None:
            current = Slide("", "content")
            slides.append(current)
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped.startswith(">"):
            note = stripped[1:].strip()
            note = re.sub(r"^notes?:\s*", "", note, flags=re.IGNORECASE)
            current.notes.append(note)
        elif stripped.startswith("![") and "](" in stripped and stripped.endswith(")"):
            current.pictures.append(stripped[stripped.index("](") + 2:-1].strip())
        elif stripped.startswith("|") and stripped.endswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if all(re.fullmatch(r":?-+:?", c) for c in cells if c):
                continue  # a markdown header separator row
            current.table.append(cells)
        elif stripped.startswith(("- ", "* ")):
            current.items.append((indent // 2, stripped[2:].strip()))
        elif current.kind == "title":
            current.subtitle.append(stripped)
        else:
            current.items.append((-1, stripped))
    return slides


def layout_named(prs, wanted: str, fallback_index: int):
    for layout in prs.slide_layouts:
        if layout.name.lower() == wanted.lower():
            return layout
    layouts = list(prs.slide_layouts)
    return layouts[min(fallback_index, len(layouts) - 1)]


def drop_slides(prs) -> None:
    sldIdLst = prs.slides._sldIdLst  # noqa: SLF001 - python-pptx has no public delete
    for sldId in list(sldIdLst):
        prs.part.drop_rel(sldId.rId)
        sldIdLst.remove(sldId)


def body_placeholder(slide):
    for shape in slide.placeholders:
        if shape.placeholder_format.idx == 1:
            return shape
    for shape in slide.placeholders:
        if shape.placeholder_format.idx not in (0,) and shape.has_text_frame:
            return shape
    return None


def fill_text(slide, prs, items: list[tuple[int, str]]):
    """Returns the bottom edge (EMU) of the text, for placing a table or picture below."""
    if not items:
        return Inches(1.5)
    body = body_placeholder(slide)
    if body is None:
        body = slide.shapes.add_textbox(Inches(0.7), Inches(1.5), prs.slide_width - Inches(1.4), Inches(4.5))
    tf = body.text_frame
    tf.clear()
    first = True
    for level, text in items:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.text = text
        if level >= 0:
            p.level = min(level, 8)
        else:
            p.level = 0
            # A plain paragraph: no bullet glyph, as far as the layout allows.
            pPr = p._p.get_or_add_pPr()  # noqa: SLF001
            for child in list(pPr):
                if child.tag.endswith("}buNone") or child.tag.endswith("}buChar") or child.tag.endswith("}buAutoNum"):
                    pPr.remove(child)
            pPr.insert(0, pPr.makeelement("{http://schemas.openxmlformats.org/drawingml/2006/main}buNone", {}))
    return body.top + body.height


def add_table(slide, prs, rows: list[list[str]], top):
    cols = max(len(r) for r in rows)
    height = Inches(0.4) * len(rows)
    top = min(top, prs.slide_height - height - Inches(0.5))
    shape = slide.shapes.add_table(len(rows), cols, Inches(0.7), top, prs.slide_width - Inches(1.4), height)
    for r, row in enumerate(rows):
        for c in range(cols):
            cell = shape.table.cell(r, c)
            cell.text = row[c] if c < len(row) else ""
            for p in cell.text_frame.paragraphs:
                for run in p.runs:
                    run.font.size = Pt(14)
                    if r == 0:
                        run.font.bold = True


def add_pictures(slide, prs, paths: list[str], base: str, top, has_text: bool):
    for path in paths:
        full = path if os.path.isabs(path) else os.path.join(base, path)
        if not os.path.exists(full):
            sys.stderr.write(f"picture not found, skipped: {full}\n")
            continue
        if has_text:
            width = prs.slide_width - Inches(1.4)
            pic = slide.shapes.add_picture(full, Inches(0.7), top, width=width)
            if pic.top + pic.height > prs.slide_height:
                scale = (prs.slide_height - top - Inches(0.3)) / pic.height
                pic.height = int(pic.height * scale)
                pic.width = int(pic.width * scale)
        else:
            pic = slide.shapes.add_picture(full, Inches(0.7), Inches(1.5), height=prs.slide_height - Inches(2))
            if pic.width > prs.slide_width - Inches(1.4):
                scale = (prs.slide_width - Inches(1.4)) / pic.width
                pic.width = int(pic.width * scale)
                pic.height = int(pic.height * scale)
            pic.left = int((prs.slide_width - pic.width) / 2)


def build(outline_path: str, out_path: str, template: str | None, keep_slides: bool) -> int:
    with open(outline_path, encoding="utf-8-sig") as f:
        slides = parse(f.read())
    prs = Presentation(template) if template else Presentation()
    if template and not keep_slides:
        drop_slides(prs)
    base = os.path.dirname(os.path.abspath(outline_path))
    for s in slides:
        if s.kind == "title":
            slide = prs.slides.add_slide(layout_named(prs, "Title Slide", 0))
            if slide.shapes.title is not None:
                slide.shapes.title.text = s.title
            sub = body_placeholder(slide)
            if sub is not None and s.subtitle:
                sub.text = "\n".join(s.subtitle)
        else:
            slide = prs.slides.add_slide(layout_named(prs, "Title and Content", 1))
            if slide.shapes.title is not None:
                slide.shapes.title.text = s.title
            bottom = fill_text(slide, prs, s.items)
            if not s.items:
                body = body_placeholder(slide)
                if body is not None and (s.table or s.pictures):
                    body._element.getparent().remove(body._element)  # noqa: SLF001 - an empty "Click to add text" box
            if s.table:
                add_table(slide, prs, s.table, bottom + Inches(0.2) if s.items else Inches(1.5))
            if s.pictures:
                add_pictures(slide, prs, s.pictures, base, bottom + Inches(0.2), bool(s.items) or bool(s.table))
        if s.notes:
            slide.notes_slide.notes_text_frame.text = "\n".join(s.notes)
    prs.save(out_path)
    print(f"wrote {out_path}: {len(slides)} slides")
    return 0


def main(argv: list[str]) -> int:
    template = None
    keep = False
    positional: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--template":
            i += 1
            template = argv[i] if i < len(argv) else None
        elif a == "--keep-slides":
            keep = True
        else:
            positional.append(a)
        i += 1
    if len(positional) != 2:
        sys.stderr.write(__doc__)
        return 1
    return build(positional[0], positional[1], template, keep)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

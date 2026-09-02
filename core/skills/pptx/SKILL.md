---
name: pptx
description: Read, create and edit PowerPoint decks (.pptx) with the python-pptx scripts shipped beside this skill — print a deck's outline, build a deck from a Markdown outline (optionally on a template), replace text everywhere while keeping the formatting. Use when a .pptx, deck, slides or presentation is mentioned, or when asked to turn notes into slides.
argument-hint: [deck.pptx or what the deck should say]
---

# PowerPoint decks

Three scripts sit in this skill's folder (the `Skill` tool's reply names the folder;
call it `$SKILL` below). They need Python 3 with `python-pptx`:

```
python -c "import pptx; print(pptx.__version__)"
```

If that fails, ask before running `python -m pip install python-pptx`.

## Read a deck

```
python "$SKILL/pptx_outline.py" deck.pptx
python "$SKILL/pptx_outline.py" deck.pptx --json
```

Prints one block per slide: the layout, the title, every text frame with bullet levels,
tables row by row, pictures, and speaker notes. Read this before editing anything, and
quote slide numbers from it when you report back.

## Build a deck from an outline

Write the outline as Markdown, then:

```
python "$SKILL/pptx_build.py" outline.md out.pptx
python "$SKILL/pptx_build.py" outline.md out.pptx --template corporate.pptx
```

The outline format:

```markdown
# Deck title
The subtitle, one paragraph.

## First slide title
- a bullet
  - a sub-bullet (two spaces per level)
A plain paragraph is a bullet-less line in the body.
> notes: what to say on this slide

## A slide with a table
| Metric | Q1 | Q2 |
| Revenue | 10 | 12 |

## A slide with a picture
![chart](charts/revenue.png)
```

`#` makes the title slide, every `##` a new slide. With `--template`, the template's own
"Title Slide" and "Title and Content" layouts are used, so the deck looks like the
template; its existing slides are dropped unless `--keep-slides` is given. Without a
template, the default theme is used. Picture paths are relative to the outline file.

## Change text in an existing deck

```
python "$SKILL/pptx_replace.py" in.pptx out.pptx "2024=>2025" "Acme Ltd=>Acme GmbH"
```

Replaces in every slide, table cell and note; the formatting of the run that held the
text is kept. The script prints how many places changed per pair — zero means the text
is split across differently formatted runs; read the outline and look for the pieces.

## Procedure

1. When a deck exists, print its outline first and confirm which slides are meant.
2. For a new deck, write the outline file into the workspace, build it, then print the
   outline of the result to check it says what was asked.
3. For an edit, prefer `pptx_replace.py`; for structural changes (new slides, reordering),
   rebuild from an outline written from the printed one, or write a short python-pptx
   script that opens the deck and makes exactly the change (the outline tells you the
   shape names and indexes).
4. Name the output file; never overwrite the input unless asked.

## What is not available here

Rendering slides to images or PDF needs PowerPoint or LibreOffice on the machine. With
PowerPoint installed, this exports a PDF:

```
powershell -Command "$p = New-Object -ComObject PowerPoint.Application; $d = $p.Presentations.Open((Resolve-Path 'out.pptx').Path, $true, $false, $false); $d.SaveAs((Resolve-Path '.').Path + '\out.pdf', 32); $d.Close(); $p.Quit()"
```

Say so if neither is installed rather than guessing at how the slides look.

---
name: pptx
description: Make, read and edit PowerPoint decks (.pptx) with the tool beside this skill — a JSON deck spec becomes a designed deck (six themes; cards, stats, charts, tables, timelines) with every text box checked to fit; existing decks are outlined, text-replaced, trimmed, validated and rendered to PNG. Use whenever a .pptx, deck, slides or presentation is mentioned, or notes are to become slides.
argument-hint: [deck.pptx, or what the deck should say]
---

# PowerPoint decks

One tool does everything: `node "$PRIVATECODE_SKILLS/pptx/pptx.cjs" <command>`, written
exactly like that — `PRIVATECODE_SKILLS` is set in the `Bash` tool's environment and points
at the bundled skills folder. If it is ever empty, use the absolute path from the `Folder:`
line of the `Skill` reply instead. `node` is always present (PrivateCode ships its own). No
Python, no npm install.

| Command | Does |
|---|---|
| `check spec.json` | Validates a deck spec and prints the layout plan: what each slide becomes, font sizes, how full each box is, and every problem with the fix |
| `build spec.json out.pptx` | Same, then writes the deck. Refuses when text does not fit (`--force` writes anyway) |
| `render deck.pptx -o qa [--grid] [--pdf] [--width 1600]` | One PNG per slide (and a labelled contact sheet with `--grid`) through the installed PowerPoint; prints the paths |
| `outline deck.pptx [--json]` | What an existing deck says: every slide's title, text, tables, pictures, notes |
| `replace in.pptx out.pptx "old=>new" ...` | Replace text everywhere, formatting kept; prints how many places changed per pair |
| `slides in.pptx out.pptx --keep 1,3-5` / `--drop 2` / `--order 3,1,2` | Trim or reorder slides |
| `validate deck.pptx` | Package checks, each naming its fix |
| `themes` | The six palettes |
| `example spec.json` | Writes a complete sample spec (every slide type) to start from |

## Making a deck

1. Decide the story first: 8–15 slides, one idea per slide, in the order it will be spoken.
2. Write `deck.json` in the workspace, in the user's language. Use the grammar below — the
   layouts are designed; you supply the content. Vary the types: cards, columns, stats, a
   chart, a comparison, a timeline. Bullets on every slide is the failure mode.
3. `check deck.json`. Fix every ✖ (text that does not fit: shorten, split the slide, or move
   detail into `notes`). Read the `!` lines too; they are about how the deck will feel.
4. `build deck.json out.pptx`.
5. `render out.pptx -o qa --grid` and give the user the PNG paths (and the contact sheet).
   The render is the proof: PowerPoint opened the file, and the images show exactly what the
   reader sees. If it says PowerPoint is missing, say so — never describe slides you have not
   rendered.
6. Report: the file, the slide list in one line each, and what you would change next.

To change a built deck, edit the spec and rebuild — it is the source. Never overwrite the
user's own file: build to a new name.

## The spec

```json
{
  "title": "Deck title",  "subtitle": "One line under it",
  "author": "…", "organization": "…", "date": "…",
  "theme": "midnight | forest | coral | slate | ocean | berry",
  "footer": "short deck name shown on content slides (default: the title)",
  "accent": "RRGGBB (optional)",  "font": { "head": "Cambria", "body": "Calibri" },
  "slides": [ …one object per slide… ]
}
```

Every slide has a `"type"`; content slides also take `"subtitle"` (one italic line under the
title), `"callout"` (the takeaway strip at the bottom, one sentence) and `"notes"` (speaker
notes — the spoken argument, as long as needed). Slide types:

| type | fields | holds |
|---|---|---|
| `title` | `title`, `subtitle`, `kicker` (small line above), `author`, `organization`, `date` | the opening slide, dark |
| `section` | `title`, `number`, `text` | a divider, dark |
| `bullets` | `title`, `bullets` (strings or `{ "text", "sub": [...] }`), optional `stats` (1–4 `{ "value", "label" }`) or `image` + `caption` | up to 8 bullets, 160 chars each; stats or a picture on the right |
| `text` | `title`, `text` | a statement of a few sentences, set large |
| `columns` | `title`, `columns`: 2–3 × `{ "heading", "bullets" or "text" }` | side-by-side cards |
| `cards` | `title`, `cards`: 2–6 × `{ "heading" ≤48, "text" ≤260, "icon": "★" or "number": 1 }` | a grid of cards with a badge each |
| `stats` | `title`, `stats`: 1–4 × `{ "value": "94%", "label": "…" }`, optional `text` | big numbers |
| `image` | `title`, `image` (path relative to the spec), `caption`, optional `bullets` or `text`, `imageSide: "left"` | a picture, full width or beside text (PNG/JPEG/GIF/BMP) |
| `chart` | `title`, `chart`: `{ "kind": "bar|column|stacked|line|area|pie|doughnut", "categories": [...], "series": [{ "name", "values": [...] }], "unit": "%", "min", "max" }`, optional `insight` | a native chart, ≤12 categories, ≤4 series; pie/doughnut take one series |
| `table` | `title`, `columns` ≤6, `rows` ≤10 (arrays of cells), `boldFirstColumn` | a styled table; numbers right-align themselves |
| `timeline` | `title`, `steps`: 3–8 × `{ "label": "Mar 2027", "text" ≤150, "key": true }` | milestones on a line; `key` ones stand out |
| `quote` | `text` ≤320, `attribution` | a quotation, dark |
| `comparison` | `title`, `left` and `right`: `{ "heading", "bullets" or "text" }`, `versus` | two sides |
| `closing` | `title`, `text`, `contacts` (≤5 lines) | the last slide, dark |

`example deck.json` writes a 12-slide spec that uses all of them; copy its shapes.

## The shape of a deck

- 8–10 slides means: one `title`, six to eight content slides, one `closing`. No `section`
  dividers — they earn their slide only in decks of 12 or more, and then each one must be
  followed by at least two content slides (`check` refuses a divider that introduces one).
- Material with numbers gets at least one `stats`, `chart` or `table` slide; a list of
  reasons or drivers is `cards`; a before/after or pros/cons is `comparison`; dated plans are
  a `timeline`. `bullets` is for the slide that is genuinely a list.
- Every content slide carries `notes`: two or three sentences the speaker says. Most carry a
  `callout`: the one sentence the audience keeps.
- `check` prints `✖` for what it refuses and `!` for what will make the deck weaker. Fix
  both before building; a `!` about notes, callouts or dividers is a required edit unless the
  user asked for that shape.

## Writing rules the layouts assume

- Titles ≤ 60 characters (a title that wraps is reported). Bullets are phrases, not paragraphs:
  ≤ 6 per slide reads well; 8 is the hard limit. Detail goes into `notes`.
- A `stats` value is a number with its unit ("1.8 млн", "−31%", "6 weeks"), never a sentence;
  the `label` says what it is and against what.
- Use `callout` on every content slide that has a conclusion; it is what the audience keeps.
- Dark slides are title, section, quote, closing. Everything else is light. Do not fight it.
- Charts: one series when the story is a trend; ≤ 8 categories for labels to stay readable.
  Give the axis a `unit`, and `min`/`max` when the interesting range is narrow.
- Pictures must exist as files; the tool refuses a missing path. Draw charts with `chart`, not
  as pictures.
- Every problem the tool prints names the slide (`slides[3]`), the field and the fix. Fix the
  spec; do not edit the .pptx by hand.

## Existing decks

1. `outline deck.pptx` — read before touching anything; quote slide numbers from it.
2. Text changes: `replace deck.pptx new.pptx "2025=>2026" "Acme Ltd=>Acme GmbH"`. A count of
   0 means the phrase is split across formatting runs — find the pieces in the outline and
   replace them separately. Replaced text keeps its formatting and may wrap: render to see.
3. Structure: `slides deck.pptx new.pptx --drop 4` / `--keep 1-3,7` / `--order 1,3,2`.
   New slides in someone else's design are out of scope: build a new deck from a spec, or
   say that the template's layouts cannot be filled here.
4. `validate new.pptx`, then `render new.pptx -o qa` and hand over the PNG paths.

## Rendering

`render` drives Microsoft PowerPoint over COM: fonts are the real ones, so the fit you see is
the fit the reader gets. It attaches to an open PowerPoint without closing it and quits only an
instance it started. Without PowerPoint it exits with code 2 and says so; with LibreOffice
installed, `--pdf` still produces a PDF (fonts may be substituted). PNG files are named
`slide-01.png` … in the output folder; `--grid` adds `slide-grid.jpg`, twelve to a sheet.

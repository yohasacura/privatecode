# The project map

A wiki of the project, written from the code by the local model while the machine is idle,
kept in `.privatecode/map/` as markdown with Obsidian links — readable by the person, by the
agent, and by Obsidian itself.

## Why a map, and why not a summary

The model's context is the bottleneck of a local agent: every turn it rebuilds a picture of
the project out of the files it happens to read, and forgets it at the end. A summary of
summaries is the obvious fix and it fails in a known way — "this module handles orders" is
prose nothing can be done with. So the map is built the other way round:

- **The structure is computed, never written.** Files, symbols, who mentions whose names,
  which tests mention which files, what changes together in git and what the commits that
  touched a file said, come from parsers (tree-sitter; Roslyn for C# is next) and from git.
  Every link in a note points at a real file because it was made from that graph.
- **A note is a form, not an essay.** The model fills fixed fields — what, why, contracts,
  invariants, gotchas — because a fixed shape is what this model does reliably (see
  `docs/DESIGN.md` on structure over prose).
- **The levels carry different knowledge.** A file note holds contracts and traps; a module
  note holds entry points and the flows that run through its files; the project note holds
  the subsystems, the conventions and where to start reading. Nothing is a summary of the
  level below.
- **It stays true by hash.** A note carries the hash of the file it was written from; a
  build re-notes only files whose hash moved, then the modules above them, then the project.
- **A module is described from all of its files or not at all.** A module note is written
  only when every file in it has a fresh note and every subdirectory has a note; the project
  note only once the root module has one. Asked about a directory it had seen half of, the
  model described the other half from its imagination — so a build that stops early, or one
  narrowed to a folder, leaves the levels above unwritten rather than wrong.
- **Links are earned.** A relative import that resolves to a file on the map is a dependency
  by itself. Beyond imports a file uses another when it mentions names the other defines:
  names made of two words (`walkFiles`, `MAX_FILES`) or long capitalised ones, two of them or
  one long enough to be distinctive, never a name defined in a tenth of the files (that is
  vocabulary), never a name a test defines. A path the model writes that is not a file or
  directory of the skeleton is named in the note, not linked; every link in the vault lands.
- **A form that did not parse is asked once more,** with half again as much room and a
  request for brevity; what still fails is listed in the build's last message.
- **It checks itself.** With *Self-check* on, three questions are drawn from the source,
  answered from the note alone and judged; the share answered is the note's *fidelity*,
  shown on the note and in the tab. A low number is a note to rewrite.

## What is where

```
.privatecode/map/
  README.md              how the vault was made
  index.json             the truth: the skeleton and every note as data
  Project.md             the project note
  modules/<dir>.md       one per directory (modules/root.md for the root)
  files/<path>.md        one per source file
```

The markdown is rendered from `index.json` on every build; edits to it are overwritten.
Open the folder as a vault in Obsidian: the graph view is the reference graph, and every
`[[link]]` lands on a note.

## How it is used

- **The Map tab** (inspector → Map): Build / Update with progress, the tree of modules and
  files with each note's state, a search over the notes, one note at a time with the links
  it carries. *Self-check* and *only under…* narrow a build.
- **The agent, without asking**: a `Read` of a file that has a note about these exact bytes
  returns the note's digest on top of the text — what, contracts, invariants, traps, the
  neighbours — once per context. Measured first (`spike/map-help-probe.mts`): told in the
  repo map that a map exists and to read it first, the model read the code instead, one
  question at 21 reads with the map unopened; when it did search the map it took the file
  names from the hits and read the files anyway. Delivered where it already looks, the
  note is read every time.
- **The agent, asking**: the `ProjectMap` tool reads the project note (no arguments), a
  note by path, or searches the notes — and a search hit carries the note's lines that
  matched, not only the path. On a mapped workspace the system prompt says so, as a
  description and not a rule — "use it when it helps, to check a detail or to get the
  overall structure" — by the owner's call: there are requests the map has nothing to say
  about, and sending every one through it first was not wanted. (A first-move rule was
  measured on the way, at 4 of 6; the two deliveries below are what make a description
  enough.) The tool is first in the list, ahead of `Read`.
- **The agent, handed the first move**: the notes nearest the request — the words of the
  request scored against every note, common words discounted — ride in the user message
  itself, in the same leading bracket as the task contract: three files with the lines that
  matched, one module. A request about an unmapped area gets no block. `orientationFor`.
- **The model server has one slot.** A build never asks while a turn runs, and yields
  between notes, so a turn the person starts waits for at most one note.
- **A workspace of several folders is one map.** Every writable folder is a top-level
  module named after itself (`api/src/orders.ts`), git is read per folder, references cross
  folders where the names do, and the project note is asked to say whether the folders are
  parts of one product or unrelated projects that happen to be open together — from what
  the notes and the cross-folder links show, not from a guess. The map lives under the
  primary folder.

## Does it help? Measured

`spike/map-help-probe.mts` asks the same six questions about this repository with the map
and without it (the folder moved aside, so nothing of it can reach the model), scores each
answer against facts that are in the code, and counts every tool call. Three questions are
about `core/src/map`, two about `core/src/session` (17 files noted), one about an area with
no notes, as the control. Results live in `eval/results/map-help-*.md`.

**Offered only** (2026-09-08, the repo map says a map exists and to read it first, the
`ProjectMap` tool is there): the model called the tool in two questions of six and read the
files anyway. Mean score 0.97 with, 0.93 without; reads 12.5 with, 15.8 without; the
differences are inside the noise of single runs (the control question took 221 s one way
and 58 s the other with the same answer). That is what turned "offered" into "delivered".

**Delivered** (the same day, the note on top of every first `Read`, matching lines in
search hits): mean score 0.94, reads 14.0, 105 s — again inside the noise, and the tool
still called in one question of six.

**Told, the measured way** (a first-move rule in the system prompt, the tool first in the
list, its description an instruction): the map read first in four questions of six; mean
score 0.97, reads 12.5, 89 s; the question the model had spent 21 reads on took 14. The
two it skipped it for were a concept it could grep for and a file it could name — the
shapes the delegation measurement predicts, at its 8/12.

**Handed the first move** (the shipped shape: a description in the prompt, the nearest
notes folded into the request, the note on top of a `Read`): mean score 0.97, reads 10.2,
87 s, and not one call to the tool — the notes were already in the request. Per question
against no map: 21 reads → 13, 4 → 2, 26 → 23, 8 → 7; the control question with no notes
went 33 → 12 (the 33 was an outlier). Still one run per cell, so the sizes are rough; the
direction held on every question.

| | score | steps | seconds | reads | tool called |
|---|---:|---:|---:|---:|---:|
| no map | 0.93 | 6.7 | 124 | 15.8 | — |
| offered (a line in the repo map) | 0.97 | 6.8 | 89 | 12.5 | 2 of 6 |
| delivered on Read | 0.94 | 6.0 | 105 | 14.0 | 1 of 6 |
| first-move rule (not shipped) | 0.97 | 5.2 | 89 | 12.5 | 4 of 6 |
| handed the first move | 0.97 | 5.7 | 87 | 10.2 | 0 of 6 |

On a repository whose file names already say where things are, and on questions that ask
for the exact rule and its line, this model still reads the code, and it should. What would
say more is the eval (`eval/README.md`): the same fifteen tasks with hidden tests, with a
map built for the project and without, where a trap the note names is a bug the model does
not write.

## Cost

A note reads the file (up to 24k characters) and writes 200–400 tokens: a few seconds a file
on this machine. A repository of a few thousand files is a first pass of hours, then only
what changed. Self-check is three more calls per file.

## What is next

Roslyn-backed edges for C# (callers, not mentions), cross-cutting concept notes, recipes
from co-change history ("to add an endpoint, touch A, B, C"), a graph view in the tab, and
notes that grow where the agent had to leave the map for the code.

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
- **The agent**: the `ProjectMap` tool reads the project note (no arguments), a note by path,
  or searches the notes; when a map exists the repo map says so, so the model reads a note
  before opening files.
- **The model server has one slot.** A build never asks while a turn runs, and yields
  between notes, so a turn the person starts waits for at most one note.
- **A workspace of several folders is one map.** Every writable folder is a top-level
  module named after itself (`api/src/orders.ts`), git is read per folder, references cross
  folders where the names do, and the project note is asked to say whether the folders are
  parts of one product or unrelated projects that happen to be open together — from what
  the notes and the cross-folder links show, not from a guess. The map lives under the
  primary folder.

## Cost

A note reads the file (up to 24k characters) and writes 200–400 tokens: a few seconds a file
on this machine. A repository of a few thousand files is a first pass of hours, then only
what changed. Self-check is three more calls per file.

## What is next

Roslyn-backed edges for C# (callers, not mentions), cross-cutting concept notes, recipes
from co-change history ("to add an endpoint, touch A, B, C"), a graph view in the tab, and
notes that grow where the agent had to leave the map for the code.

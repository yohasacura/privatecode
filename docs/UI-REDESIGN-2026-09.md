# The window, rebuilt — the design interview, continued alone (2026-09-02)

The owner answered nine questions and then asked for the rest of the interview to be held
without him: every branch of the design walked to the end, the failure paths beside the
happy ones, and a decision written down for each. This is that document. It is the spec the
rebuild is built from, and the thing to argue with when a screen does not match it.

## 0. Decided with the owner

| question | decision |
|---|---|
| what "wow" means | calm professionalism (Linear, Zed, Claude Code desktop) with three deliberate accents: the live generation indicator, animated state transitions, a considered first screen |
| themes | dark and light, following Windows by default, a manual override in Settings |
| fonts | bundled Inter and JetBrains Mono, no network, no dependence on what the machine has |
| density | comfortable: 13–14 px text, 28–32 px rows, air between blocks; a compact setting can come later |
| layout | three columns, rebuilt: a real sidebar (workspace, sessions by day, settings), the chat at reading width, a tabbed inspector (Files / Changes / History / Terminal); both side panels collapse |
| accent | the warm orange stays; green, red and yellow are for states only |
| the transcript | a timeline: the person's request as a distinct block, the model's work between answers folded into one action group with a summary line, answers as prose; the checks as a compact stage strip |
| motion | purposeful micro-animations, 120–200 ms, honouring `prefers-reduced-motion`; nothing that makes anyone wait |
| approach | Tailwind and Radix/shadcn-style components (the owner's choice over a hand-rolled token system) |
| priority | everything, each element in full detail |

Everything below follows from these ten.

---

## 1. Foundations

**Q: Tailwind and Radix on Preact — does that even work, and what breaks?**
A: Tailwind is a build step and knows nothing about the framework; it works. Radix is a
React library. Preact runs React libraries through `preact/compat`, and Radix mostly runs
on it, but "mostly" is the problem: the primitives lean on `React.Children`, refs on
fragments and layout-effect ordering, and the failures are silent — a menu that stops
closing on outside click, a dialog that traps focus once and not twice. The owner asked for
"Radix/shadcn-**like**" components, and the word carries the decision:

- **Tailwind v4** for all styling, with the design tokens declared in one `@theme` block
  (colours for both themes as CSS variables, the type and spacing scales, radii, shadows,
  durations). No utility classes for one-off colours: a raw hex anywhere but the token file
  fails a test (§10).
- **Our own primitives, modelled on Radix's API and behaviour**: Dialog, AlertDialog,
  Popover, DropdownMenu, Tooltip, Tabs, ToggleGroup, Switch, Toast, ScrollArea (CSS only).
  Each is one file under `app/src/ui/`, written for Preact, with the keyboard and ARIA
  contract Radix documents — that contract is what makes them "shadcn-like", not the
  package name. Each ships with a DOM test of its contract.
- **`preact/compat` aliased in Vite anyway**, so a Radix package can be adopted for one
  primitive if ours proves not worth writing (the dropdown menu with typeahead is the
  candidate). Fallback path: if a compat'd Radix primitive misbehaves in the bridge, it is
  replaced by ours; the API is the same by construction.
- **Icons: `lucide-preact`** (native, no compat), tree-shaken, 16 px at stroke 1.75 for UI
  and 14 px in dense rows. The brand mark and the six tool-kind glyphs stay ours.
- **Migrating to React** was considered and rejected: 630 `class=` attributes, every test,
  and nothing gained that the above does not give.

Failure paths: a primitive's test fails → the primitive does not ship. Tailwind's build
fails → Vite fails loudly; there is no runtime CSS-in-JS to degrade. A class name typo is
invisible to Tailwind (it emits nothing) — the same silent failure the old design-system
test caught for tokens — so §10 adds a lint that every `class` string resolves.

**Q: Where do the fonts come from, and what happens when they do not?**
A: `Inter` (variable, latin + cyrillic, ~110 KB woff2) and `JetBrains Mono` (variable,
~90 KB) bundled under `app/src/assets/fonts/`, declared with `font-display: swap` and
`size-adjust`/`ascent-override` on the fallback faces so a swap does not reflow. Fallback
stacks: `Inter, 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif` and
`'JetBrains Mono', 'Cascadia Code', Consolas, monospace`. If a font file is missing from a
build (a packaging mistake), the window renders in the fallback and nothing else changes;
the DOM test that loads the stylesheet asserts both `@font-face` rules resolve to bundled
URLs, so the mistake is caught before a release. Cyrillic is a requirement: the owner's
prompts are Russian.

**Q: How does theming work, in detail?**
A: Three states, as the platform has them: `system` (default), `dark`, `light`. The root
element carries `data-theme="dark|light"` resolved from `prefers-color-scheme` when the
setting is `system`, updated live through `matchMedia('(prefers-color-scheme: dark)')`'s
change event. Tokens are defined once per theme on `[data-theme=…]`; every colour in the
app is a token. The setting persists in `ui.json` next to the server URL.

Failure paths: `ui.json` unreadable or the value not one of the three → `system`, and the
Settings row shows "system" without complaint. `matchMedia` absent (a test environment)
→ dark. The Tauri window's own `theme` in `tauri.conf.json` is set to follow the system too,
so the frame shadow and the title-bar background agree with the page from the first paint;
before the stylesheet loads the body background is painted by the token default (dark),
which is a 50 ms flash at most and only on a light system — accepted, documented.

Contrast: every text token is checked against its background at AA (4.5:1 body, 3:1 for
12 px labels on hover surfaces) in both themes by a unit test over the token file — the
light theme is where hand-tuned dark palettes go wrong, and it is tested rather than eyed.

**Q: Motion tokens?**
A: `--duration-fast: 120ms`, `--duration-normal: 180ms`, `--duration-slow: 260ms`; one
easing for entrances (`cubic-bezier(.2,.8,.2,1)`), one for exits (ease-in). Used for:
rows appearing (opacity + 4 px rise), groups expanding (height via `grid-template-rows`
0fr→1fr so nothing is measured), stage chips changing state (colour + check-mark draw),
the composer's live sweep, menus and popovers (scale .96→1 + fade), toasts. Under
`prefers-reduced-motion: reduce` every duration becomes 0 and the sweep becomes a static
tinted edge. Nothing animates on scroll; nothing loops except the sweep and the pulse dot
while generating.

**Q: The scale?**
A: Space on a 4 px grid: 4, 8, 12, 16, 20, 24, 32. Type: 11 (badges only), 12 (meta),
12.5 is gone, 13 (UI), 14 (prose and input), 15/17/20 (headings). Line-height 1.5 for prose,
1.35 for UI rows. Radii: 6 (controls), 8 (cards, composer), 12 (modals). Rows: 28 px in
lists and trees, 32 px in the sidebar and tabs. Reading width 860 px stays.

---

## 2. The shell and the window

**Q: What is in the title bar, and what does it do without a window?**
A: Left: the brand mark and name; the workspace switcher as a button (name, "+2" for extra
folders, a chevron; opens the switcher popover). Centre: the session title (editable on
double-click, Enter saves, Esc cancels, empty reverts to untitled). Right: connection dot
with a tooltip that says which process and since when; the two panel toggles; the window
controls. The whole bar is the drag region; double-click on it toggles maximize.

Failure paths: no Tauri (the browser dev bridge) → no window controls, right padding
restored. The Tauri API call fails (an old build, a permission missing) → the button does
nothing and logs once; the app does not crash. The maximized state cannot be read → the
maximize glyph is shown (the safe default). The connection dot is `closed` → the tooltip
says so and the composer is locked with the same sentence ("the agent process is not
running — restart from the welcome screen"), and a Restart button appears in the dot's
popover.

**Q: How do the columns behave?**
A: Sidebar 240–320 px (draggable), inspector 300–520 px, chat takes the rest with a
minimum of 480 px. Below 1100 px the inspector auto-collapses; below 860 px the sidebar
does too; the toggles say why they are disabled ("the window is too narrow"), as today. The
splitters are 6 px hit areas drawn as 1 px lines, with a hover highlight. Widths persist in
`ui.json`; a corrupt value → defaults. Collapsing is animated (width via the slow duration);
under reduced motion it is instant.

**Q: The status bar?**
A: 26 px, 12 px text, three groups. Left: server dot + model name (tooltip: the file name,
the context length, the URL); the mode. Centre: context usage as a 64 px bar with the
number (`18.4k / 196.6k`), amber past 70 %, red past 90 %, with a tooltip explaining
compaction. Right: the compiler check availability ("C# check: ready / not in this build"),
the update badge when one is waiting, "private" with the tooltip "one connection, to the
server you configured". A five-second flash for compaction and slot saves, as today.

Failure paths: model unknown (the probe failed) → "model: unknown" in the dim colour, with
the tooltip carrying the probe error; context length unknown → the bar hides and the number
alone shows; offline → the dot goes red and the model name is struck through, not removed
(the person should still see what it was).

---

## 3. First run and the welcome screen

**Q: What does the first screen do, exactly?**
A: A centred card, 480 px: the mark, the name, one sentence. Then the two things the app
needs: a project folder (a Browse button and the recent list as rows with the folder's
name, its path dimmed, its last-opened time, and a small "×" to forget one) and the model
server (URL field with the default; a live status under it — probing… / reachable, model
`X`, context `N` / unreachable, with the reason). The Open button is enabled only when both
are known. Below, quietly: the version, and "Check for updates".

Failure paths, each with its own sentence and its own next step:

- no saved config → defaults, nothing said.
- `ui.json` corrupt → defaults, one line: "settings could not be read and were reset".
- a recent folder no longer exists → its row is dimmed with "not found" and a "forget"
  action; opening it is refused with the same words.
- folder exists but is unreadable → "cannot read this folder (access denied)".
- server URL malformed → the field turns red on blur with "not a URL".
- server unreachable → the status line says "nothing is listening at :8080" or the socket
  error in plain words, with a "Retry" and a link to the README section on starting
  llama.cpp; Open stays disabled.
- server reachable but not llama.cpp (a web server answering 200 with HTML) → "this is not a
  llama.cpp server" (the probe checks `/props` shape).
- `/props` reachable but no model loaded → "the server has no model loaded".
- agent process failed to start → the existing AgentDown screen, restyled: the reason, the
  last lines it printed in a mono box, Restart, and the update strip if an update exists.

Open succeeds → the window fills in with a 180 ms fade; the sidebar, chat and inspector
mount together, never one after another.

---

## 4. The sidebar

**Q: What is in it, top to bottom?**
A: The workspace row (name, folder count, a chevron → the switcher popover with recent
workspaces and "Open another…"). A "New session" button, secondary style, with `Ctrl+N`.
The session list grouped by day ("Today", "Yesterday", weekday names for the week, then
dates), each row: title (or the first prompt's first line, or "untitled"), the mode as a
small tinted chip, elapsed time, and a status glyph — running (pulse), waiting on you
(orange dot), done, errored. Right-click or the "…" on hover: rename, export as Markdown,
delete (confirm inline: the row turns into "Delete this session? Delete / Keep"). At the
bottom: Settings, and a "Delete all sessions" that lives inside Settings → Data, not here.

Search: a filter field appears with `Ctrl+Shift+F` or the magnifier, filtering by title and
first prompt; "no sessions match" as the empty state.

Failure paths: the session store cannot be listed → the list shows the error and a Retry,
the rest of the window works; a session's workspace is gone → its row shows "folder moved
or deleted" and opening it offers to pick the folder again; a session fails to load →
error toast with the file name, the row stays; 1,000 sessions → the list is windowed
(same technique as the transcript) and groups collapse by default beyond the first week.

---

## 5. The transcript

**Q: What are the row types, and how does an action group form?**
A: Rows: the person's request; a harness note (dim, bracketed, never mistaken for the
person); the model's answer (prose); an action group; an approval or question card; a
check-stage strip; a reasoning aside; a compaction record; an error notice.

An action group is every tool call between two pieces of prose (or between a request and
prose). While it runs, the group header is live: "Reading `Snapshot.cs`…" with the pulse,
and rows appear beneath it as they happen, so nothing is hidden from a person who wants to
watch. When the group ends, the header becomes the summary — "Read 4 files · edited 2 ·
build passed · 41 s" — and the rows collapse unless one of them failed, in which case the
group stays open with the failed row highlighted. Click the header to toggle; `Alt+click`
to expand every group in the turn. Inside, each row: kind glyph, verb, target (mono), a
right-aligned meta (`+12 −3` for a diff, `exit 0 · 5.7 s` for a command, `12 KB` for a
read), and a chevron for rows that have a body.

Failure paths in a group: a tool call refused by permissions → the row says "refused" in
the yellow tone and the reason from the engine; a failed call → red glyph, the error's first
line inline, body open; a call still writing when the turn was interrupted → "interrupted
while writing" and no body; output larger than the display cap → the first 160 lines with
"show N more" and "copy all"; a screenshot result → the image, bounded, click to open in a
tab; the diff of a file that has since been deleted → the diff still renders (it is a
record), the "open file" affordance disappears.

**Q: The check-stage strip?**
A: One line under the answer, chips left to right in the order they run: contract →
premises → build (or "C# check") → audit → review. Each chip: an icon, the name, and the
state — pending (dim), running (pulse and elapsed seconds), passed (green check), refused or
handed back (orange, with the count: "audit: 1 criterion unmet"), failed (red), skipped
("manual" when the checks are off, "no command" for the build). Hover for the detail the
stage reported. The strip animates chip by chip as stages complete.

Failure paths: a stage times out → "timed out" in red with the seconds; the verify command
cannot start → "could not run: <reason>" with a link to Settings; checks off → the strip is
one dim chip "checks off — /check, /review" so the absence is visible; a fixer round →
the build chip shows "attempt 2" and the transcript below it carries the fixer's work as its
own group.

**Q: The person's request and the answer?**
A: The request: a block with a 3 px accent bar on the left, the text at 14 px, attachments
as chips beneath it, a hover "edit and resend" (which puts the text back in the composer)
and "copy". The answer: prose at 14 px / 1.6, Markdown with code blocks that have a
language label and a copy button, tables that scroll horizontally in their own container,
file references as chips that open the file in a tab. While streaming, a caret blinks at the
end of the last line and the block has no bottom margin so the composer does not jump.

Failure paths: the stream drops mid-generation → the partial text stays, followed by one
red line "the connection dropped mid-generation" and a "Continue" button that sends the
continue nudge; the server answers 400 (a grammar the server refused, an oversized prompt)
→ the notice says which and what the app will do (retry without the constraint, compact);
context overflow → the compaction record explains what was folded, with a "show what was
summarised" toggle; the turn is stopped by Esc → "stopped" in yellow with "resume".

**Q: Cards — approvals and questions?**
A: The approval card keeps the accent edge. Header: what and where ("Edit
`Snapshot.cs`", "Run `dotnet build …`"), the tool as a tag, "waiting for you" with elapsed
time. Body: the diff or the command, bounded, scrollable. Actions: Allow (`Enter`), Always…
(a popover: for this session / this workspace / everywhere, each with a sentence on what it
writes where), Deny with an optional reason field, and for commands "edit and run" that
puts the command in the terminal input. Question cards: options as buttons, multi-select as
toggles, a free-text field when the question allows it; `1`–`9` pick options.

Failure paths: the turn is aborted while a card waits → the card collapses to "no longer
needed" and its buttons disappear; two cards at once cannot happen (one slot) but a stale
one from a restored session shows "answered in a previous run" and is inert; a card that
sat unanswered for ten minutes gets a dim "still waiting" line, nothing louder.

**Q: Empty and edge states?**
A: A new session shows the mark, one line, and three example prompts as chips that fill
the composer ("explain how this project starts", "find where X is handled", "add a test
for Y" — the last two seeded from the project map when it exists). A restored session
shows "restored — N turns, last active …" as the first harness note. A session with only
harness notes and no person text (a run that was started from a command) shows the command
as the request. Jump-to-latest appears when scrolled up more than one screen while new rows
arrive; it says how many rows are unseen.

---

## 6. The composer

**Q: Anatomy and states?**
A: A card: the input (auto-growing to 40 % of the window, then scrolling, `Ctrl+E` to
expand into a modal editor), the attachment row above the bar when there are attachments,
and the bar: modes as a segmented control (Normal / Plan / Auto-edit / Autopilot), the
Checks switch, the Run-unattended switch, then the status text (right-aligned, one line,
ellipsised from the left so the newest words show), the attach button, and Send.

States: idle (placeholder "Ask for a change, a review, or an explanation", `↵ send`);
typing (Send lights up); sending (Send becomes Stop, the sweep starts, the status says
"contract…", "step 3 · reading Snapshot.cs", "waiting on you"); queued (text typed while a
turn runs shows "queued — sent when this turn ends" with an edit affordance); locked
(update running, agent down: the input is read-only with the reason in place of the
placeholder); blocked by an unattended run ("a run is in progress — Stop it to send");
autopilot confirm (switching to Autopilot asks once, inline, red).

Failure paths: an attached file is missing or unreadable at send time → the chip turns red
with "not found" and Send is refused until it is removed; a drop of a folder attaches the
folder as a mount suggestion, not as text; the server is offline → Send disabled with "the
model server is offline" and a Retry in the status bar; a send that fails at the transport
→ the text stays, a toast says why; a slash command that does not exist → the picker shows
"no such command", Enter does nothing; `@` with no matching files → "no files match".

**Q: The mode control and the switches?**
A: The segmented control has four segments, keyboard-navigable (arrows), each with a
tooltip in one sentence. Plan tints blue, Auto-edit amber, Autopilot red; Normal is
neutral. The Checks switch shows "on / off" and its tooltip lists the three gates. Run
unattended is a switch with a small popover for the budget (turns, minutes) — the settings
that today live in a modal.

Failure paths: a mode change refused by the host (a run in progress) → the segment snaps
back with a tooltip saying why; the checks switch flipped mid-turn → applies from the next
turn and the tooltip says so.

---

## 7. The inspector

**Q: Files?**
A: A tree, 28 px rows, folder icons that open, file icons by kind, git marks as a coloured
letter on the right (M/A/D/U/conflict), staged rows tinted. Mount headers for a
multi-folder workspace with a read-only badge and a "…" for remove and add. Filter by
name with `Ctrl+P` inside the panel. Click opens the file in a tab; double-click focuses
the tab; drag a file onto the composer to attach.

Failure paths: a folder is unreadable → the row shows a lock glyph and "access denied"; a
mount's root disappears → the header turns red with "folder missing — remove or re-add";
a tree of 50,000 files → lazy expansion, only expanded folders are read, and the filter
searches the index rather than the DOM; git unavailable (not a repo, git missing) → no
marks, the tooltip on the header says "not a git repository".

**Q: Changes?**
A: The files this session changed, each with `+n −m`, the checkpoint that covers it, a
reviewed toggle, and "Put back" with a confirmation inline. The header: "3 files changed ·
+41 −7", "mark all reviewed". Click opens the diff tab.

Failure paths: the diff cannot be computed (the file is binary, or gone) → the row says so
and offers "show current file"; a put-back fails (file locked by another program) → the row
shows the OS error and keeps the button; the checkpoint store is corrupt → the panel says
"changes cannot be tracked for this session" and the transcript still works.

**Q: History?**
A: Checkpoints as a list (time, what happened, files touched, Restore with an inline
confirmation that names what it will overwrite), and the work log beneath it (per turn:
steps, what was done, the checks' verdicts). Restore succeeds → a toast and a harness note
in the transcript.

Failure paths: restore fails halfway → the panel shows what was restored and what was not,
with the paths; the work log file is missing → "no work log yet"; a checkpoint's files no
longer exist → "restore will recreate 2 deleted files" in the confirmation.

**Q: Terminal?**
A: The commands the model ran and the ones the person ran, newest at the bottom, each with
origin (agent / you), the command, exit code and duration, output collapsed past 40 lines.
A running job shows live output and a Stop. The input at the bottom runs in the primary
folder, never goes to the model, and `↑` recalls history.

Failure paths: a command refused by permissions → the row shows "refused: <rule>"; a job
that does not exit → after the timeout the row says "killed after N s"; output that is not
UTF-8 → shown decoded with replacement characters and a note; the shell missing → the input
is disabled with "PowerShell not found".

**Q: File and diff tabs?**
A: Files and diffs open as tabs beside the chat (the editor-tab strip that exists), with
the path, a close button, and a "reveal in tree". The file view: line numbers, syntax
colours for the languages tree-sitter knows, wrap toggle, a search field. The diff view:
unified by default with a split toggle, per-hunk collapse, "open the file at this line".

Failure paths: file not found → the tab shows "this file no longer exists" with the last
seen content if a checkpoint has it; binary → "binary file, N KB" and a hex preview of the
first 256 bytes; larger than 2 MB → the first 2 MB with a "load all" that warns;
highlighting fails → plain text, no error.

---

## 8. Overlays

**Q: Settings?**
A: A dialog with a left tab list (Server, Appearance, Permissions, Skills, MCP, Data,
About) and a content pane. Appearance: theme (system / dark / light), density (comfortable
now, compact later), reduced motion (follow system / on / off), code font ligatures.
Server: URL, live probe status, "Apply — reopens the workspace" with the sentence saying
why. Permissions: the three layers with what each currently allows and a Revoke per rule.
Skills and MCP: the lists with their states and errors verbatim. Data: where things live
(paths, copyable), and the erase with a typed confirmation. About: version, update check,
licences.

Failure paths: a settings write fails → the dialog shows the error and keeps the values;
the MCP server list cannot be read → the tab shows the parse error with the file path;
erase partially fails → what was and was not erased is listed.

**Q: The palette?**
A: `Ctrl+K`: a search over commands, sessions, files (from the index) and settings, grouped,
with the shortcut shown on the right. Commands that cannot run now are listed disabled with
the reason in their subtitle rather than hidden — a hidden command is one nobody learns.

**Q: Toasts and strips?**
A: Toasts for outcomes that are not part of the transcript (copied, exported, restored,
settings saved, an error that has nowhere else to go), bottom-right, four seconds, stack of
three, dismissible, never for anything the transcript already says. The update strip keeps
its states (available / downloading with bytes / verifying / unpacking / installing /
restarting / error with retry) and moves above the composer as a card rather than a full-
width band. The "updated to X from Y" note is a toast.

---

## 9. Accessibility and keyboard

Every interactive element is a real button or input with a name. Focus rings are visible
(2 px accent outline, offset 2) and only on keyboard focus (`:focus-visible`). Dialogs trap
focus and return it; menus support arrows, Home/End, typeahead, Esc; tabs are a `tablist`
with arrow navigation; the tree is a `tree` with arrow navigation and `*` to expand all
siblings. Contrast is tested (§1). Reduced motion is honoured (§1). A `?` overlay lists
every shortcut. Screen-reader text for the stage strip reads the state, not the icon.

---

## 10. Stability: what is tested, and what is measured

- **Primitives**: each has a DOM test of its contract (open/close, focus trap and return,
  keyboard navigation, outside click, Escape, `aria-*` attributes).
- **Themes**: a unit test over the token file checks every text/background pair for AA in
  both themes; a DOM test flips `data-theme` and asserts computed colours change.
- **Tokens and classes**: a test greps every `.tsx` for `class="…"` strings and asserts
  every utility resolves against Tailwind's generated CSS (a typo emits nothing and is
  otherwise invisible); another asserts no raw hex colour outside the token file.
- **Fonts**: the two `@font-face` rules resolve to bundled files.
- **States**: the DOM tests that exist (approvals, composer history, commands, tree, update
  strip) are kept and extended for the new states named in §3–§8; the reducer in
  `state.ts` is untouched, which is what keeps the protocol and the behaviour stable while
  the rendering changes.
- **The bridge**: `spike/ui-dev-bridge.mts` grows a `--scenario` flag (happy path, tool
  failure, approval, dropped stream, compaction, checks off) and a screenshot script that
  captures each screen in both themes at 1440×900 and 1000×625 into `docs/ui/` — the
  reviewable evidence for every phase below.
- **Budget**: the CSS bundle under 80 KB, the JS bundle not more than 60 KB heavier than
  today; first paint of a restored 500-row session under 200 ms (windowing stays).

---

## 11. The plan, in phases

Each phase ends with the tests green, the bridge screenshots taken, and a commit; the next
phase starts from that. A phase that cannot end that way is reverted, not carried.

| phase | what | done when |
|---|---|---|
| 0 | Tailwind v4 in the build; the token file for both themes; fonts bundled; theme resolution and the Appearance setting; the compat alias; `lucide-preact`; the tests of §10 that can exist before any screen changes | both themes render the CURRENT screens through tokens; no raw hex; all tests green |
| 1 | Primitives: Button, IconButton, Input, Segmented, Switch, Chip, Tooltip, Popover, DropdownMenu, Dialog, AlertDialog, Tabs, Toast | each with its DOM test |
| 2 | Shell: title bar with switcher and session title, columns, splitters, status bar | screenshots in both themes at both sizes |
| 3 | Welcome and AgentDown, every failure state of §3 driven by the bridge | screenshots of each state |
| 4 | Sidebar of §4, with day groups, search, inline confirmations | screenshots; the sessions DOM tests extended |
| 5 | Transcript of §5: action groups, rows, cards, stage strip, streaming, error notices | the bridge's six scenarios screenshot in both themes |
| 6 | Composer of §6 | the composer DOM tests extended for the states |
| 7 | Inspector of §7 and the file/diff tabs | screenshots; tree and changes tests extended |
| 8 | Overlays of §8: Settings, palette, toasts, the update card | screenshots |
| 9 | The old stylesheet deleted; the bundle budget checked; the release | a build, and the owner's eyes |

Order is by what the owner sees first and longest: foundations, then the frame, then the
first screen, then the place the work happens.

---

## 12. Risks, named

- **Radix under compat.** Mitigated by not depending on it: our primitives first, Radix
  only where ours is not worth writing, replaceable by construction.
- **Tailwind's silent typos.** Mitigated by the class-resolution test.
- **Light theme done by eye.** Mitigated by the contrast test and by screenshots of every
  screen in both themes before a phase ends.
- **Behaviour regressions while restyling.** Mitigated by leaving `state.ts` and the
  protocol untouched, and by the DOM tests that already pin the behaviour.
- **Scope.** Ten sections; each phase is shippable on its own, and the old stylesheet is
  deleted last, so a stop after phase 5 still leaves a coherent window.

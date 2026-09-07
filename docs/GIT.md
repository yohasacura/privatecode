# Git in the window

Everything Visual Studio's Git tooling does, done here through the same three surfaces:
the **Git tab** (Visual Studio's *Git Changes* window), the **Git Repository** tab
(its *Git Repository* window) and the **branch chip** in the status bar. All of it runs the
machine's own `git` (Git for Windows) with fixed arguments; the window keeps no state of
its own, so whatever it shows is what `git status`, `git log` and `git for-each-ref` say.

## Where things are

| Surface | Opens with | Holds |
| --- | --- | --- |
| Git tab | Inspector → **Git**, or the branch chip in the status bar | Branch picker · Fetch / Pull / Push / Sync · commit box · Unmerged Changes · Staged Changes · Changes · Stashes |
| Git Repository | Git tab → *outgoing / incoming* link, `…` → **Open Git Repository**, or **Manage branches** in the picker | Branches / Remotes / Tags · the graph with Incoming, Outgoing and Local History · the selected commit with its files and diffs |
| Merge editor | A conflicted file's **Open Merge Editor** | Incoming and Current side by side with a checkbox per block, the Result below, **Accept Merge** |
| Compare | Branch menu → **Compare with current branch**; two commits → **Compare Commits** | Files that differ, each one's diff |
| File history / Blame | A changed file's menu → **View history** / **Blame (annotate)** | The commits touching the file with each diff; who last touched every line |
| Diff face of a file | Any file tab → *diff* | **Stage hunk** and **Undo** per hunk (line staging) |
| Settings → Git | The `…` menu → **Git Settings…**, or Settings | User name / email (global and per repository), prune on fetch, rebase on pull, default branch, remotes, `.gitignore` |

## Parity with Visual Studio

| Visual Studio | Here | Notes |
| --- | --- | --- |
| Git Changes: Changes / Staged Changes / Unmerged Changes | Same three lists | A file staged and edited again appears in both, as in VS |
| `+` / `−` per file and per section | Same, on hover | |
| Commit All · Commit Staged · … and Push · … and Sync | Primary button plus its dropdown | The primary is *Commit All* until something is staged, then *Commit Staged (n)*; Ctrl+Enter commits |
| Amend | Amend switch | Refused once the last commit is on the remote |
| Stash All · Stash All and Keep Staged | Stash… in the commit dropdown | Message, keep staged, include untracked |
| Stashes: View, Apply, Apply as unstaged, Pop, Pop as unstaged, Drop | Same menu | |
| Undo Changes · Ignore this file / extension | Row menu | Undo asks first; it is the one irreversible action |
| Fetch · Pull · Push · Sync, with the ellipsis menu | Same four buttons and `…` | Fetch prunes; Pull with rebase, Push with tags, Force push (with lease) are in the menu |
| *n outgoing / m incoming* link | Same link, opens the repository tab | |
| Pull then Push / Pull / Force push on a rejected push | Same question | Force is `--force-with-lease`, never plain `--force` |
| Publish branch (no upstream) | Same question, with the remote to publish to | |
| Branch picker in the status bar and the window | Chip in the status bar; picker on the Git tab | Type to filter; Enter checks out the first match; a remote branch becomes a tracking local one |
| Create a new branch: name, based on, check out, track | Same dialog | |
| Git Repository: Branches / Tags pane | Local · Remotes · Tags, with a filter | Single click views a branch's history; double click checks it out |
| Branch menu: Checkout, New branch, Merge into current, Rebase current onto, Compare, Push, Rename, Delete | Same | Delete of an unmerged branch is refused first, then offered as *Delete anyway* |
| Remote branch: Checkout tip commit, Delete from remote | Same | |
| Multi-branch graph, first-parent only, label toggles, outgoing/incoming only | Toolbar buttons | The lanes are computed from parents, one colour per lane |
| Search commits | Search box | Message text, or a sha prefix |
| Commit menu: Checkout (detach), New Branch, Create Tag, Cherry-Pick, Revert, Reset (soft / mixed / hard), Compare Commits, Squash Commits, Copy ID | Same | Squash takes the newest run of commits only, like VS; Revert of a merge commit is refused (needs `-m`) |
| Commit details: message, author, files, side-by-side diff, Edit (amend message), Open in New Tab | Same, below the graph | |
| Merge editor: checkboxes per side, Take Incoming / Take Current / Take Both, Result, Accept Merge, previous / next | Same | The result can be edited by hand; markers left in it keep Accept disabled |
| Unmerged Changes: Keep Current (Local), Take Incoming | Row menu | Plus *Mark as resolved* for a file fixed elsewhere |
| Merge / rebase in progress: Continue, Abort | Banner on the Git tab | Skip for a rebase, cherry-pick or revert |
| Line staging (Stage Change) | Stage hunk on the diff face | Undo hunk too |
| Blame (Annotate) · View History | Row menu | |
| Git Settings: name, email, prune, rebase on pull, remotes, gitignore | Settings → Git | Global and repository scopes are both shown; a repository value overrides |
| Create Git Repository | Git tab, for a folder under no version control | `git init`; the default branch comes from `init.defaultBranch` |
| Multi-repo | Repository selector at the top of the Git tab when the workspace holds several | Nested repositories and a repository above a mounted subfolder are found the way the tree finds them |
| Clone, GitHub / Azure DevOps sign-in, pull requests, work items, Copilot review, author images | Not here | The app talks to no service; clone from a terminal, then open the folder |

## How it is wired

- `core/src/host/git-repo.ts` — every operation, one fixed argv each, returning a structure
  rather than stderr: `conflict`, `behindRemote`, `noUpstream` are decided there.
- `core/src/host/git-rpc.ts` — the `git.*` wire methods. A request names its repository by
  the absolute toplevel `git.status` reported, and the host honours only a root that is a
  repository this workspace touches; paths are repository-relative and refused when they
  climb out or land in a folder the workspace does not hold.
- `core/src/host/repos.ts` — discovery now reads porcelain v2, so one `git status` also
  yields the upstream, ahead/behind, detached and unborn states, the stash count and the
  conflict list.
- `app/src/panels/git-tab.tsx`, `git-repository.tsx`, `merge-editor.tsx`,
  `git-extra-views.tsx`, `git-settings.tsx`, `git-dialogs.tsx` — the surfaces;
  `app/src/lib/git-graph.ts`, `conflicts.ts`, `hunks.ts` — the pure parts, each with a test.

Network operations run with `GIT_TERMINAL_PROMPT=0`, so a remote that needs credentials
answers "could not read Username" instead of hanging; Git Credential Manager, which Git for
Windows installs, still opens its own window when it has to.

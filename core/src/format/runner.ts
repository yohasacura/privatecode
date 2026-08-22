import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { ruleFor, type FormatRule } from './config.js'
import { runPowershell } from '../powershell.js'
import type { Workspace } from '../workspace.js'

/**
 * Runs the project's formatter on a file the agent just wrote.
 *
 * It lives INSIDE the write path rather than in an after-tool hook, and that placement is
 * the entire reason it exists separately. `edit_file` returns a diff, and the model's next
 * edit anchors a SEARCH block on the text in that diff. If formatting happens after the
 * tool has already built its result, the diff shows text that is no longer on disk and the
 * next anchor misses — the agent then re-reads, retries, and burns a turn discovering that
 * its own output was rewritten underneath it. Formatting here means the diff is rendered
 * against the post-format file, so what the model was shown is what it can anchor to.
 */

/** A formatter is a fast, local, deterministic tool; anything slower than this is either
 * wedged or the wrong tool for an inline step. */
const TIMEOUT_MS = 20_000

/** After this many failures the runner stops trying for the rest of the session. A broken
 * formatter command must cost a few seconds once, not on every single edit. */
const MAX_FAILURES = 3

export interface FormatOutcome {
  /** A rule matched and the command was executed. */
  ran: boolean
  /** The file's bytes differ from what the tool wrote. */
  changed: boolean
  /** One line for the model, when there is something it must know. */
  note?: string
}

export interface FormatRunner {
  /** `relativePath` is workspace-relative; the returned text is the file's content AFTER
   * formatting, or null when nothing ran and the caller should keep what it wrote. */
  run(relativePath: string, signal?: AbortSignal): Promise<FormatOutcome & { text: string | null }>
}

/**
 * `$FILE` as a PowerShell ASSIGNMENT, instead of text spliced into the command line.
 *
 * The rule's command comes from a settings file the model cannot write, but the path
 * substituted into it is the model's own `args.path`, and the result was handed to
 * `powershell.exe -Command`. `;` is a statement separator there and passes every jail
 * check — `assertSegmentAllowed` rejects `:` and eight secret-ish names, not punctuation —
 * so `write_file({ path: 'src/a;calc.exe;b.ts' })` made the NEXT edit run `calc.exe`. The
 * formatter is deliberately not permission-gated (it runs inside the write tool, after the
 * gate has already decided), so that was ungated execution with no approval card.
 *
 * A variable is what fixes it rather than quoting the substitution: PowerShell expands a
 * variable in argument position WITHOUT re-parsing its value, so no punctuation in a
 * filename can become syntax. It also keeps working for the two ways a rule is actually
 * written — `--write $FILE` and `--write "$FILE"` — because both expand the same value as
 * one argument. The spellings a variable CANNOT absorb are handled either side of this:
 * `'$FILE'` and `"$FILE"` are normalised by `normaliseFilePlaceholder` below, and
 * `$FILE.bak` / `$FILEX` are refused when the rule is loaded (`format/config.ts`).
 *
 * The benign half of the same bug was far more common: a space or an `&` in a filename
 * broke the command, and `MAX_FAILURES` then switched formatting off for the session.
 */
function assignFile(relativePath: string): string {
  return `$FILE = '${relativePath.replace(/'/g, "''")}'; `
}

/**
 * The rule's own `$FILE` spellings, normalised to the one PowerShell will expand.
 *
 * Binding `$FILE` as a variable instead of substituting text is what closed the injection,
 * and it quietly changed what a rule may SAY. Measured on this machine, with `$FILE` set to
 * `src/a b.ts`:
 *
 *   $FILE      -> src/a b.ts      "$FILE"    -> src/a b.ts
 *   '$FILE'    -> $FILE           $FILE.bak  -> (empty)      $FILEX -> (empty)
 *
 * Under the old `split('$FILE').join(path)` all five worked. A rule written
 * `npx prettier --write '$FILE'` therefore started formatting a file literally named
 * `$FILE`, exiting non-zero on every write, feeding the model a phantom formatter error —
 * and after MAX_FAILURES switching formatting off for the whole session with nothing on
 * screen to say so.
 *
 * Both quoted forms are rewritten to the bare variable, which is correct because the
 * variable already expands as a single argument however the path is spelled — quoting it was
 * only ever a defence against the substitution this no longer does. The forms that CANNOT be
 * rewritten safely (`$FILE.bak`, `$FILEX`) are refused when the rule is loaded, in
 * `format/config.ts`, where the message can name the rule and the file it came from.
 */
function normaliseFilePlaceholder(command: string): string {
  return command.replace(/'\$FILE'|"\$FILE"/g, '$FILE')
}

export function createFormatRunner(rules: FormatRule[], workspace: Workspace): FormatRunner {
  let failures = 0

  return {
    async run(relativePath, signal) {
      if (rules.length === 0) return { ran: false, changed: false, text: null }
      if (failures >= MAX_FAILURES) return { ran: false, changed: false, text: null }
      const rule = ruleFor(rules, relativePath)
      if (!rule) return { ran: false, changed: false, text: null }

      let abs: string
      try {
        abs = workspace.resolve(relativePath)
      } catch {
        return { ran: false, changed: false, text: null }
      }

      const before = await readFile(abs, 'utf8').catch(() => null)

      // The folder the file actually lives in, not the primary one. `workspace.root` is
      // `mounts[0].root`, while a multi-folder workspace addresses files as
      // `<mountName>/rest` — and mounts provably never overlap, so that path never exists
      // under the primary root. Formatting every edit in an attached folder used to exit
      // non-zero, and three of those disabled the formatter for the whole session,
      // primary folder included.
      const mount = workspace.mountFor(abs)
      const cwd = mount?.root ?? workspace.root
      const fileArg = mount === undefined ? relativePath : relative(mount.root, abs)

      const command = `${assignFile(fileArg)}${normaliseFilePlaceholder(rule.command)}`

      try {
        // Through runPowershell so a timeout or an abort takes the whole tree down: a
        // formatter is `powershell.exe -Command <prettier|dotnet format|...>`, and killing
        // the shell alone leaves the formatter itself running on the file being edited.
        const { result } = await runPowershell(command, {
          cwd, timeoutMs: TIMEOUT_MS, signal,
        })
        if (result.exitCode !== 0) {
          // CONSECUTIVE, and a success below clears it. A fixer-linter (`eslint --fix`) exits
          // non-zero whenever it finds something it cannot fix, which is a normal outcome and
          // not a broken command — counted cumulatively, three of those switched formatting
          // off for the whole session. `MAX_FAILURES`'s own comment says the intent is that a
          // BROKEN command costs a few seconds once.
          failures++
          // Named, not swallowed: a formatter that rejects the file usually means the edit
          // produced something that does not parse, which the model must know NOW rather
          // than discovering three steps later.
          const detail = (result.all ?? '').trim().split('\n').slice(0, 3).join(' ')
          const disabled = failures >= MAX_FAILURES
            ? ` It has now failed ${MAX_FAILURES} times in a row and will not be run again ` +
              'this session.'
            : ''
          // The file as it stands NOW, not what the tool wrote. A formatter can rewrite the
          // file and STILL exit non-zero — a fixer-linter with one finding it cannot fix is
          // exactly that — and this path used to return `text: null, changed: false`, so the
          // caller kept its pre-format bytes and rendered a diff of text no longer on disk.
          // That breaks the one property this placement exists for: the model anchors its
          // next SEARCH on this diff.
          const afterFailure = await readFile(abs, 'utf8').catch(() => null)
          return {
            ran: true,
            changed: afterFailure !== null && afterFailure !== before,
            text: afterFailure,
            note: `the formatter (${rule.command}) exited ${result.exitCode ?? '?'}` +
              `${detail ? `: ${detail}` : ''}${disabled}`,
          }
        }
        failures = 0
      } catch (e) {
        failures++
        return {
          ran: true, changed: false, text: null,
          note: `the formatter could not be run: ${(e as Error).message}`,
        }
      }

      const after = await readFile(abs, 'utf8').catch(() => null)
      if (after === null) return { ran: true, changed: false, text: null }
      const changed = after !== before
      return {
        ran: true,
        changed,
        text: after,
        // Only said when it is true and actionable: the diff below it is already the
        // post-format text, so this explains why it may not look like what was asked for.
        ...(changed ? { note: 'the project formatter reformatted this file; the diff below is the result' } : {}),
      }
    },
  }
}

import type { VNode } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { AlertDialog, Dialog } from '../ui/dialog'
import { Button } from '../ui/button'
import { Field, Input, Textarea } from '../ui/input'
import { Select } from '../ui/select'
import { Switch } from '../ui/switch'

/**
 * The questions the Git views ask — each one Visual Studio asks too, with the same
 * answers: Create a new branch (name, based on, check out), Stash (message, keep staged),
 * a push refused because the remote moved on (Pull then Push / Pull / Force), Publish a
 * branch (which remote), Create a tag, Reset (which kind), and a one-field text question
 * for renames, squash messages and remotes. Every dialog runs its own action and closes
 * only when the action succeeded, so a refusal keeps the person's typing.
 */

async function attempt(run: () => Promise<boolean>, setBusy: (b: boolean) => void, onClose: () => void): Promise<void> {
  setBusy(true)
  try {
    if (await run()) onClose()
  } finally {
    setBusy(false)
  }
}

export function NewBranchDialog({ open, onClose, current, locals, remotes, onCreate }: {
  open: boolean
  onClose: () => void
  /** The checked-out branch, the default base. */
  current: string | null
  locals: string[]
  remotes: string[]
  onCreate: (p: { name: string; base: string; checkout: boolean; track: boolean }) => Promise<boolean>
}): VNode | null {
  const [name, setName] = useState('')
  const [base, setBase] = useState(current ?? 'HEAD')
  const [checkout, setCheckout] = useState(true)
  const [track, setTrack] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(''); setBase(current ?? 'HEAD'); setCheckout(true); setTrack(true) } }, [open, current])
  const isRemote = remotes.includes(base)
  const valid = name.trim() !== '' && !/\s|\.\.|[~^:?*\[\\]|^-|\/$|\.lock$|@\{/.test(name.trim())
  const submit = (): void => {
    if (!valid || busy) return
    void attempt(() => onCreate({ name: name.trim(), base, checkout, track: isRemote && track }), setBusy, onClose)
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a new branch"
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!valid} loading={busy} data-action="create-branch">Create</Button>
        </>
      }
    >
      <div class="flex flex-col gap-3" data-dialog="new-branch">
        <Field label="Branch name" {...(name !== '' && !valid ? { error: 'not a valid branch name' } : {})}>
          <Input value={name} placeholder="feature/what-it-does" data-autofocus onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
        </Field>
        <Field label="Based on">
          <Select value={base} onChange={(e) => setBase(e.currentTarget.value)}>
            {!locals.includes(base) && !remotes.includes(base) && <option value={base}>{base}</option>}
            <optgroup label="Local branches">
              {locals.map((b) => <option key={b} value={b}>{b}</option>)}
            </optgroup>
            {remotes.length > 0 && (
              <optgroup label="Remote branches">
                {remotes.map((b) => <option key={b} value={b}>{b}</option>)}
              </optgroup>
            )}
          </Select>
        </Field>
        <Switch size="sm" checked={checkout} onChange={setCheckout} label="Check out the branch" hint="Switch to it as soon as it exists" />
        {isRemote && <Switch size="sm" checked={track} onChange={setTrack} label="Track the remote branch" hint="Pull and push go to the branch this one is based on" />}
      </div>
    </Dialog>
  )
}

export function StashDialog({ open, onClose, hasStaged, onStash }: {
  open: boolean
  onClose: () => void
  hasStaged: boolean
  onStash: (p: { message: string; keepIndex: boolean; includeUntracked: boolean }) => Promise<boolean>
}): VNode | null {
  const [message, setMessage] = useState('')
  const [keepIndex, setKeepIndex] = useState(false)
  const [untracked, setUntracked] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setMessage(''); setKeepIndex(false); setUntracked(true) } }, [open])
  const submit = (): void => { if (!busy) void attempt(() => onStash({ message: message.trim(), keepIndex, includeUntracked: untracked }), setBusy, onClose) }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Stash changes"
      description="Puts every change aside and returns the working tree to the last commit. Apply or pop the stash to bring them back."
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} data-action="stash">Stash</Button>
        </>
      }
    >
      <div class="flex flex-col gap-3" data-dialog="stash">
        <Field label="Message" hint="Optional — what this work was">
          <Input value={message} placeholder="WIP on the login form" data-autofocus onInput={(e) => setMessage(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
        </Field>
        <Switch size="sm" checked={keepIndex} onChange={setKeepIndex} disabled={!hasStaged} label="Keep staged changes" hint="Stash All and Keep Staged: what is staged stays in the working tree" />
        <Switch size="sm" checked={untracked} onChange={setUntracked} label="Include untracked files" hint="New files go into the stash too" />
      </div>
    </Dialog>
  )
}

/** A yes/no with the destructive answer red. */
export function ConfirmDialog({ open, onCancel, onConfirm, title, description, confirmLabel, danger = true }: {
  open: boolean
  onCancel: () => void
  onConfirm: () => Promise<boolean>
  title: string
  description?: string
  confirmLabel: string
  danger?: boolean
}): VNode | null {
  const [busy, setBusy] = useState(false)
  return (
    <AlertDialog
      open={open}
      onCancel={onCancel}
      onConfirm={() => { if (!busy) void attempt(onConfirm, setBusy, onCancel) }}
      title={title}
      {...(description !== undefined ? { description } : {})}
      confirmLabel={confirmLabel}
      danger={danger}
      busy={busy}
    />
  )
}

/** The push was refused: the remote has commits this branch does not. */
export function PushBehindDialog({ open, onClose, onPullThenPush, onPull, onForce }: {
  open: boolean
  onClose: () => void
  onPullThenPush: () => Promise<boolean>
  onPull: () => Promise<boolean>
  onForce: () => Promise<boolean>
}): VNode | null {
  const [busy, setBusy] = useState<'pull-push' | 'pull' | 'force' | null>(null)
  const go = (which: 'pull-push' | 'pull' | 'force', run: () => Promise<boolean>): void => {
    if (busy !== null) return
    setBusy(which)
    void run().then((ok) => { if (ok) onClose() }).finally(() => setBusy(null))
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="The remote has moved on"
      description="Your branch is behind its remote branch, so git will not push it as it is. Pull the remote's commits first, then push yours on top."
      size="sm"
      closeOnOverlay={false}
      footer={
        <>
          <Button onClick={onClose} disabled={busy !== null}>Cancel</Button>
          <Button variant="danger" onClick={() => go('force', onForce)} loading={busy === 'force'} disabled={busy !== null && busy !== 'force'} title="push --force-with-lease: your history replaces the remote's, unless someone else pushed since you last fetched">
            Force push
          </Button>
          <Button onClick={() => go('pull', onPull)} loading={busy === 'pull'} disabled={busy !== null && busy !== 'pull'}>Pull</Button>
          <Button variant="primary" onClick={() => go('pull-push', onPullThenPush)} loading={busy === 'pull-push'} disabled={busy !== null && busy !== 'pull-push'} data-autofocus data-action="pull-then-push">
            Pull then Push
          </Button>
        </>
      }
    >
      <div class="text-[12.5px] text-dim" data-dialog="push-behind">
        <b>Pull then Push</b> is the safe answer. <b>Pull</b> alone lets you look at what came in before pushing. Force push rewrites the remote branch and is for a branch only you work on.
      </div>
    </Dialog>
  )
}

/** A branch with no upstream: pick the remote to publish it to. */
export function PublishDialog({ open, onClose, branch, remotes, onPublish }: {
  open: boolean
  onClose: () => void
  branch: string
  remotes: string[]
  onPublish: (remote: string) => Promise<boolean>
}): VNode | null {
  const [remote, setRemote] = useState(remotes[0] ?? 'origin')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setRemote(remotes[0] ?? 'origin') }, [open, remotes])
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Publish ${branch}`}
      description="This branch has no remote branch yet. Publishing pushes it and sets the remote branch as its upstream, so later pushes and pulls know where to go."
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={remotes.length === 0} data-autofocus data-action="publish" onClick={() => { if (!busy) void attempt(() => onPublish(remote), setBusy, onClose) }}>
            Publish branch
          </Button>
        </>
      }
    >
      <div data-dialog="publish">
        {remotes.length === 0
          ? <div class="text-[12.5px] text-red">No remote is configured. Add one under Git settings → Remotes first.</div>
          : (
            <Field label="Remote">
              <Select value={remote} onChange={(e) => setRemote(e.currentTarget.value)}>
                {remotes.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
            )}
      </div>
    </Dialog>
  )
}

export function TagDialog({ open, onClose, at, onCreate }: {
  open: boolean
  onClose: () => void
  at: { short: string; subject: string }
  onCreate: (name: string, message: string) => Promise<boolean>
}): VNode | null {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(''); setMessage('') } }, [open])
  const valid = name.trim() !== '' && !/\s|\.\.|[~^:?*\[\\]/.test(name.trim())
  const submit = (): void => { if (valid && !busy) void attempt(() => onCreate(name.trim(), message.trim()), setBusy, onClose) }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a tag"
      description={`On ${at.short} — ${at.subject}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!valid} loading={busy} data-action="create-tag">Create tag</Button>
        </>
      }
    >
      <div class="flex flex-col gap-3" data-dialog="tag">
        <Field label="Tag name">
          <Input value={name} placeholder="v1.2.0" data-autofocus onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
        </Field>
        <Field label="Message" hint="Optional. With a message the tag is annotated — it records who made it and when.">
          <Textarea rows={2} value={message} onInput={(e) => setMessage(e.currentTarget.value)} />
        </Field>
      </div>
    </Dialog>
  )
}

export function ResetDialog({ open, onClose, target, onReset }: {
  open: boolean
  onClose: () => void
  target: { short: string; subject: string }
  onReset: (mode: 'soft' | 'mixed' | 'hard') => Promise<boolean>
}): VNode | null {
  const [mode, setMode] = useState<'soft' | 'mixed' | 'hard'>('mixed')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setMode('mixed') }, [open])
  const rows: Array<{ value: 'soft' | 'mixed' | 'hard'; label: string; hint: string }> = [
    { value: 'soft', label: 'Keep changes staged (--soft)', hint: 'The commits after this one are undone; their changes stay staged.' },
    { value: 'mixed', label: 'Keep changes (--mixed)', hint: 'The commits are undone; their changes stay in the working tree, unstaged.' },
    { value: 'hard', label: 'Delete changes (--hard)', hint: 'The commits are undone and every change since — including uncommitted work — is gone.' },
  ]
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reset the branch to ${target.short}`}
      description={target.subject}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={mode === 'hard' ? 'danger' : 'primary'} loading={busy} data-action="reset" onClick={() => { if (!busy) void attempt(() => onReset(mode), setBusy, onClose) }}>
            Reset
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-2" data-dialog="reset" role="radiogroup" aria-label="Reset mode">
        {rows.map((r) => (
          <label key={r.value} class="flex cursor-pointer items-start gap-2 rounded-md border border-border-soft px-2.5 py-2 hover:bg-raised">
            <input type="radio" name="reset-mode" class="mt-0.5" checked={mode === r.value} onChange={() => setMode(r.value)} />
            <span class="flex flex-col gap-0.5">
              <span class={`text-[12.5px] ${r.value === 'hard' ? 'text-red' : 'text-fg'}`}>{r.label}</span>
              <span class="text-[11.5px] text-faint">{r.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  )
}

/** One field, one answer: a new name, a message, a URL. */
export function TextDialog({ open, onClose, title, description, label, initial = '', placeholder, confirmLabel, multiline = false, danger = false, onSubmit }: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  label: string
  initial?: string
  placeholder?: string
  confirmLabel: string
  multiline?: boolean
  danger?: boolean
  onSubmit: (value: string) => Promise<boolean>
}): VNode | null {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setValue(initial) }, [open, initial])
  const submit = (): void => { if (value.trim() !== '' && !busy) void attempt(() => onSubmit(value.trim()), setBusy, onClose) }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      {...(description !== undefined ? { description } : {})}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={submit} disabled={value.trim() === ''} loading={busy} data-action="text-submit">{confirmLabel}</Button>
        </>
      }
    >
      <div data-dialog="text">
        <Field label={label}>
          {multiline
            ? <Textarea rows={4} value={value} {...(placeholder !== undefined ? { placeholder } : {})} data-autofocus onInput={(e) => setValue(e.currentTarget.value)} />
            : <Input value={value} {...(placeholder !== undefined ? { placeholder } : {})} data-autofocus onInput={(e) => setValue(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />}
        </Field>
      </div>
    </Dialog>
  )
}

import type { VNode } from 'preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { ArrowDown, ArrowUp, Check, GitMerge } from 'lucide-preact'
import type { GitConflictResult } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { allResolved, hasMarkers, parseConflicts, resolveText, type ConflictChoice, type ParsedConflicts } from '../lib/conflicts'
import { PanelEmpty, PanelError, PanelLoading, PanelNote } from '../components/panel'
import { Button, IconButton } from '../ui/button'
import { cn } from '../ui/cn'
import { Textarea } from '../ui/input'
import { toast } from '../ui/toast'

/**
 * The merge editor — Visual Studio's, for one conflicted file.
 *
 * Two columns above, Incoming (theirs) on the left and Current (ours) on the right, each
 * conflict a block with a checkbox per side: tick one, tick both (in either order), or
 * none. The Result below is the file as it will be written, editable by hand for the
 * cases no checkbox covers. Take Incoming / Take Current answer every block at once.
 * Accept Merge writes the result and marks the file resolved (`git add`); the merge is
 * then finished on the Git tab.
 *
 * The markers are parsed from the working copy, which is what git wrote, rather than
 * re-derived from the three sides — the same text a person would edit by hand.
 */

export function MergeEditor({ client, root, repoPath, path, onResolved }: {
  client: ProtocolClient
  root: string
  repoPath: string
  /** The workspace spelling, for the title. */
  path: string
  onResolved?: () => void
}): VNode {
  const [sides, setSides] = useState<GitConflictResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [choices, setChoices] = useState<Map<number, ConflictChoice>>(new Map())
  const [manual, setManual] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    let cancelled = false
    setSides(null)
    setFailed(null)
    client.call('git.conflict', { root, path: repoPath })
      .then((r) => { if (cancelled) return; if (r.problem !== undefined) setFailed(r.problem); else setSides(r) })
      .catch((e: Error) => { if (!cancelled) setFailed(e.message) })
    return () => { cancelled = true }
  }, [client, root, repoPath])

  const parsed: ParsedConflicts | null = useMemo(() => (sides === null ? null : parseConflicts(sides.working)), [sides])
  const result = useMemo(() => (parsed === null ? '' : manual ?? resolveText(parsed, choices)), [parsed, choices, manual])
  const complete = parsed !== null && (manual !== null ? !hasMarkers(manual) : allResolved(parsed, choices))

  if (failed !== null) return <PanelError message={failed} />
  if (sides === null || parsed === null) return <PanelLoading what="reading the conflict…" />
  if (parsed.conflicts.length === 0 && !done) {
    return (
      <PanelEmpty
        icon={<GitMerge />}
        title="No conflict markers in this file"
        hint="Either it was resolved already, or the conflict is about the whole file (deleted on one side). Keep a side from the Git tab's menu."
      />
    )
  }

  const choose = (index: number, choice: ConflictChoice): void => {
    setManual(null)
    setChoices((m) => new Map(m).set(index, choice))
  }
  const toggle = (index: number, side: 'ours' | 'theirs'): void => {
    const now = choices.get(index) ?? 'none'
    const hasOurs = now === 'ours' || now === 'both' || now === 'both-reversed'
    const hasTheirs = now === 'theirs' || now === 'both' || now === 'both-reversed'
    const ours = side === 'ours' ? !hasOurs : hasOurs
    const theirs = side === 'theirs' ? !hasTheirs : hasTheirs
    let next: ConflictChoice = 'none'
    if (ours && theirs) next = side === 'theirs' && !hasOurs ? 'both' : (now === 'ours' && side === 'theirs' ? 'both' : now === 'theirs' && side === 'ours' ? 'both-reversed' : 'both')
    else if (ours) next = 'ours'
    else if (theirs) next = 'theirs'
    choose(index, next)
  }
  const takeAll = (choice: ConflictChoice): void => {
    setManual(null)
    setChoices(new Map(parsed.conflicts.map((c) => [c.index, choice])))
  }

  async function accept(): Promise<void> {
    if (!complete || saving) return
    setSaving(true)
    try {
      const r = await client.call('git.resolve', { root, path: repoPath, text: result })
      if (!r.ok) { toast.push({ title: 'Could not accept the merge', description: r.problem ?? 'git said no', tone: 'error' }); return }
      toast.push({ title: `${path} resolved`, description: 'Marked as resolved. Finish the operation on the Git tab.', tone: 'success' })
      setDone(true)
      onResolved?.()
    } catch (e) {
      toast.push({ title: 'Could not accept the merge', description: (e as Error).message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const has = (index: number, side: 'ours' | 'theirs'): boolean => {
    const c = choices.get(index) ?? 'none'
    return side === 'ours' ? c === 'ours' || c === 'both' || c === 'both-reversed' : c === 'theirs' || c === 'both' || c === 'both-reversed'
  }
  const jump = (delta: number): void => {
    const n = parsed.conflicts.length
    const next = ((cursor + delta) % n + n) % n
    setCursor(next)
    document.querySelector(`[data-conflict="${next}"]`)?.scrollIntoView({ block: 'center' })
  }
  const remaining = parsed.conflicts.filter((c) => (choices.get(c.index) ?? 'none') === 'none').length

  const column = (side: 'theirs' | 'ours'): VNode => (
    <div class="flex min-w-0 flex-1 flex-col">
      <div class={cn('flex items-center gap-2 border-b border-border-soft px-2.5 py-1.5 text-[11.5px] font-semibold', side === 'theirs' ? 'text-blue' : 'text-accent')}>
        <span class="truncate">{side === 'theirs' ? `Incoming — ${sides.theirsLabel}` : `Current — ${sides.oursLabel}`}</span>
        <Button size="sm" class="ml-auto" onClick={() => takeAll(side)} data-action={side === 'theirs' ? 'take-incoming' : 'take-current'}>{side === 'theirs' ? 'Take Incoming' : 'Take Current'}</Button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-[1.45]">
        {parsed.segments.map((seg, i) => seg.kind === 'text'
          ? <pre key={i} class="whitespace-pre px-2.5 text-faint">{seg.lines.join('\n')}</pre>
          : (
            <div key={i} data-conflict={side === 'theirs' ? seg.index : undefined} class={cn('my-0.5 border-y px-2 py-1', side === 'theirs' ? 'border-blue-line bg-blue-soft' : 'border-accent-line bg-accent-soft', cursor === seg.index && 'outline outline-1 outline-accent')}>
              <label class="mb-0.5 flex cursor-pointer items-center gap-1.5 font-ui text-[11px] text-dim">
                <input type="checkbox" checked={has(seg.index, side)} onChange={() => toggle(seg.index, side)} data-side={side} data-index={seg.index} />
                {side === 'theirs' ? 'take incoming' : 'keep current'} · conflict {seg.index + 1}
              </label>
              <pre class="whitespace-pre text-fg">{(side === 'theirs' ? seg.theirs : seg.ours).join('\n') || '(nothing on this side)'}</pre>
            </div>
            ))}
      </div>
    </div>
  )

  return (
    <div data-view="merge-editor" class="flex h-full min-h-0 flex-col font-ui">
      <div class="flex items-center gap-2 border-b border-border-soft px-3 py-1.5">
        <GitMerge class="size-4 text-accent" />
        <span class="min-w-0 truncate text-[12.5px] font-medium" title={repoPath}>{path}</span>
        <span class="text-[11.5px] text-faint">{parsed.conflicts.length} conflict{parsed.conflicts.length === 1 ? '' : 's'}{remaining > 0 ? ` · ${remaining} unresolved` : ' · all resolved'}</span>
        <span class="ml-auto flex items-center gap-1">
          <IconButton size="sm" label="Previous conflict" onClick={() => jump(-1)}><ArrowUp /></IconButton>
          <IconButton size="sm" label="Next conflict" onClick={() => jump(1)}><ArrowDown /></IconButton>
          <Button size="sm" onClick={() => takeAll('both')}>Take Both</Button>
          <Button size="sm" variant="primary" icon={<Check />} disabled={!complete || done} loading={saving} onClick={() => { void accept() }} data-action="accept-merge">
            {done ? 'Accepted' : 'Accept Merge'}
          </Button>
        </span>
      </div>
      {done && <div class="px-3 pt-2"><PanelNote tone="good" inset>Resolved and staged. When every file is resolved, press Continue on the Git tab.</PanelNote></div>}
      <div class="flex min-h-0 flex-[3] divide-x divide-border-soft">
        {column('theirs')}
        {column('ours')}
      </div>
      <div class="flex min-h-0 flex-[2] flex-col border-t border-border-soft">
        <div class="flex items-center gap-2 px-2.5 py-1 text-[11.5px] font-semibold text-dim">
          Result
          <span class="font-normal text-faint">{manual !== null ? '— edited by hand' : '— from the checkboxes; edit it here for anything else'}</span>
          {manual !== null && <Button size="sm" variant="ghost" class="ml-auto" onClick={() => setManual(null)}>Back to the checkboxes</Button>}
        </div>
        <Textarea
          class="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-[11.5px] leading-[1.45]"
          value={result}
          aria-label="Merge result"
          spellcheck={false}
          onInput={(e) => setManual(e.currentTarget.value)}
        />
      </div>
    </div>
  )
}

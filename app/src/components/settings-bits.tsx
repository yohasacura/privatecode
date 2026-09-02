import type { ComponentChildren, VNode } from 'preact'
import { cn } from '../ui/cn'

/**
 * The words around a setting (docs/UI-REDESIGN-2026-09.md §8): a small capital label
 * above a control, a sentence beneath it, and a titled block for a group of them. One
 * vocabulary for every tab in Settings, so the tabs read as one dialog.
 */

export function SettingLabel({ children, htmlFor, class: klass }: {
  children: ComponentChildren
  htmlFor?: string
  class?: string
}): VNode {
  return (
    <label
      for={htmlFor}
      class={cn('mb-1.5 mt-4 block font-ui text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint first:mt-0', klass)}
    >
      {children}
    </label>
  )
}

export function SettingHint({ children, class: klass }: { children: ComponentChildren; class?: string }): VNode {
  return <div class={cn('mt-1.5 font-ui text-[11.5px] leading-[1.5] text-faint', klass)}>{children}</div>
}

/** A titled block with a sentence, for a setting that has more than one control. */
export function SettingSection({ title, description, children, class: klass }: {
  title: string
  description?: string
  children: ComponentChildren
  class?: string
}): VNode {
  return (
    <section class={cn('flex flex-col gap-2 border-b border-border-soft py-4 first:pt-0 last:border-b-0', klass)}>
      <div>
        <h3 class="m-0 font-ui text-[13px] font-semibold text-fg">{title}</h3>
        {description !== undefined && <p class="m-0 mt-0.5 font-ui text-[12px] leading-[1.5] text-dim">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** A path or an id the person may want to copy: mono, selectable, with the copy beside it. */
export function CopyablePath({ path, label }: { path: string; label?: string }): VNode {
  return (
    <div class="flex min-w-0 items-center gap-2 font-ui text-[12px]">
      {label !== undefined && <span class="shrink-0 text-dim">{label}</span>}
      <code class="min-w-0 flex-1 select-all truncate rounded-sm bg-raised px-1.5 py-0.5 font-mono text-[11.5px] text-fg" title={path}>{path}</code>
      <button
        type="button"
        class="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[11.5px] text-accent hover:underline"
        onClick={() => { navigator.clipboard?.writeText(path).catch(() => { /* the platform's message */ }) }}
      >
        copy
      </button>
    </div>
  )
}

'use client'

import { useMemo, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import {
  Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DynamicIcon } from '@/components/ui/icon-picker'

/**
 * "ADD SECTION" — A ROOM, NOT A DROPDOWN.
 *
 * The builder started with eight section types in a dropdown; it now has
 * seventeen, and a dropdown of seventeen two-line rows is a scrolling list that
 * covers the page you are building and still shows one word per option. So the
 * choice moved into a dialog: grouped tiles, a description that can be read at
 * a glance, and a search box for the studio that already knows the word.
 *
 * The component is deliberately COPY-FREE — it takes the caller's `t`. The team
 * builder and the organisation builder hold their section copy in two different
 * i18n namespaces (`Website` / `OrgWebsite`), and the alternative to passing
 * the translator in is two near-identical pickers, which is how the two
 * builders' Add menus drifted in the first place.
 */

/** Which drawer of the room a section type belongs in. Unset ⇒ 'content'. */
export type SectionGroup = 'content' | 'offer' | 'trust'

export interface SectionPickerEntry<T extends string> {
  type: T
  labelKey: string
  descKey: string
  icon: string
  group?: SectionGroup
  maturity?: 'full' | 'basic' | 'managed'
}

const GROUP_ORDER: SectionGroup[] = ['content', 'offer', 'trust']
const GROUP_KEY: Record<SectionGroup, string> = {
  content: 'sectionGroupContent',
  offer: 'sectionGroupOffer',
  trust: 'sectionGroupTrust',
}

export function SectionPicker<K extends string>({
  entries,
  t,
  onPick,
}: {
  /** The library, already filtered — a 'managed' type never reaches here. */
  entries: SectionPickerEntry<K>[]
  /** The caller's namespace translator (`Website` or `OrgWebsite`). */
  t: (key: string) => string
  onPick: (type: K) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  // Search reads the RENDERED words, not the key names — a studio looking for
  // "Preise" is typing what it sees on the tile.
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((e) =>
      `${t(e.labelKey)} ${t(e.descKey)}`.toLowerCase().includes(needle)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, q])

  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: matches.filter((e) => (e.group ?? 'content') === group),
  })).filter((g) => g.items.length > 0)

  const pick = (type: K) => {
    setOpen(false)
    setQ('')
    onPick(type)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQ('') }}>
      <DialogTrigger className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-input py-3 text-sm font-medium text-muted-foreground hover:border-primary/50 hover:text-foreground">
        <Plus className="h-4 w-4" />
        {t('addSection')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('addSectionTitle')}</DialogTitle>
          <DialogDescription>{t('addSectionDesc')}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('addSectionSearch')}
            className="h-10 pl-9"
            autoFocus
          />
        </div>
        <DialogBody className="space-y-6">
          {groups.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('addSectionNoMatch')}</p>
          )}
          {groups.map(({ group, items }) => (
            <div key={group} className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(GROUP_KEY[group])}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {items.map((entry) => (
                  <button
                    key={entry.type}
                    type="button"
                    onClick={() => pick(entry.type)}
                    className="flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <DynamicIcon name={entry.icon} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 space-y-1">
                      <span className="block text-sm font-semibold leading-none">{t(entry.labelKey)}</span>
                      <span className="block text-xs leading-snug text-muted-foreground">
                        {t(entry.descKey)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

'use client'

/**
 * THE GROUPED, SEARCHABLE VERTICAL TAB LIST — presentation only.
 *
 * Extracted from `SettingsRail` when the organisation area was given the same
 * shape (docs/org-navigation.md). The point of that design is that an org looks
 * and behaves like a studio, so the two rails have to LOOK identical; keeping
 * one set of markup is what makes that true by construction rather than by
 * somebody remembering to copy a class name.
 *
 * IT RESOLVES NOTHING. No labels, no gates, no active rule, no pins — every one
 * of those differs between the two callers and each is the caller's own
 * business:
 *
 *   • the studio rail resolves labels from the `Nav` namespace, gates on
 *     capabilities and installed plugins, matches `?tab=` as well as the path,
 *     and carries the "always show" pin (which is stored PER STUDIO, so it has
 *     no meaning on an org row);
 *   • the org rail resolves labels from `Org`, substitutes the tenant's own word
 *     for Affiliations, gates on org role, and matches the path segment.
 *
 * Fusing those would mean a component that takes six behavioural flags. So this
 * takes rows that are already decided, and only draws them.
 */

import { useState } from 'react'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'

export interface NavRailRow {
  id: string
  href: string
  label: string
  icon: LucideIcon
  active: boolean
  /** Text the search box matches in addition to the label — the studio rail
   *  feeds it the shared keyword index so "stripe" finds Payments. */
  keywords?: string
  /** Rendered at the row's right edge, revealed on hover (the pin). */
  trailing?: React.ReactNode
}

export interface NavRailGroup {
  key: string
  label: string
  rows: NavRailRow[]
}

export function NavRail({
  groups,
  searchPlaceholder,
  noResultsLabel,
}: {
  groups: NavRailGroup[]
  searchPlaceholder: string
  noResultsLabel: string
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  const matches = (row: NavRailRow) =>
    !q || row.label.toLowerCase().includes(q) || (row.keywords ?? '').toLowerCase().includes(q)

  const shown = groups
    .map((g) => ({ ...g, rows: g.rows.filter(matches) }))
    .filter((g) => g.rows.length > 0)

  return (
    <nav className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="h-9 pl-8 text-sm"
        />
      </div>

      {shown.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">{noResultsLabel}</p>
      ) : (
        shown.map((group) => (
          <div key={group.key} className="space-y-0.5">
            <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
              {group.label}
            </p>
            {group.rows.map((row) => {
              const Icon = row.icon
              return (
                <div key={row.id} className="group relative flex items-center">
                  <Link
                    href={row.href as Route}
                    className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 ${
                      row.trailing ? 'pr-8' : 'pr-2'
                    } text-sm transition-colors ${
                      row.active
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'text-foreground/80 hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${row.active ? 'text-primary' : 'text-muted-foreground'}`}
                    />
                    <span className="truncate">{row.label}</span>
                  </Link>
                  {row.trailing}
                </div>
              )
            })}
          </div>
        ))
      )}
    </nav>
  )
}

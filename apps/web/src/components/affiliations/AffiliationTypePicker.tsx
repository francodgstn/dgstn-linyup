'use client'

/**
 * WHICH AFFILIATION ARE WE LOOKING AT — as cards, and never "all of them".
 *
 * ── WHY "ALL TYPES" IS GONE ─────────────────────────────────────────────────
 *
 * A contact may hold SEVERAL affiliations at once — that is the whole point of
 * the axis — so a flat list with one status column per row cannot show "all
 * types" honestly. It showed `affiliation_summary.has_active`, which answers
 * "any affiliation at all" and not "this one", so the status pills, the
 * expiring count and the bulk actions all quietly meant something different
 * from the rows beneath them. One type at a time is the only reading where the
 * column, the filter and the action agree.
 *
 * A studio with exactly one type therefore never sees a choice: it is selected,
 * and the picker renders nothing. Asking somebody to pick from one is a control
 * that can only ever be a no-op — the same rule the offer page's source chips
 * already follow.
 *
 * ── WHY CARDS ───────────────────────────────────────────────────────────────
 *
 * There are a handful of these per tenant, not a hundred, and each is a thing
 * with a mark: a federation licence, a club membership, a governing body's
 * registration. `logo_url` is shown where it exists, the label's initial where
 * it does not, so a picker without logos still reads as a set of things rather
 * than as an empty grid.
 */

import type { AffiliationType } from '@linyup/shared'

export function AffiliationTypePicker({
  types,
  selectedId,
  onSelect,
  countFor,
}: {
  types: AffiliationType[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Optional badge per card — how many contacts hold this type. */
  countFor?: (typeId: string) => number | undefined
}) {
  // One type is not a choice; zero is a different screen's problem.
  if (types.length < 2) return null

  return (
    <div className="flex flex-wrap gap-2">
      {types.map((at) => {
        const on = at.id === selectedId
        const count = countFor?.(at.id)
        return (
          <button
            key={at.id}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(at.id)}
            className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
              on
                ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                : 'hover:border-foreground/30'
            }`}
          >
            <AffiliationTypeMark type={at} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{at.label}</span>
              {count !== undefined && (
                <span className="block text-xs text-muted-foreground">{count}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The type's mark, at a fixed 28px so a row of cards keeps one baseline
 * whatever the logos are. Exported because the contact's affiliation row shows
 * the same mark beside the same status — one component, so a type that gains a
 * logo gains it in both places at once.
 */
export function AffiliationTypeMark({
  type,
  size = 28,
}: {
  type: Pick<AffiliationType, 'label' | 'logo_url'>
  size?: number
}) {
  const initial = (type.label ?? '?').trim().charAt(0).toUpperCase() || '?'
  if (!type.logo_url) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size }}
        className="grid shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground"
      >
        {initial}
      </span>
    )
  }
  return (
    // A plain <img>: the URL is tenant-authored and arbitrary, which
    // next/image would refuse without the host in its allow-list — and a broken
    // logo must degrade to nothing, never to a crash.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={type.logo_url}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-md object-contain"
      style={{ width: size, height: size }}
    />
  )
}

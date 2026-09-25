'use client'

import { useState, useTransition } from 'react'
import { setTenantComped } from './actions'

/**
 * Operator control for `TenantFlags.comped` — the platform bills this tenant
 * nothing, indefinitely.
 *
 * ── WHY IT IS NOT A TOGGLE ───────────────────────────────────────────────────
 * Every other control on this page is a switch, and this one deliberately is
 * not. Comping is the widest-reaching operator action there is: it exempts the
 * tenant from the trial sweep and from the organization wind-down, removes it
 * from the MRR line, refuses its own Subscribe button, and — on an organization
 * — waives Linyup's platform fee on every payment taken by every studio in it.
 * A switch invites a stray click; a form with a required reason asks the
 * operator to state what they are doing before it happens.
 *
 * The reason is not decoration. `comped_reason` and `comped_since` sit beside
 * the flag precisely so that the first person to ask "why is this tenant not
 * paying?" gets an answer instead of a tenant that looks broken.
 *
 * Clearing keeps the reason and the date: a comp that ENDED is a thing worth
 * being able to read later.
 */
export function CompCard({
  kind,
  entityId,
  initialComped,
  initialReason,
  compedSince,
}: {
  kind: 'team' | 'org'
  entityId: string
  initialComped: boolean
  initialReason?: string | null
  compedSince?: string | null
}) {
  const [comped, setComped] = useState(initialComped)
  const [reason, setReason] = useState(initialReason ?? '')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const label = kind === 'org' ? 'organization' : 'studio'

  function apply(next: boolean) {
    if (
      next &&
      !window.confirm(
        `Comp this ${label}? It will be billed nothing indefinitely` +
          (kind === 'org'
            ? ', and Linyup will take no platform fee on payments at any of its studios.'
            : '.')
      )
    ) {
      return
    }
    if (!next && !window.confirm(`End the comp for this ${label}? It becomes billable again.`)) {
      return
    }
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const res = await setTenantComped(kind, entityId, next, reason)
      if (res.ok) {
        setComped(next)
        setSaved(true)
      } else {
        setError(res.error ?? 'Failed to update.')
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            comped
              ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {comped ? 'Comped — bills nothing' : 'Billable'}
        </span>
        {comped && compedSince && (
          <span className="text-xs text-muted-foreground">since {compedSince}</span>
        )}
      </div>

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Reason</span>
        <input
          type="text"
          value={reason}
          disabled={pending}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. founding organization, migrated 2026"
          className="rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
        />
      </label>

      <div className="flex items-center gap-2">
        {!comped ? (
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => apply(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            Comp this {label}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={pending || !reason.trim()}
              onClick={() => apply(true)}
              className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              Update reason
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => apply(false)}
              className="rounded-md border border-destructive px-3 py-1.5 text-xs font-medium text-destructive disabled:opacity-50"
            >
              End comp
            </button>
          </>
        )}
        {saved && !error && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

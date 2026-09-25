'use client'

import { useState, useTransition } from 'react'
import { setTenantInternal } from './actions'

/**
 * Operator control for `TenantFlags.internal` — this tenant is Linyup's own
 * (a demo studio, a test tenant, the review studio) and must not count.
 *
 * Read by platform metrics (excluded), the trial sweep (exempt — it cannot
 * lapse to Free mid-demo) and the org wind-down. Until now it was written by
 * the demo-tenant provisioner and by nobody else, so a tenant created by hand
 * for a test polluted every platform number until somebody edited Firestore.
 *
 * A confirm rather than a reason: unlike a comp, marking a tenant internal
 * changes nothing about what it is billed — it changes whether it is COUNTED.
 * The only real hazard is marking a paying customer internal, which the
 * confirm names.
 */
export function InternalCard({
  kind,
  entityId,
  initialInternal,
}: {
  kind: 'team' | 'org'
  entityId: string
  initialInternal: boolean
}) {
  const [internal, setInternal] = useState(initialInternal)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const label = kind === 'org' ? 'organization' : 'studio'

  function apply(next: boolean) {
    const question = next
      ? `Mark this ${label} as INTERNAL? It disappears from every platform metric and the trial sweep leaves it alone. Never do this to a paying customer.`
      : `Make this ${label} count again? It returns to the platform metrics and the trial sweep.`
    if (!window.confirm(question)) return
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const res = await setTenantInternal(kind, entityId, next)
      if (res.ok) {
        setInternal(next)
        setSaved(true)
      } else {
        setError(res.error ?? 'Failed to update.')
      }
    })
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            internal
              ? 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {internal ? 'Internal — not counted' : 'Counted in platform metrics'}
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => apply(!internal)}
          className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {internal ? 'Count it again' : 'Mark internal'}
        </button>
        {saved && !error && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Internal tenants (demo, test, the review studio) are excluded from platform metrics and
        exempt from the trial sweep.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { callFunction } from '@/lib/callFunction'
import { Button } from '@/components/ui/button'
import type { DemoTenantStatus } from '@/lib/queries/demoTenant'

// The mutations are CALLABLES, not server actions: `manageDemoTenant` purges and
// re-provisions a whole tenant and is given nine minutes to do it, which is not
// a Next request's job. Everything shown here was read server-side.

export function DemoTenantCard({ status }: { status: DemoTenantStatus }) {
  const router = useRouter()
  const [busy, setBusy] = useState<'provision' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // A reset destroys everything in the tenant, so it is typed rather than
  // clicked — the same shape the purge script and the lead reset use.
  const [confirmText, setConfirmText] = useState('')

  async function run(action: 'provision' | 'reset') {
    setError(null)
    setDone(null)
    setBusy(action)
    try {
      const fn = callFunction<{ action: string }, { counts: Record<string, number> }>(
        'manageDemoTenant'
      )
      const res = await fn({ action })
      const c = res.data.counts
      setDone(
        `${action === 'reset' ? 'Reset' : 'Provisioned'} — ${c.contacts} contacts, ${c.sessions} sessions, ${c.bookings} bookings.`
      )
      setConfirmText('')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  const resetArmed = confirmText.trim() === status.teamId

  return (
    <div className="flex flex-col gap-4">
      {status.provisioned ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Team</dt>
          <dd>
            {status.name} <span className="text-muted-foreground">({status.teamId})</span>
          </dd>
          <dt className="text-muted-foreground">Content</dt>
          <dd>
            {status.contacts} contacts · {status.sessions} sessions
          </dd>
          {/* The three safety properties, each shown as a pass/fail rather than
              assumed. If any of them is wrong the tenant is not safe to leave in
              production, and that should be visible here rather than discovered. */}
          <dt className="text-muted-foreground">Hidden from metrics</dt>
          <dd className={status.internal ? 'text-green-700' : 'text-red-600 font-medium'}>
            {status.internal ? 'yes (flags.internal)' : 'NO — it is polluting platform metrics'}
          </dd>
          <dt className="text-muted-foreground">Outbound messaging</dt>
          <dd
            className={status.messagingMode === 'silent' ? 'text-green-700' : 'text-red-600 font-medium'}
          >
            {status.messagingMode === 'silent'
              ? 'silent'
              : `${status.messagingMode ?? 'no policy'} — it can send mail from production`}
          </dd>
          <dt className="text-muted-foreground">Payment account</dt>
          <dd
            className={!status.hasConnectAccount ? 'text-green-700' : 'text-red-600 font-medium'}
          >
            {status.hasConnectAccount
              ? 'CONNECTED — a reviewer could be charged real money'
              : 'none (every priced door is closed)'}
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          Not provisioned yet. Creating it writes a studio with synthetic contacts, a schedule and
          one membership — silent, hidden from platform metrics, and with no payment account.
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {done && <p className="text-sm text-green-700">{done}</p>}

      <div className="flex flex-col gap-3 border-t pt-4">
        <Button onClick={() => run('provision')} disabled={busy !== null} className="self-start">
          {busy === 'provision' ? 'Working…' : status.provisioned ? 'Re-apply' : 'Provision'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Re-apply converges the tenant without removing anything — safe to run any time. The
          schedule is regenerated so it always shows upcoming sessions.
        </p>
      </div>

      {status.provisioned && (
        <div className="flex flex-col gap-2 border-t pt-4">
          <p className="text-sm font-medium">Reset before a submission</p>
          <p className="text-xs text-muted-foreground">
            Deletes everything in the tenant and rebuilds it, so a reviewer meets the same state
            every time. Type <code className="font-mono">{status.teamId}</code> to confirm.
          </p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={status.teamId}
            className="w-64 rounded-md border px-2 py-1 font-mono text-sm"
          />
          <Button
            variant="destructive"
            onClick={() => run('reset')}
            disabled={busy !== null || !resetArmed}
            className="self-start"
          >
            {busy === 'reset' ? 'Resetting…' : 'Reset tenant'}
          </Button>
        </div>
      )}
    </div>
  )
}

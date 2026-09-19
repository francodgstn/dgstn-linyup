'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { callFunction } from '@/lib/callFunction'
import { clearTenantFeeRate, setTenantFeeRate } from './actions'

/**
 * Operator control for `TenantFlags.fee_rate` — a platform-fee rate negotiated
 * with this tenant, in place of its plan's published take-rate.
 *
 * Two separate acts, and the card keeps them apart on purpose:
 *   1. SAVE the rate — the next one-off payment is charged at it;
 *   2. APPLY it to existing member subscriptions — Stripe stores the fee percent
 *      on each subscription, so they keep the old rate until updated.
 * Folding (2) into (1) would make saving a typo a Stripe write across every
 * member of every studio in an organisation.
 */

interface FeeRateView {
  bps: number
  reason: string
  sinceMs: number | null
  expiresAtMs: number | null
}

interface ResyncRow {
  teamId: string
  percent: number | null
  updated: number
  unchanged: number
  failed: number
  skipped?: string
}

const pct = (bps: number) => `${(bps / 100).toLocaleString('en-CH', { maximumFractionDigits: 2 })} %`

/** 'YYYY-MM-DD' of the last day a rate applies, in the studio's calendar. */
function lastDayInput(expiresAtMs: number | null): string {
  if (!expiresAtMs) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(expiresAtMs - 1))
}

function lastDayLabel(expiresAtMs: number): string {
  return new Date(expiresAtMs - 1).toLocaleDateString('en-GB', {
    timeZone: 'Europe/Zurich',
    dateStyle: 'medium',
  })
}

export function FeeRateCard({
  kind,
  entityId,
  comped,
  publishedBps,
  feeRate,
}: {
  kind: 'team' | 'org'
  entityId: string
  comped: boolean
  /** Null for an organisation — its studios each have their own plan. */
  publishedBps: number | null
  feeRate: FeeRateView | null
}) {
  const router = useRouter()
  const [percent, setPercent] = useState(feeRate ? String(feeRate.bps / 100) : '')
  const [lastDay, setLastDay] = useState(lastDayInput(feeRate?.expiresAtMs ?? null))
  const [reason, setReason] = useState(feeRate?.reason ?? '')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [resyncing, setResyncing] = useState(false)
  const [resync, setResync] = useState<ResyncRow[] | null>(null)

  const label = kind === 'org' ? 'organisation' : 'studio'
  // Rendered per request (force-dynamic), so "now" is the request time.
  const expired = feeRate?.expiresAtMs != null && feeRate.expiresAtMs <= Date.now()
  const noEffect = feeRate != null && publishedBps != null && feeRate.bps >= publishedBps

  function save() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const res = await setTenantFeeRate(kind, entityId, {
        percent,
        reason,
        lastDay: lastDay || null,
      })
      if (res.ok) {
        setSaved(true)
        router.refresh()
      } else {
        setError(res.error ?? 'Failed to save.')
      }
    })
  }

  function end() {
    if (!window.confirm(`End the negotiated rate for this ${label}? It returns to the published rate.`)) {
      return
    }
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const res = await clearTenantFeeRate(kind, entityId)
      if (res.ok) {
        setPercent('')
        setLastDay('')
        setReason('')
        router.refresh()
      } else {
        setError(res.error ?? 'Failed to end the rate.')
      }
    })
  }

  async function applyToSubscriptions() {
    if (
      !window.confirm(
        `Update every live member subscription of this ${label} on Stripe to the rate that applies now?`
      )
    ) {
      return
    }
    setError(null)
    setResync(null)
    setResyncing(true)
    try {
      const fn = callFunction<{ kind: string; entityId: string }, { results: ResyncRow[] }>(
        'resyncTenantFeeRate'
      )
      setResync((await fn({ kind, entityId })).data.results)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update subscriptions.')
    } finally {
      setResyncing(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {feeRate == null ? (
          <>
            Published rate
            {publishedBps != null && <span className="font-medium"> · {pct(publishedBps)}</span>}
          </>
        ) : expired ? (
          <>
            Negotiated {pct(feeRate.bps)} <span className="text-muted-foreground">ended{' '}
            {lastDayLabel(feeRate.expiresAtMs!)} — the published rate applies</span>
          </>
        ) : (
          <>
            <span className="font-medium">Negotiated {pct(feeRate.bps)}</span>
            <span className="text-muted-foreground">
              {' '}
              · {feeRate.expiresAtMs ? `last day ${lastDayLabel(feeRate.expiresAtMs)}` : 'no end date'}
              {publishedBps != null && ` · published ${pct(publishedBps)}`}
            </span>
          </>
        )}
      </p>

      {comped && (
        <p className="text-xs text-muted-foreground">
          This {label} is comped, so no fee is taken whatever the rate says.
        </p>
      )}
      {noEffect && !expired && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          At or above the published rate, so it has no effect — the lower rate is always charged.
        </p>
      )}
      {kind === 'org' && (
        <p className="text-xs text-muted-foreground">
          Applies to every studio in this organisation, unless a studio has its own rate. A studio
          is never charged more than its own plan&apos;s published rate.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Rate (%)</span>
          <input
            type="text"
            inputMode="decimal"
            value={percent}
            disabled={pending}
            onChange={(e) => setPercent(e.target.value)}
            placeholder="e.g. 0.5"
            className="rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Last day (blank = no end)</span>
          <input
            type="date"
            value={lastDay}
            disabled={pending}
            onChange={(e) => setLastDay(e.target.value)}
            className="rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Reason</span>
        <input
          type="text"
          value={reason}
          disabled={pending}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. volume deal agreed with the owner, 2026-09"
          className="rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || !percent.trim() || !reason.trim()}
          onClick={save}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {feeRate ? 'Save rate' : 'Set negotiated rate'}
        </button>
        {feeRate && (
          <button
            type="button"
            disabled={pending}
            onClick={end}
            className="rounded-md border border-destructive px-3 py-1.5 text-xs font-medium text-destructive disabled:opacity-50"
          >
            End rate
          </button>
        )}
        {saved && !error && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>

      <div className="flex flex-col gap-1 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          New payments use the rate straight away. Existing member subscriptions keep the rate they
          were created with until they are updated. An expired rate is re-applied to them overnight.
        </p>
        <div>
          <button
            type="button"
            disabled={resyncing || pending}
            onClick={applyToSubscriptions}
            className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {resyncing ? 'Updating…' : 'Apply to existing subscriptions'}
          </button>
        </div>
        {resync && (
          <ul className="text-xs text-muted-foreground">
            {resync.length === 0 && <li>No studios to update.</li>}
            {resync.map((r) => (
              <li key={r.teamId}>
                <code>{r.teamId}</code>{' '}
                {r.skipped
                  ? `skipped (${r.skipped === 'no_account' ? 'no Stripe account' : 'payments disabled'})`
                  : `→ ${r.percent} %: ${r.updated} updated, ${r.unchanged} already on it` +
                    (r.failed ? `, ${r.failed} failed (see function logs)` : '')}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

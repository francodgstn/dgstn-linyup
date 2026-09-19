'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { callFunction } from '@/lib/callFunction'
import { Button } from '@/components/ui/button'
import type { ReviewAccessStatus } from '@/lib/queries/demoTenant'

const MAX_DAYS = 60

// The code is WRITE-ONLY from here: it is never read back, so the field is
// always blank on load and an operator who has lost it sets a new one. Reading a
// live credential into a browser — and into every proxy log on the way — to
// display it would be a strange thing to do for convenience.

export function ReviewAccessCard({ status }: { status: ReviewAccessStatus }) {
  const router = useRouter()
  const [email, setEmail] = useState(status.email ?? '')
  const [code, setCode] = useState('')
  const [days, setDays] = useState(30)
  const [note, setNote] = useState(status.note ?? '')
  // The addresses this code opens. Seeded from what is stored, so opening the
  // page and pressing Enable re-saves what was already true rather than
  // silently narrowing the list to the reviewer.
  const [selected, setSelected] = useState<string[]>(
    status.addresses.length > 0 ? status.addresses : status.email ? [status.email] : []
  )
  const [busy, setBusy] = useState<'enable' | 'disable' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function enable() {
    setError(null)
    setDone(null)
    setBusy('enable')
    try {
      const fn = callFunction('setReviewAccess')
      // The reviewer's own address is always included: it is the one the store
      // actually needs, and an operator narrowing the tester list should not be
      // able to lock out a review by accident.
      const emails = [...new Set([email.toLowerCase().trim(), ...selected])].filter(Boolean)
      await fn({ enabled: true, email, emails, code, days, note })
      setCode('')
      setDone('Review login enabled.')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  async function disable() {
    setError(null)
    setDone(null)
    setBusy('disable')
    try {
      const fn = callFunction('setReviewAccess')
      await fn({ enabled: false })
      setDone('Review login disabled.')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  const live = status.enabled && !status.expired

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm">
        {!status.configured ? (
          <span className="text-muted-foreground">Never configured.</span>
        ) : live ? (
          <span className="text-amber-700">
            <strong>Active</strong> for{' '}
            {status.addresses.length > 1 ? (
              // The count IS the blast radius. One code opens every address on
              // the document, so showing only the reviewer's would understate
              // what disabling this actually revokes.
              <>
                {status.addresses.length} addresses ({status.email} + {status.addresses.length - 1}{' '}
                tester logins)
              </>
            ) : (
              status.email
            )}{' '}
            until {status.expiresMs ? new Date(status.expiresMs).toLocaleString() : 'unknown'}
            {status.updatedBy ? ` · set by ${status.updatedBy}` : ''}
          </span>
        ) : (
          <span className="text-green-700">
            Not active{status.configured && status.expired && status.enabled ? ' (expired)' : ''}.
          </span>
        )}
      </div>

      {status.candidates.length > 1 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Addresses this code opens ({selected.length})
            </span>
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setSelected(status.candidates.map((c) => c.email))}
              >
                All
              </button>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setSelected(status.email ? [status.email] : [])}
              >
                Reviewer only
              </button>
            </div>
          </div>
          {/* Only contacts of the demo tenant appear here, and the callable
              refuses anything else — so a fixed code can never be opened on an
              address that has no contact behind it, or on a real mailbox. */}
          <div className="max-h-56 overflow-y-auto rounded-md border">
            {status.candidates.map((c) => {
              const isReviewer = c.email === status.email
              const checked = isReviewer || selected.includes(c.email)
              return (
                <label
                  key={c.email}
                  className="flex items-center gap-2.5 border-b px-3 py-1.5 text-sm last:border-b-0"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isReviewer}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked
                          ? [...new Set([...prev, c.email])]
                          : prev.filter((x) => x !== c.email)
                      )
                    }
                  />
                  <span className="font-mono text-xs">{c.email}</span>
                  <span className="truncate text-muted-foreground">{c.name}</span>
                  {isReviewer && (
                    <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                      reviewer
                    </span>
                  )}
                </label>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            One code opens every ticked address. Disabling revokes all of them at once.
            Addresses come from the demo tenant&rsquo;s contacts &mdash; run
            <code className="mx-1">pnpm provision:demo</code> to add more.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {done && <p className="text-sm text-green-700">{done}</p>}

      <div className="grid gap-3 border-t pt-4 sm:max-w-md">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Contact email</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="app.review@example.com"
            className="rounded-md border px-2 py-1 font-mono text-sm"
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Six-digit code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="——————"
            inputMode="numeric"
            className="w-40 rounded-md border px-2 py-1 font-mono text-lg tracking-widest"
          />
          <span className="text-xs text-muted-foreground">
            Put this in App Store Connect and Google Play before enabling. It is never shown again.
          </span>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Window (days, max {MAX_DAYS})</span>
          <input
            type="number"
            min={1}
            max={MAX_DAYS}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-24 rounded-md border px-2 py-1 text-sm"
          />
          <span className="text-xs text-muted-foreground">
            It switches itself off at the end, so nobody has to remember to.
          </span>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Note (optional)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="iOS 1.2.0 submission"
            className="rounded-md border px-2 py-1 text-sm"
          />
        </label>

        <div className="flex gap-2">
          <Button onClick={enable} disabled={busy !== null || code.length !== 6 || !email}>
            {busy === 'enable' ? 'Saving…' : live ? 'Update' : 'Enable'}
          </Button>
          {status.configured && status.enabled && (
            <Button variant="destructive" onClick={disable} disabled={busy !== null}>
              {busy === 'disable' ? 'Disabling…' : 'Disable now'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

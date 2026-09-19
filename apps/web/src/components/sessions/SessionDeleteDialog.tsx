'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { deleteDoc, doc, onSnapshot } from 'firebase/firestore'
import { toast } from 'sonner'
import { db } from '@/lib/firebase'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  SESSIONS_COLLECTION,
  SESSION_SERIES_JOBS_COLLECTION,
  seriesTeardownProgress,
  type SeriesTeardownJob,
} from '@linyup/shared'
import type { Session } from '@linyup/shared'
import { Loader2, Repeat2, AlertTriangle } from 'lucide-react'
import { callFunction } from '@/lib/callFunction'

/**
 * Series-aware session delete. Standalone sessions are removed directly; sessions
 * that belong to a recurring series offer a "this only / this and following"
 * choice and go through the `cancelSession` Cloud Function (which also notifies
 * booked contacts and marks single deletions as cancelled exceptions).
 *
 * "This and following" over a LARGE series does not finish inside the callable —
 * every occurrence closes a waitlist, releases seats and mails its roster — so
 * the server answers `mode: 'background'` with a jobId and drains it in a Cloud
 * Task. This dialog then follows `session_series_jobs/{jobId}` live. The studio
 * may close the window at any point: the job is server-side and does not depend
 * on anyone watching it, which is the whole reason it is a job.
 *
 * ONE EXCEPTION, and it is about money: an appointment hold created with a
 * Stripe PAYMENT LINK carries `payment_checkout_session_id`, and that id is the
 * only thing that can ever close a link which stays payable for seven days.
 * Deleting the document throws it away. So those go through
 * `cancelAppointmentSlot` first — it closes the link, then cancels — and the
 * delete follows. A delete on its own is not the defect decision 16 describes (a
 * late payment for a MISSING session is refunded by handleAppointmentCheckout,
 * not re-acquired); losing the ability to close the link is.
 */

interface CancelResult {
  success: boolean
  mode?: 'inline' | 'background'
  jobId?: string
  total?: number
  cancelledCount?: number
}

export function SessionDeleteDialog({
  open, onOpenChange, session, label, onDeleted,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  session: Session | null
  label: string
  onDeleted: () => void
}) {
  const t = useTranslations('Sessions')
  const isSeries = !!session?.seriesId

  const [scope, setScope] = useState<'single' | 'future'>('single')
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<{ id: string; total: number } | null>(null)
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  // The list refresh is fired exactly once per job, whether the studio is still
  // watching or the terminal snapshot arrives after they closed the dialog.
  const settled = useRef(false)

  function reset() {
    setScope('single')
    setBusy(false)
    setJob(null)
    setProgress(null)
    settled.current = false
  }

  function close() {
    // A running job is deliberately NOT cancelled here — it is server-side work
    // the studio already confirmed. Closing just stops watching it.
    reset()
    onOpenChange(false)
  }

  // Follow a background teardown. The subscription outlives the dialog body but
  // not the component, so a studio who closes the window still gets the toast
  // and the list refresh when the job lands.
  useEffect(() => {
    if (!job) return
    const unsub = onSnapshot(
      doc(db, SESSION_SERIES_JOBS_COLLECTION, job.id),
      (snap) => {
        if (!snap.exists()) return
        const data = snap.data() as SeriesTeardownJob
        setProgress({ processed: data.processed ?? 0, total: data.total ?? job.total })
        if (data.status === 'running' || settled.current) return

        settled.current = true
        const failed = data.failed_ids?.length ?? 0
        if (data.status === 'completed') {
          toast.success(t('deleteBackgroundDone', { count: data.processed ?? 0 }))
        } else if (data.status === 'completed_with_errors') {
          toast.warning(
            t('deleteBackgroundPartial', { count: data.processed ?? 0, failed }),
            { duration: 10_000 },
          )
        } else {
          toast.error(t('deleteBackgroundFailed'), { duration: 10_000 })
        }
        onDeleted()
        setJob(null)
      },
      () => {
        // Losing the listener says nothing about the job, which is running
        // server-side regardless. Stop watching rather than claim a failure.
        setJob(null)
      },
    )
    return unsub
  }, [job, t, onDeleted])

  async function confirm() {
    if (!session) return
    setBusy(true)
    try {
      if (isSeries) {
        const cancel = callFunction<{ sessionId: string; deleteScope: string }, CancelResult>('cancelSession')
        const res = await cancel({ sessionId: session.id, deleteScope: scope })
        if (res.data?.mode === 'background' && res.data.jobId) {
          const total = res.data.total ?? 0
          setBusy(false)
          setProgress({ processed: 0, total })
          setJob({ id: res.data.jobId, total })
          return // stay open on the progress view; the list refreshes when it lands
        }
      } else {
        if (session.activityType === 'appointment' && session.payment_checkout_session_id) {
          const closeLink = callFunction<
            { teamId: string; sessionId: string },
            { ok: boolean; cancelled: boolean; reason?: string; linkStillOpen?: boolean }
          >('cancelAppointmentSlot')
          const res = await closeLink({ teamId: session.teamId, sessionId: session.id })
          if (res.data?.ok === false) {
            // The client paid in the window. Do NOT delete: the appointment is
            // paid for, and deleting it here would erase the only record of it.
            toast.warning(t('deleteAppointmentPaidInWindow'), { duration: 10_000 })
            setBusy(false)
            return
          }
          if (res.data?.linkStillOpen) {
            toast.warning(t('deleteAppointmentLinkStillOpen'), { duration: 10_000 })
          }
        }
        await deleteDoc(doc(db, SESSIONS_COLLECTION, session.id))
      }
      onDeleted()
      close()
    } catch (err) {
      // A second teardown on a series already being torn down is refused by the
      // server — say so, rather than leaving the button to fail silently.
      const code = (err as { message?: string })?.message ?? ''
      if (code.includes('teardown-already-running') || code.includes('teardown-in-progress')) {
        toast.warning(t('deleteAlreadyRunning'), { duration: 8_000 })
      }
      setBusy(false)
    }
  }

  const pct = progress ? Math.round(seriesTeardownProgress(progress) * 100) : 0

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {job
              ? <><Loader2 className="h-4 w-4 animate-spin text-primary" />{t('deleteBackgroundTitle')}</>
              : isSeries
                ? <><Repeat2 className="h-4 w-4 text-primary" />{t('deleteScopeTitle')}</>
                : <><AlertTriangle className="h-4 w-4 text-destructive" />{t('deleteSessionTitle')}</>}
          </DialogTitle>
        </DialogHeader>

        {job ? (
          <div className="space-y-3 pt-1">
            <p className="text-sm text-muted-foreground">
              {t('deleteBackgroundDescription', { total: progress?.total ?? job.total })}
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar"
              aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {t('deleteBackgroundProgress', {
                processed: progress?.processed ?? 0,
                total: progress?.total ?? job.total,
              })}
            </p>
            <div className="flex justify-end pt-1">
              <button type="button" onClick={close}
                className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
                {t('deleteRunInBackground')}
              </button>
            </div>
          </div>
        ) : (
          <>
            {isSeries ? (
              <div className="space-y-3 pt-1">
                <p className="text-sm text-muted-foreground">{t('deleteScopeDescription')}</p>
                <div className="space-y-2">
                  {(['single', 'future'] as const).map(s => (
                    <label key={s}
                      className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        scope === s ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/50'
                      }`}>
                      <input type="radio" name="deleteScope" checked={scope === s}
                        onChange={() => setScope(s)} className="accent-primary" />
                      <span className="text-sm">{s === 'single' ? t('deleteScopeThis') : t('deleteScopeFuture')}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground pt-1">{t('deleteConfirm', { label })}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={close} disabled={busy}
                className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50">
                {t('cancel')}
              </button>
              <button type="button" onClick={confirm} disabled={busy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-destructive text-white text-sm font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('delete')}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

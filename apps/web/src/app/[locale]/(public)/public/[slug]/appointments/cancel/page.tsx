'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { cancelEffectKeys, cancelFailureKey } from '@/lib/bookingCancellation'
import type { BookingCancelEffect, CancelBookingResult } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { CalendarX, Check, AlertCircle } from 'lucide-react'
import { callFunction } from '@/lib/callFunction'

export const dynamic = 'force-dynamic'

type State = 'idle' | 'cancelling' | 'done' | 'error'

export default function AppointmentCancelPage() {
  const t = useTranslations('AppointmentCancel')
  const tCancel = useTranslations('BookingCancellation')
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const [state, setState] = useState<State>('idle')
  // A `BookingCancellation` key, resolved from the server's own refusal reason.
  const [errorKey, setErrorKey] = useState<string | null>(null)
  // What the cancellation gave back, for the confirmation screen.
  const [returned, setReturned] = useState<BookingCancelEffect | null>(null)

  useEffect(() => {
    if (!token) setState('error')
  }, [token])

  async function handleCancel() {
    if (!token) return
    setState('cancelling')
    try {
      // Shared cancellation callable (there is no separate appointment one) —
      // token-based, releases the appointment slot and emails the confirmation.
      const fn = callFunction<{ token: string }, CancelBookingResult>('cancelBooking')
      const res = await fn({ token })
      setReturned(res.data?.returned ?? null)
      setState('done')
    } catch (err) {
      // The three branches this replaces compared `err.code` to `'not-found'`
      // and `'failed-precondition'`. The Functions SDK namespaces its codes
      // (`functions/not-found`), so NONE of them could ever match and every
      // failure — including the two that were carefully worded — rendered the
      // generic sentence. `cancelFailureKey` reads the server's own reason and
      // strips the namespace in one place. See lib/bookingCancellation.ts.
      console.error('[public/appointment-cancel] cancel failed:', err)
      setErrorKey(cancelFailureKey(err))
      setState('error')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-sm w-full text-center space-y-5">
        {(state === 'idle' || state === 'cancelling') && token && (
          <>
            <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              <CalendarX className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <h1 className="text-xl font-bold">{t('title')}</h1>
              <p className="text-sm text-muted-foreground">{t('message')}</p>
            </div>
            <Button
              onClick={handleCancel}
              disabled={state === 'cancelling'}
              variant="destructive"
              className="w-full"
            >
              {state === 'cancelling' ? t('cancelling') : t('confirm')}
            </Button>
          </>
        )}

        {state === 'done' && (
          <>
            <div className="mx-auto w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
              <Check className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h1 className="text-xl font-bold">{t('cancelledTitle')}</h1>
            <p className="text-sm text-muted-foreground">{t('cancelledMessage')}</p>
            {/* An appointment is the rail most likely to have been PAID for, and
                cancelling it returns no money — saying so here is the difference
                between a member who asks the studio and one who waits. */}
            {cancelEffectKeys(returned, 'did').map((key) => (
              <p key={key} className="text-sm text-muted-foreground">
                {tCancel(key)}
              </p>
            ))}
          </>
        )}

        {state === 'error' && (
          <>
            <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <h1 className="text-xl font-bold">{t('errorTitle')}</h1>
            <p className="text-sm text-muted-foreground">
              {errorKey ? tCancel(errorKey) : token ? t('errorGeneric') : t('errorNoToken')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

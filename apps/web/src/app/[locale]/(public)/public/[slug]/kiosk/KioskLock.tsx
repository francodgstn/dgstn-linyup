'use client'

// Device-pairing gate. When `lock.enabled` is false this is a pure pass-through.
// When enabled, the tablet must carry a Firebase Auth custom-token session minted
// by the `unlockKiosk` callable (claims `{ kiosk: true, kioskTeam, kioskEpoch }`
// — never a `contactId`, see packages/functions/src/kiosk/index.ts) whose
// `kioskEpoch` still matches the team's current lock epoch (a rotate/sign-out-all
// in the admin panel bumps the epoch, instantly revoking already-paired devices).
// Firebase Auth persists this session on the device automatically — the ONLY
// persistence the kiosk is allowed to keep (see the privacy note in WalkIn.tsx).
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { onAuthStateChanged, signInWithCustomToken, type User } from 'firebase/auth'
import { useTranslations } from 'next-intl'
import { Delete } from 'lucide-react'
import { auth } from '@/lib/firebase-auth'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import type { KioskPublicLock } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

interface Props {
  slug: string
  teamId: string
  lock: KioskPublicLock
  children: ReactNode
}

type Status = 'checking' | 'locked' | 'unlocked'

const PIN_MAX_LENGTH = 12

export default function KioskLock({ slug, teamId, lock, children }: Props) {
  const t = useTranslations('Kiosk')
  const [status, setStatus] = useState<Status>(lock.enabled ? 'checking' : 'unlocked')
  const [pin, setPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const checkClaims = useCallback(
    async (user: User | null) => {
      if (!lock.enabled) {
        setStatus('unlocked')
        return
      }
      if (!user) {
        setStatus('locked')
        return
      }
      try {
        const result = await user.getIdTokenResult()
        const claims = result.claims as { kioskTeam?: string; kioskEpoch?: number }
        const matches = claims.kioskTeam === teamId && Number(claims.kioskEpoch) === lock.epoch
        setStatus(matches ? 'unlocked' : 'locked')
      } catch (err: unknown) {
        // Fail CLOSED, and say why in the log: locking is the safe outcome, but
        // "the kiosk keeps asking for the PIN" is undiagnosable without this.
        reportPublicLoadFailure('kiosk/lock-claims', err)
        setStatus('locked')
      }
    },
    [teamId, lock.enabled, lock.epoch]
  )

  useEffect(() => {
    if (!lock.enabled) {
      setStatus('unlocked')
      return
    }
    const unsub = onAuthStateChanged(auth, (user) => {
      void checkClaims(user)
    })
    return () => unsub()
  }, [lock.enabled, checkClaims])

  const digit = (d: string) => {
    setError(null)
    setPin((p) => (p.length >= PIN_MAX_LENGTH ? p : p + d))
  }
  const backspace = () => {
    setError(null)
    setPin((p) => p.slice(0, -1))
  }
  const clearPin = () => {
    setError(null)
    setPin('')
  }

  const submit = useCallback(async () => {
    if (!pin || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const unlockKiosk = callFunction<{ slug: string; pin: string }, { token: string }>(
        'unlockKiosk'
      )
      const result = await unlockKiosk({ slug, pin })
      await signInWithCustomToken(auth, result.data.token)
      setPin('')
      // onAuthStateChanged fires from the sign-in above and re-checks claims.
    } catch {
      setError(t('lockError'))
    } finally {
      setSubmitting(false)
    }
  }, [pin, slug, submitting, t])

  if (status === 'checking') {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="h-10 w-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (status === 'unlocked') {
    return <>{children}</>
  }

  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'backspace']

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-8 bg-background px-6 text-foreground">
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-2xl font-semibold">{t('lockTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('lockPrompt')}</p>
      </div>

      <div className="flex items-center justify-center gap-3" aria-live="polite">
        {Array.from({ length: Math.max(pin.length, 4) }).map((_, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full border-2 ${
              i < pin.length ? 'border-primary bg-primary' : 'border-muted-foreground/30'
            }`}
          />
        ))}
      </div>

      {error && <p className="text-sm font-medium text-destructive">{error}</p>}

      <div className="grid grid-cols-3 gap-4">
        {digits.map((d, i) => {
          if (d === '') return <div key={`empty-${i}`} />
          if (d === 'backspace') {
            return (
              <button
                key="backspace"
                type="button"
                onClick={backspace}
                aria-label="Backspace"
                className="flex h-16 w-16 items-center justify-center rounded-full text-xl transition-colors hover:bg-muted active:bg-muted"
              >
                <Delete className="h-6 w-6" />
              </button>
            )
          }
          return (
            <button
              key={d}
              type="button"
              onClick={() => digit(d)}
              className="flex h-16 w-16 items-center justify-center rounded-full text-2xl font-semibold transition-colors hover:bg-muted active:bg-muted"
            >
              {d}
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={clearPin}
          disabled={!pin || submitting}
          className="rounded-full px-5 py-2.5 text-sm font-medium text-muted-foreground transition-opacity disabled:opacity-40"
        >
          {t('pinClear')}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!pin || submitting}
          className="rounded-full bg-primary px-8 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
        >
          {submitting ? t('loading') : t('lockSubmit')}
        </button>
      </div>
    </div>
  )
}

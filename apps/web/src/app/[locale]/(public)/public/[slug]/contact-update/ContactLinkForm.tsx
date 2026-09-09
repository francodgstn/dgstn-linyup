'use client'

/**
 * THE LINK RAIL — "you are holding a grant the studio just gave you".
 *
 * A SIBLING of ContactUpdateForm, not a mode inside it, because the two answer
 * different questions. That form asks somebody to prove they own an email
 * address before it will let them edit; this one is opened by a person the
 * studio just handed a QR to, and its entire reason for existing is the case
 * where there is no address to prove ownership of. Folding the second into the
 * first would put an `if (token)` around every one of its steps and leave the
 * two auth models sharing a state machine that suits neither.
 *
 * The token never identifies the contact in the URL — the server resolves it —
 * so this component learns who it is editing only from `resolveContactUpdateLink`.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { httpsCallable, FunctionsError } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import type { CustomFieldDefinition } from '@linyup/shared'
import { CONTACT_LINK_OTP_LENGTH } from '@linyup/shared'

interface ResolvedContact {
  firstname: string
  lastname: string
  email: string
  phone: string
  birthdate: string
  address: Record<string, string> | null
  custom_fields: Record<string, unknown>
}

interface Resolved {
  status: 'ok' | 'otp_required'
  team?: { name: string; logoUrl: string | null }
  contact?: ResolvedContact
  customFields?: CustomFieldDefinition[]
  expiresAt?: number
}

/** The server's refusal vocabulary, mapped to copy. Anything unrecognised is
 *  reported as a dead link rather than as a raw error code. */
function refusalKey(err: unknown): string {
  const code = (err as FunctionsError)?.message ?? ''
  switch (code) {
    case 'expired':
      return 'errExpired'
    case 'revoked':
      return 'errRevoked'
    case 'otp_invalid':
      return 'errCodeWrong'
    case 'too_many_attempts':
      return 'errTooManyAttempts'
    case 'too_many_submissions':
      return 'errTooManySubmissions'
    default:
      return 'errNotFound'
  }
}

export default function ContactLinkForm({ token }: { token: string }) {
  const t = useTranslations('ContactLink')
  const [state, setState] = useState<'loading' | 'otp' | 'form' | 'done' | 'dead'>('loading')
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const [otp, setOtp] = useState('')
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const resolve = useCallback(
    async (code?: string) => {
      setError(null)
      try {
        const fn = httpsCallable<{ token: string; otp?: string }, Resolved>(
          functions,
          'resolveContactUpdateLink'
        )
        const res = await fn({ token, otp: code })
        if (res.data.status === 'otp_required') {
          setState('otp')
          return
        }
        setResolved(res.data)
        const c = res.data.contact!
        setValues({
          firstname: c.firstname,
          lastname: c.lastname,
          email: c.email,
          phone: c.phone,
          birthdate: c.birthdate,
          ...Object.fromEntries(
            Object.entries(c.custom_fields ?? {}).map(([k, v]) => [`custom:${k}`, v])
          ),
        })
        setState('form')
      } catch (err) {
        const key = refusalKey(err)
        if (key === 'errCodeWrong') {
          setError(t(key))
          setState('otp')
          return
        }
        setError(t(key))
        setState('dead')
      }
    },
    [token, t]
  )

  useEffect(() => {
    void resolve()
  }, [resolve])

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const fn = httpsCallable<
        { token: string; otp?: string; values: Record<string, unknown> },
        { status: string }
      >(functions, 'submitContactUpdateLink')
      await fn({ token, otp: otp || undefined, values })
      setState('done')
    } catch (err) {
      setError(t(refusalKey(err)))
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary'
  const set = (k: string, v: unknown) => setValues((prev) => ({ ...prev, [k]: v }))

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (state === 'dead') {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-semibold">{t('linkClosed')}</h1>
          <p className="text-sm text-muted-foreground">{error ?? t('errNotFound')}</p>
          <p className="text-sm text-muted-foreground">{t('askAgain')}</p>
        </div>
      </div>
    )
  }

  if (state === 'done') {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-semibold">{t('thanksTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('thanksBody')}</p>
        </div>
      </div>
    )
  }

  if (state === 'otp') {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-4">
          <div className="space-y-1 text-center">
            <h1 className="text-lg font-semibold">{t('enterCodeTitle')}</h1>
            <p className="text-sm text-muted-foreground">{t('enterCodeBody')}</p>
          </div>
          <input
            className={`${inputClass} text-center font-mono text-2xl tracking-[0.3em]`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CONTACT_LINK_OTP_LENGTH}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="button"
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            disabled={otp.length < CONTACT_LINK_OTP_LENGTH}
            onClick={() => void resolve(otp)}
          >
            {t('continue')}
          </button>
        </div>
      </div>
    )
  }

  const contact = resolved?.contact
  return (
    <div className="mx-auto min-h-screen w-full max-w-md space-y-5 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t('formTitle')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('formBody', { team: resolved?.team?.name ?? '' })}
        </p>
      </div>

      <div className="space-y-3">
        <Field label={t('firstname')}>
          <input
            className={inputClass}
            value={String(values.firstname ?? '')}
            onChange={(e) => set('firstname', e.target.value)}
          />
        </Field>
        <Field label={t('lastname')}>
          <input
            className={inputClass}
            value={String(values.lastname ?? '')}
            onChange={(e) => set('lastname', e.target.value)}
          />
        </Field>
        {/* The point of the exercise. Highlighted when there is nothing on file,
            because that is the one field the studio actually needs from most
            people — and an unmarked empty box gets skipped. */}
        <Field label={t('email')} hint={!contact?.email ? t('emailHint') : undefined}>
          <input
            className={inputClass}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={String(values.email ?? '')}
            onChange={(e) => set('email', e.target.value)}
          />
        </Field>
        <Field label={t('phone')}>
          <input
            className={inputClass}
            type="tel"
            autoComplete="tel"
            value={String(values.phone ?? '')}
            onChange={(e) => set('phone', e.target.value)}
          />
        </Field>
        <Field label={t('birthdate')}>
          <input
            className={inputClass}
            type="date"
            value={String(values.birthdate ?? '')}
            onChange={(e) => set('birthdate', e.target.value)}
          />
        </Field>

        {(resolved?.customFields ?? []).map((def) => (
          <Field key={def.id} label={def.label}>
            {def.type === 'select' ? (
              <select
                className={inputClass}
                value={String(values[`custom:${def.id}`] ?? '')}
                onChange={(e) => set(`custom:${def.id}`, e.target.value)}
              >
                <option value="">—</option>
                {(def.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={inputClass}
                type={def.type === 'number' ? 'number' : 'text'}
                value={String(values[`custom:${def.id}`] ?? '')}
                onChange={(e) => set(`custom:${def.id}`, e.target.value)}
              />
            )}
          </Field>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="button"
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? t('saving') : t('save')}
      </button>

      <p className="text-center text-xs text-muted-foreground">{t('privacyNote')}</p>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

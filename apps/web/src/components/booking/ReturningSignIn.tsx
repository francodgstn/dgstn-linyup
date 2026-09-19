'use client'

// Shared "returning visitor" passwordless sign-in — email → 6-digit code →
// (optional) matched-contact selection — used by both the class BookingForm
// and the appointment picker's booking modal. Moved out of BookingForm.tsx
// verbatim (same three steps, same callables, same countdown/resend
// mechanics); manages its own step state internally and only ever reports
// back UP through `onVerified` once a contact is confirmed.
//
// Flow-specific post-verify logic (subscription coverage checks, drop-in
// fallback for classes; price resolution + pay-vs-free routing for
// appointments) is NOT this component's concern — it lives in each caller's
// `onVerified`. If `onVerified` throws, the thrown error's `.message` is
// shown on the CURRENT step (matching the original inline behaviour where a
// booking failure surfaced right there on the code/select screen). A thrown
// error with `.code === 'already-exists'` gets the shared "already
// registered" copy, same as a bad-code rejection from the server.

import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { callFunction } from '@/lib/callFunction'

export interface MatchedContact {
  id: string
  firstname: string
  lastname: string
  phone: string
}

export interface ContactData {
  id: string
  firstname: string
  lastname: string
  email: string
  phone: string
  /** Subscription-type ids the contact holds (live subs, primary snapshot,
   *  valid credit packs) — returned by verifyBookingCode. */
  held_subscription_type_ids?: string[]
}

function createEmailSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({ email: z.string().email(t('errorInvalidEmailAddress')) })
}
function createCodeSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({ code: z.string().regex(/^\d{6}$/, t('errorEnterCode')) })
}
type EmailValues = z.infer<ReturnType<typeof createEmailSchema>>
type CodeValues = z.infer<ReturnType<typeof createCodeSchema>>

type Step = 'email' | 'code' | 'select'

export interface ReturningSignInProps {
  teamId: string
  onVerified: (result: {
    contactId: string
    verificationCodeId: string
    contactData: ContactData
  }) => void | Promise<void>
  /** Exits the whole sign-in flow (back to whatever screen led here). */
  onBack: () => void
  accentColor?: string | null
  /** Shown when no account matches the entered email. Caller-supplied so each
   *  flow can pick its own wording. */
  noAccountMessage: string
  /**
   * Replaces the "Welcome back" heading on the email step.
   *
   * A members-only class lands a NEWCOMER here, and "Welcome back" is exactly
   * the wrong thing to tell someone who has never been — it reads as a dead end
   * rather than an offer. The caller reframes it and explains the gate.
   */
  title?: string
  subtitle?: string
  /** Rendered between the heading and the email form (e.g. what unlocks this class). */
  intro?: React.ReactNode
}

// Same visual weight as BioLinkButton — duplicated here (not imported) since
// this component is shared outside the bio-link route subtree.
function PrimaryButton({
  children,
  disabled,
  accentColor,
}: {
  children: React.ReactNode
  disabled?: boolean
  accentColor?: string | null
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      style={accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}
      className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 text-sm"
    >
      {children}
    </button>
  )
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      type="button"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
    >
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
      </svg>
      {label}
    </button>
  )
}

export function ReturningSignIn({
  teamId,
  onVerified,
  onBack,
  accentColor,
  noAccountMessage,
  title,
  subtitle,
  intro,
}: ReturningSignInProps) {
  const t = useTranslations('PublicBooking')
  const emailSchema = createEmailSchema(t)
  const codeSchema = createCodeSchema(t)
  const emailForm = useForm<EmailValues>({ resolver: zodResolver(emailSchema) })
  const codeForm = useForm<CodeValues>({ resolver: zodResolver(codeSchema) })

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [codeId, setCodeId] = useState('')
  const [matchedContacts, setMatchedContacts] = useState<MatchedContact[]>([])
  const [selectingContactId, setSelectingContactId] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (countdown <= 0) return
    const timeoutId = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timeoutId)
  }, [countdown])

  // Runs the caller's post-verify logic and surfaces a thrown error on the
  // current step — mirrors the original inline try/catch that wrapped both
  // the verify call and the booking call in one block.
  async function runVerified(
    contactId: string,
    verificationCodeId: string,
    contactData: ContactData,
    fallbackMessage: string
  ) {
    try {
      await onVerified({ contactId, verificationCodeId, contactData })
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string }
      if (e.code === 'already-exists') {
        setError(t('errorAlreadyRegistered'))
      } else {
        setError(e.message || fallbackMessage)
      }
    }
  }

  const onSendCode = async (values: EmailValues) => {
    setError(null)
    try {
      const fn = callFunction<{ email: string; teamId: string }, { codeId: string; hasContacts?: boolean }>(
        'sendBookingVerificationCode'
      )
      const result = await fn({ email: values.email, teamId })
      if (result.data.hasContacts === false) {
        setError(noAccountMessage)
        return
      }
      setEmail(values.email)
      setCodeId(result.data.codeId)
      setCountdown(60)
      setStep('code')
    } catch (err: unknown) {
      const e = err as { message?: string }
      setError(e.message || t('errorSendCodeFailed'))
    }
  }

  const onVerifyCode = async (values: CodeValues) => {
    setError(null)
    try {
      const fn = callFunction<
        { codeId: string; code: string },
        {
          verified: boolean
          codeId: string
          requiresContactSelection: boolean
          selectedContactId?: string
          contactData?: ContactData
          matchedContacts?: MatchedContact[]
        }
      >('verifyBookingCode')
      const result = await fn({ codeId, code: values.code })

      if (result.data.requiresContactSelection) {
        setMatchedContacts(result.data.matchedContacts ?? [])
        setStep('select')
        return
      }
      const contactId = result.data.selectedContactId!
      await runVerified(contactId, result.data.codeId, result.data.contactData!, t('errorIncorrectCode'))
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string }
      if (e.code === 'already-exists') {
        setError(t('errorAlreadyRegistered'))
      } else {
        setError(e.message || t('errorIncorrectCode'))
      }
    }
  }

  const onSelectContact = async (contactId: string) => {
    setError(null)
    setSelectingContactId(contactId)
    try {
      const fn = callFunction<
        { codeId: string; selectedContactId: string },
        { verified: boolean; codeId: string; selectedContactId?: string; contactData?: ContactData }
      >('verifyBookingCode')
      const result = await fn({ codeId, selectedContactId: contactId })
      await runVerified(
        result.data.selectedContactId!,
        result.data.codeId,
        result.data.contactData!,
        t('errorSelectContactFailed')
      )
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string }
      if (e.code === 'already-exists') {
        setError(t('errorAlreadyRegistered'))
      } else {
        setError(e.message || t('errorSelectContactFailed'))
      }
    } finally {
      setSelectingContactId(null)
    }
  }

  const onResendCode = async () => {
    if (countdown > 0) return
    setError(null)
    try {
      const fn = callFunction<{ email: string; teamId: string }, { codeId: string }>(
        'sendBookingVerificationCode'
      )
      const result = await fn({ email, teamId })
      setCodeId(result.data.codeId)
      setCountdown(60)
      codeForm.reset()
    } catch (err: unknown) {
      const e = err as { message?: string }
      setError(e.message || t('errorResendCodeFailed'))
    }
  }

  if (step === 'email') {
    return (
      <>
        <div>
          <BackButton label={t('back')} onClick={onBack} />
          <h1 className="text-2xl font-bold">{title ?? t('welcomeBackTitle')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {subtitle ?? t('welcomeBackSubtitle')}
          </p>
        </div>

        {intro}

        <form onSubmit={emailForm.handleSubmit(onSendCode)} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">{t('labelEmailAddress')}</label>
            <input
              type="email"
              {...emailForm.register('email')}
              autoComplete="email"
              placeholder={t('placeholderEmailExample')}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {emailForm.formState.errors.email && (
              <p className="text-xs text-destructive">{emailForm.formState.errors.email.message}</p>
            )}
          </div>
          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <PrimaryButton disabled={emailForm.formState.isSubmitting} accentColor={accentColor}>
            {emailForm.formState.isSubmitting ? t('sendingEllipsis') : t('sendVerificationCode')}
          </PrimaryButton>
        </form>
      </>
    )
  }

  if (step === 'code') {
    return (
      <>
        <div>
          <BackButton
            label={t('back')}
            onClick={() => {
              setStep('email')
              setError(null)
              codeForm.reset()
            }}
          />
          <h1 className="text-2xl font-bold">{t('checkEmailTitle')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('sentCodeTo')} <strong>{email}</strong>
          </p>
        </div>

        <form onSubmit={codeForm.handleSubmit(onVerifyCode)} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">{t('labelVerificationCode')}</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              {...codeForm.register('code', {
                onChange: (e) => {
                  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6)
                },
              })}
              placeholder={t('placeholderCode')}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm text-center tracking-widest text-lg font-mono focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {codeForm.formState.errors.code && (
              <p className="text-xs text-destructive">{codeForm.formState.errors.code.message}</p>
            )}
          </div>
          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <PrimaryButton disabled={codeForm.formState.isSubmitting} accentColor={accentColor}>
            {codeForm.formState.isSubmitting ? t('verifyingEllipsis') : t('confirmBookingCta')}
          </PrimaryButton>
        </form>

        <div className="text-center">
          <button
            onClick={onResendCode}
            disabled={countdown > 0}
            className="text-sm text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
          >
            {countdown > 0 ? t('resendIn', { countdown }) : t('resendPrompt')}
          </button>
        </div>
      </>
    )
  }

  // step === 'select'
  return (
    <>
      <div>
        <BackButton label={t('back')} onClick={() => setStep('code')} />
        <h1 className="text-2xl font-bold">{t('titleWhosBooking')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('multipleProfilesFound')}</p>
      </div>
      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="space-y-3">
        {matchedContacts.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelectContact(c.id)}
            disabled={selectingContactId === c.id}
            className="w-full text-left rounded-xl border bg-card p-4 hover:border-primary hover:bg-primary/5 transition-colors disabled:opacity-50"
          >
            <p className="font-semibold text-sm">
              {c.firstname} {c.lastname}
            </p>
            {c.phone && <p className="text-xs text-muted-foreground mt-0.5">{c.phone}</p>}
          </button>
        ))}
      </div>
    </>
  )
}

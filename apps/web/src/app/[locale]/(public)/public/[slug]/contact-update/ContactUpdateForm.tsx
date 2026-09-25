'use client'

import { useState, useEffect, useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import type { PublicFrom } from '@linyup/shared'
import { Link } from '@/i18n/navigation'
import { publicHref, returnHref } from '@/lib/publicRoutes'
import { BioLinkShell, BioLinkButton } from '../BioLinkShell'
import { usePublicTeam } from '../PublicTeamProvider'
import { callFunction } from '@/lib/callFunction'

// ─── steps ───────────────────────────────────────────────────────────────────

type Step = 'loading' | 'not-found' | 'email' | 'code' | 'form' | 'success'

// ─── schemas ─────────────────────────────────────────────────────────────────

function createEmailSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({
    email: z.string().email(t('errorInvalidEmailAddress')),
  })
}

function createCodeSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({
    code: z.string().regex(/^\d{6}$/, t('errorEnterCode')),
  })
}

function createDetailsSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({
    firstname: z.string().min(1, t('errorRequired')).max(60),
    lastname: z.string().min(1, t('errorRequired')).max(60),
    phone: z.string().max(30).optional(),
    birthdate: z.string().optional(),
    note: z.string().max(500).optional(),
  })
}

type EmailValues = z.infer<ReturnType<typeof createEmailSchema>>
type CodeValues = z.infer<ReturnType<typeof createCodeSchema>>
type DetailsValues = z.infer<ReturnType<typeof createDetailsSchema>>

// ─── component ───────────────────────────────────────────────────────────────

interface Props {
  slug: string
  contactId: string
  /** `?from=` — which surface to return to. See `returnHref`. */
  from?: PublicFrom
}

export default function ContactUpdateForm({ slug, contactId, from }: Props) {
  // Team already resolved once by the parent PublicTeamProvider (the layout).
  const { teamId, team } = usePublicTeam()
  const t = useTranslations('PublicContactUpdate')
  const tSurfaces = useTranslations('PublicSurfaceLinks')
  // Where 'back' goes: the surface named by `?from=`, else whatever default the
  // studio chose (bio-link, website, shop, …). Labeled to match, and resolved
  // here rather than by bouncing through the team root's client redirect.
  const backTo = returnHref(team, slug, from)
  const teamName = team.name || slug
  const accentColor = team.bioLinkAccentColor ?? null
  const showBranding = team.showBranding === true

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [codeId, setCodeId] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Countdown timer for resend button
  useEffect(() => {
    if (countdown <= 0) return
    const timeoutId = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timeoutId)
  }, [countdown])

  const emailSchema = useMemo(() => createEmailSchema(t), [t])
  const codeSchema = useMemo(() => createCodeSchema(t), [t])
  const detailsSchema = useMemo(() => createDetailsSchema(t), [t])

  // ── Email step ──────────────────────────────────────────────────────────────

  const emailForm = useForm<EmailValues>({ resolver: zodResolver(emailSchema) })

  const onSendCode = async (values: EmailValues) => {
    if (!teamId) return
    setError(null)
    try {
      const fn = callFunction<{ email: string; teamId: string }, { codeId: string }>(
        'sendContactVerificationCode'
      )
      const result = await fn({ email: values.email, teamId })
      setEmail(values.email)
      setCodeId(result.data.codeId)
      setCountdown(60)
      setStep('code')
    } catch (err: unknown) {
      const e = err as { message?: string }
      setError(e.message || t('errorSendCodeFailed'))
    }
  }

  // ── Code step ───────────────────────────────────────────────────────────────

  const codeForm = useForm<CodeValues>({ resolver: zodResolver(codeSchema) })

  const onVerifyCode = async (values: CodeValues) => {
    setError(null)
    try {
      const fn = callFunction<{ codeId: string; code: string }, { verified: boolean }>(
        'verifyContactCode'
      )
      await fn({ codeId, code: values.code })
      setStep('form')
    } catch (err: unknown) {
      const e = err as { message?: string }
      setError(e.message || t('errorIncorrectCode'))
    }
  }

  const onResendCode = async () => {
    if (countdown > 0 || !teamId) return
    setError(null)
    try {
      const fn = callFunction<{ email: string; teamId: string }, { codeId: string }>(
        'sendContactVerificationCode'
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

  // ── Details step ────────────────────────────────────────────────────────────

  const detailsForm = useForm<DetailsValues>({ resolver: zodResolver(detailsSchema) })

  const onSubmitDetails = async (values: DetailsValues) => {
    if (!teamId) return
    setError(null)
    try {
      const fn = callFunction<
        {
          codeId: string
          contactId: string
          teamId: string
          contactDetails: Omit<DetailsValues, 'note'>
          note?: string
        },
        { success: boolean; requestId: string }
      >('requestContactUpdate')

      await fn({
        codeId,
        contactId,
        teamId,
        contactDetails: {
          firstname: values.firstname,
          lastname: values.lastname,
          phone: values.phone || undefined,
          birthdate: values.birthdate || undefined,
        },
        note: values.note || undefined,
      })
      setStep('success')
    } catch (err: unknown) {
      const e = err as { message?: string }
      setError(e.message || t('errorSubmitUpdateFailed'))
    }
  }

  // ── Shared field styling ────────────────────────────────────────────────────

  const inputClass =
    'w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary'

  // ── Render: loading ─────────────────────────────────────────────────────────

  if (step === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (step === 'not-found') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <p className="text-lg font-semibold">{t('teamNotFoundTitle')}</p>
          <p className="text-muted-foreground text-sm">{t('teamNotFoundBody')}</p>
        </div>
      </div>
    )
  }

  // ── Render: email step ──────────────────────────────────────────────────────

  if (step === 'email') {
    return (
      <BioLinkShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        showBranding={showBranding}
      >
        <div>
          <h1 className="text-2xl font-bold">{t('titleUpdateYourDetails')}</h1>
          <p className="text-muted-foreground mt-1">
            {t.rich('verifyEmailSubtitle', { teamName, strong: (chunks) => <strong>{chunks}</strong> })}
          </p>
        </div>

        <form onSubmit={emailForm.handleSubmit(onSendCode)} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">{t('labelEmailAddress')}</label>
            <input
              type="email"
              {...emailForm.register('email')}
              autoComplete="email"
              placeholder={t('placeholderEmailExample')}
              className={inputClass}
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

          <BioLinkButton
            type="submit"
            disabled={emailForm.formState.isSubmitting}
            accentColor={accentColor}
          >
            {emailForm.formState.isSubmitting ? t('sendingEllipsis') : t('sendVerificationCode')}
          </BioLinkButton>
        </form>
      </BioLinkShell>
    )
  }

  // ── Render: code step ───────────────────────────────────────────────────────

  if (step === 'code') {
    return (
      <BioLinkShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        showBranding={showBranding}
      >
        <div>
          <button
            onClick={() => {
              setStep('email')
              setError(null)
            }}
            className="text-sm text-muted-foreground hover:text-foreground mb-4 flex items-center gap-1"
          >
            {t('backArrow')}
          </button>
          <h1 className="text-2xl font-bold">{t('checkEmailTitle')}</h1>
          <p className="text-muted-foreground mt-1">
            {t.rich('sentCodeTo', { email, strong: (chunks) => <strong>{chunks}</strong> })}
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
              className={`${inputClass} text-center tracking-widest text-lg font-mono`}
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

          <BioLinkButton
            type="submit"
            disabled={codeForm.formState.isSubmitting}
            accentColor={accentColor}
          >
            {codeForm.formState.isSubmitting ? t('verifyingEllipsis') : t('verifyCode')}
          </BioLinkButton>
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
      </BioLinkShell>
    )
  }

  // ── Render: details form ────────────────────────────────────────────────────

  if (step === 'form') {
    return (
      <BioLinkShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        showBranding={showBranding}
      >
        <div>
          <h1 className="text-2xl font-bold">{t('yourDetailsTitle')}</h1>
          <p className="text-muted-foreground mt-1">{t('detailsSubtitle')}</p>
        </div>

        {/* Info banner */}
        <div className="rounded-lg bg-blue-50 border border-blue-200 dark:bg-blue-950/20 dark:border-blue-800 px-4 py-3 text-sm text-blue-800 dark:text-blue-300">
          {t('infoBannerText')}
        </div>

        <form onSubmit={detailsForm.handleSubmit(onSubmitDetails)} className="space-y-4">
          {/* Email read-only */}
          <div className="space-y-1">
            <label className="text-sm font-medium">{t('labelEmail')}</label>
            <input
              type="email"
              value={email}
              disabled
              className="w-full rounded-lg border bg-muted px-3 py-2 text-sm text-muted-foreground"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">
                {t('labelFirstName')} <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                {...detailsForm.register('firstname')}
                autoComplete="given-name"
                className={inputClass}
              />
              {detailsForm.formState.errors.firstname && (
                <p className="text-xs text-destructive">
                  {detailsForm.formState.errors.firstname.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                {t('labelLastName')} <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                {...detailsForm.register('lastname')}
                autoComplete="family-name"
                className={inputClass}
              />
              {detailsForm.formState.errors.lastname && (
                <p className="text-xs text-destructive">
                  {detailsForm.formState.errors.lastname.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('labelPhone')} <span className="text-muted-foreground font-normal">{t('optionalSuffix')}</span>
            </label>
            <input
              type="tel"
              {...detailsForm.register('phone')}
              autoComplete="tel"
              className={inputClass}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('labelDateOfBirth')} <span className="text-muted-foreground font-normal">{t('optionalSuffix')}</span>
            </label>
            <input type="date" {...detailsForm.register('birthdate')} className={inputClass} />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('labelNoteForManager')}{' '}
              <span className="text-muted-foreground font-normal">{t('optionalSuffix')}</span>
            </label>
            <textarea
              {...detailsForm.register('note')}
              rows={3}
              placeholder={t('placeholderNoteExample')}
              className={`${inputClass} resize-none`}
            />
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <BioLinkButton
            type="submit"
            disabled={detailsForm.formState.isSubmitting}
            accentColor={accentColor}
          >
            {detailsForm.formState.isSubmitting ? t('submittingEllipsis') : t('submitUpdateRequest')}
          </BioLinkButton>
        </form>
      </BioLinkShell>
    )
  }

  // ── Render: success ─────────────────────────────────────────────────────────

  return (
    <BioLinkShell
      teamName={teamName}
      slug={slug}
      accentColor={accentColor}
      showBranding={showBranding}
    >
      <div className="space-y-6 text-center py-8">
        <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
          <svg
            className="w-8 h-8 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold">{t('requestSubmittedTitle')}</h1>
          <p className="text-muted-foreground mt-2">
            {t.rich('requestSubmittedBody', {
              teamName,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        </div>
        <div className="space-y-2">
          {/* Their personal portal — where membership, bookings and courses live. */}
          <Link
            href={publicHref(slug, 'space')}
            className="block text-sm font-medium text-primary hover:underline"
          >
            {t('openSpace')}
          </Link>
          <Link
            href={backTo.href}
            className="block text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            {t('toSurface', { name: tSurfaces(backTo.surface) })}
          </Link>
        </div>
      </div>
    </BioLinkShell>
  )
}

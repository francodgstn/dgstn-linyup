'use client'

import { useState, useEffect, useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useLocale, useTranslations } from 'next-intl'
import { CONTACTS_COLLECTION, type PublicFrom } from '@linyup/shared'
import { Link } from '@/i18n/navigation'
import { publicHref, returnHref } from '@/lib/publicRoutes'
import { useWaiverGate } from '@/hooks/useWaiverGate'
import { waiverErrorMessage } from '@/lib/waiver'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { WaiverStep } from '@/components/booking/WaiverStep'
import { BioLinkShell, BioLinkButton } from '../BioLinkShell'
import { usePublicTeam } from '../PublicTeamProvider'
import { usePublicContactAuth } from '../PublicContactAuthProvider'
import { callFunction } from '@/lib/callFunction'

// ─── steps ───────────────────────────────────────────────────────────────────

type Step = 'email' | 'code' | 'details' | 'success'

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
    // Never pre-ticked — Meta-required consent, not a default. Sent to
    // `completeSignup` only when true (contactDetails.whatsappOptIn).
    whatsappOptIn: z.boolean().optional(),
    // The second, independent answer — "news and offers" — sent only when true
    // (contactDetails.whatsappMarketingOptIn). Same gate as the box above.
    whatsappMarketingOptIn: z.boolean().optional(),
    birthdate: z.string().optional(),
    notes: z.string().max(500).optional(),
    privacyConsent: z.literal(true, {
      errorMap: () => ({ message: t('errorPrivacyPolicyRequired') }),
    }),
  })
}

type EmailValues = z.infer<ReturnType<typeof createEmailSchema>>
type CodeValues = z.infer<ReturnType<typeof createCodeSchema>>
type DetailsValues = z.infer<ReturnType<typeof createDetailsSchema>>

// ─── component ───────────────────────────────────────────────────────────────

interface Props {
  slug: string
  /** `?from=` — which surface to return to. See `returnHref`. */
  from?: PublicFrom
}

export default function SignupForm({ slug, from }: Props) {
  // Team already resolved once by the parent PublicTeamProvider (the layout).
  const { teamId, team } = usePublicTeam()
  // A live contact session skips the email+OTP steps entirely: the session was
  // itself minted by the same OTP flow, so re-verifying the inbox is pure friction.
  const { isAuthenticated, contact: sessionContact } = usePublicContactAuth()
  const t = useTranslations('PublicSignup')
  const tSurfaces = useTranslations('PublicSurfaceLinks')
  const tWaiver = useTranslations('Waiver')
  const locale = useLocale()
  // Where 'back' goes: the surface named by `?from=`, else whatever default the
  // studio chose (bio-link, website, shop, …). Labeled to match, and resolved
  // here rather than by bouncing through the team root's client redirect.
  const backTo = returnHref(team, slug, from)
  const teamName = team.name || ''
  const accentColor = team.bioLinkAccentColor ?? null
  const showBranding = team.showBranding === true
  // Documents the studio attached to signup consent (documents plugin config,
  // denormalized onto TeamPublicProfile by syncTeamPublicProfile). Empty/absent
  // falls back to the plain consent text below — no regression for teams without
  // the plugin installed.
  const signupDocs = team.signup_documents ?? []
  // The studio's own WhatsApp number is connected — offer the opt-in beside
  // the phone question. `TeamPublicProfile.whatsapp_opt_in_offered` already
  // means "plugin installed AND a number connected" (syncTeamPublicProfile).
  const whatsappOptInOffered = team.whatsapp_opt_in_offered === true

  // A required waiver gets its OWN tick on this rail, never a link bundled into
  // the consent sentence beside a privacy policy — that is the weakest possible
  // presentation of the strongest possible document. Inert (no network call at
  // all) for every team that requires nothing, which is every team on the day
  // this ships.
  //
  // `activityId: null` on purpose: signup books nothing, so only the
  // every-booking waivers resolve here. An activities-scoped one is presented at
  // the booking step, where the activity is known.
  const waiverGate = useWaiverGate({
    teamId: teamId ?? null,
    requiredWaivers: team.required_waivers ?? null,
    activityId: null,
  })

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [codeId, setCodeId] = useState('')
  // Retained after a successful verify so completeSignup can re-present the code
  // (defense in depth: ties completion to knowledge of the code, not just codeId).
  const [verifiedCode, setVerifiedCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // Arriving from a 'full'-mode shop purchase (pay/result CTA): the buyer already paid
  // and we have their email — prefill it and reframe the flow as "finishing" signup.
  const [fromCheckout, setFromCheckout] = useState(false)

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const emailSchema = useMemo(() => createEmailSchema(t), [t])
  const codeSchema = useMemo(() => createCodeSchema(t), [t])
  const detailsSchema = useMemo(() => createDetailsSchema(t), [t])

  const emailForm = useForm<EmailValues>({ resolver: zodResolver(emailSchema) })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('from') === 'checkout') setFromCheckout(true)
    const prefill = params.get('email')
    if (prefill) {
      setEmail(prefill)
      emailForm.setValue('email', prefill)
    }
  }, [emailForm])
  const codeForm = useForm<CodeValues>({ resolver: zodResolver(codeSchema) })
  const detailsForm = useForm<DetailsValues>({ resolver: zodResolver(detailsSchema) })

  // Signed-in contact → jump straight to the details step with names prefilled
  // (completeSignup runs against the session, no code needed). If their signup is
  // ALREADY complete (signup_completed_at on their own contact doc — rules allow
  // self-read), skip the form entirely and land on the success view: don't re-ask
  // details + consent they already gave (e.g. arriving via a stale post-checkout
  // link). Only from the email/code steps — never yank the user out of an
  // in-progress details form.
  useEffect(() => {
    if (!isAuthenticated || !sessionContact) return
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDoc(doc(db, CONTACTS_COLLECTION, sessionContact.id))
        if (!cancelled && snap.data()?.signup_completed_at) {
          setStep((s) => (s === 'email' || s === 'code' ? 'success' : s))
          return
        }
      } catch (err: unknown) {
        // Falls through to the normal details step, which is the right default
        // either way — but a self-read that fails for everyone would otherwise
        // be invisible, since its success path only ever SKIPS a step.
        reportPublicLoadFailure('signup/self-contact', err)
      }
      if (cancelled) return
      setStep((s) => (s === 'email' || s === 'code' ? 'details' : s))
      if (!detailsForm.getValues('firstname')) detailsForm.setValue('firstname', sessionContact.firstname ?? '')
      if (!detailsForm.getValues('lastname')) detailsForm.setValue('lastname', sessionContact.lastname ?? '')
    })()
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, sessionContact, detailsForm])

  // ── Email step ─────────────────────────────────────────────────────────────

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

  // ── Code step ──────────────────────────────────────────────────────────────

  const onVerifyCode = async (values: CodeValues) => {
    setError(null)
    try {
      const fn = callFunction<{ codeId: string; code: string }, { verified: boolean }>(
        'verifyContactCode'
      )
      await fn({ codeId, code: values.code })
      setVerifiedCode(values.code)
      setStep('details')
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

  // ── Details step ───────────────────────────────────────────────────────────

  const onSubmitDetails = async (values: DetailsValues) => {
    setError(null)

    // THE CONSENT STEP, interposed between the details form and the call.
    //
    // `ensure()` resolves the requirement for THIS person and returns false when
    // there is something to read — the step then renders and its own Confirm
    // re-enters this same function, which is why there is no second submit path
    // to keep in sync.
    //
    // The identity handed over is the one this rail actually has: the address
    // the visitor verified (or their session's contact) plus the names they just
    // typed, resolved by the same email+name predicate the booking rails use.
    if (waiverGate.applies) {
      const clear = await waiverGate.ensure({
        ...(sessionContact?.id ? { contactId: sessionContact.id } : {}),
        email,
        firstname: values.firstname,
        lastname: values.lastname,
      })
      if (!clear) return
    }

    try {
      const fn = callFunction<
        {
          codeId?: string
          code?: string
          teamId?: string
          contactDetails: Omit<DetailsValues, 'privacyConsent'> & { privacyConsent: boolean }
          acceptedDocuments?: Array<{
            documentId?: string
            slug?: string
            kind?: string
            version?: string | number
          }>
          waiverAcceptances?: unknown
          locale?: string
        },
        { success: boolean }
      >('completeSignup')

      await fn({
        // Session path (signed-in contact, no OTP round-trip) vs. anonymous code path.
        ...(isAuthenticated && !codeId ? { teamId: teamId ?? undefined } : { codeId, code: verifiedCode }),
        contactDetails: {
          firstname: values.firstname,
          lastname: values.lastname,
          phone: values.phone || undefined,
          ...(values.whatsappOptIn === true ? { whatsappOptIn: true } : {}),
          ...(values.whatsappMarketingOptIn === true ? { whatsappMarketingOptIn: true } : {}),
          birthdate: values.birthdate || undefined,
          notes: values.notes || undefined,
          privacyConsent: true,
        },
        // WHICH documents were shown and at WHICH version — the two facts that
        // turn this tick into a real acceptance event. `version: ''` used to go
        // here for every document, which is why the old record recorded nothing.
        // A document with no version (published before versioning existed and not
        // yet backfilled) still renders its link; the server writes no row for it
        // rather than inventing one.
        acceptedDocuments:
          signupDocs.length > 0
            ? signupDocs.map((d) => ({
                documentId: d.documentId,
                slug: d.slug,
                kind: d.kind,
                ...(typeof d.version === 'number' ? { version: d.version } : {}),
              }))
            : undefined,
        ...(waiverGate.acceptances.length > 0
          ? { waiverAcceptances: waiverGate.acceptances }
          : {}),
        locale,
      })
      setStep('success')
    } catch (err: unknown) {
      // A waiver refusal is not a dead end: it names a reason with its own
      // sentence, and the step is already on screen to act on it — EXCEPT when
      // the team's public mirror was stale-empty, in which case `applies` was
      // false, no step was ever presented, and the sentence would be all this
      // visitor ever got. `recover` forces the resolve and puts the step under
      // the message; it renders in place above this same submit.
      const waiverMessage = waiverErrorMessage(err, tWaiver)
      if (
        waiverMessage &&
        (await waiverGate.recover(err, {
          ...(sessionContact?.id ? { contactId: sessionContact.id } : {}),
          email,
          firstname: values.firstname,
          lastname: values.lastname,
        }))
      ) {
        setError(waiverMessage)
        return
      }
      const e = err as { message?: string }
      setError(waiverMessage ?? e.message ?? t('errorCompleteSignupFailed'))
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  if (step === 'email') {
    return (
      <BioLinkShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        showBranding={showBranding}
      >
        <div>
          <h1 className="text-2xl font-bold">
            {fromCheckout ? t('finishRegistrationTitle') : t('registerAtTeamTitle', { teamName })}
          </h1>
          <p className="text-muted-foreground mt-1">
            {fromCheckout
              ? t('paymentReceivedSubtitle', { teamName })
              : t('enterEmailSubtitle')}
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
          <h1 className="text-2xl font-bold">{t('checkYourEmailTitle')}</h1>
          <p className="text-muted-foreground mt-1">
            {t.rich('codeSentTo', { email, strong: (chunks) => <strong>{chunks}</strong> })}
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

  if (step === 'details') {
    return (
      <BioLinkShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        showBranding={showBranding}
      >
        <div>
          <h1 className="text-2xl font-bold">{t('yourDetailsTitle')}</h1>
          <p className="text-muted-foreground mt-1">
            {t.rich('detailsSubtitle', { teamName, strong: (chunks) => <strong>{chunks}</strong> })}
          </p>
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
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
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
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
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
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {/* Never pre-ticked — this is Meta-required consent, not a default.
              Two separate answers, same gate: reminders vs. news and offers. */}
          {whatsappOptInOffered && (
            <>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  {...detailsForm.register('whatsappOptIn')}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-primary"
                />
                <span className="text-muted-foreground">{t('whatsappOptInLabel', { teamName })}</span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  {...detailsForm.register('whatsappMarketingOptIn')}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-primary"
                />
                <span className="text-muted-foreground">{t('whatsappMarketingOptInLabel', { teamName })}</span>
              </label>
            </>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('labelDateOfBirth')} <span className="text-muted-foreground font-normal">{t('optionalSuffix')}</span>
            </label>
            <input
              type="date"
              {...detailsForm.register('birthdate')}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('labelAnythingElse')} <span className="text-muted-foreground font-normal">{t('optionalSuffix')}</span>
            </label>
            <textarea
              {...detailsForm.register('notes')}
              rows={3}
              placeholder={t('placeholderNotes')}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
          </div>

          <div className="space-y-1">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                {...detailsForm.register('privacyConsent')}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-primary"
              />
              <span className="text-sm text-muted-foreground">
                {t('consentBase', { teamName })}
                {signupDocs.length > 0 && (
                  <>
                    {' '}
                    {t('andAcceptThe')}
                    {' '}
                    {signupDocs.map((d, i) => (
                      <span key={d.slug}>
                        {i > 0 && (i === signupDocs.length - 1 ? t('listAndSeparator') : ', ')}
                        <a
                          href={`/public/${slug}/documents/${d.slug}`}
                          target="_blank"
                          rel="noopener"
                          className="underline hover:text-foreground"
                        >
                          {d.title}
                        </a>
                      </span>
                    ))}
                  </>
                )}
                .
              </span>
            </label>
            {detailsForm.formState.errors.privacyConsent && (
              <p className="text-xs text-destructive">
                {detailsForm.formState.errors.privacyConsent.message}
              </p>
            )}
          </div>

          {/* The consent step, rendered in place above the submit rather than as
              a separate screen: this rail has ONE terminal submit, and the same
              button confirms both halves. It appears only after `ensure()` has
              answered, so a team that requires nothing never sees a flicker. */}
          {waiverGate.presented && (
            <div className="rounded-xl border p-4">
              <WaiverStep
                gate={waiverGate}
                teamName={teamName}
                disabled={detailsForm.formState.isSubmitting}
              />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <BioLinkButton
            type="submit"
            disabled={
              detailsForm.formState.isSubmitting ||
              waiverGate.loading ||
              // Disabled rather than submitting-and-being-refused: the remaining
              // actions (a parent's emailed link, an address that bounced) cannot
              // be completed by ticking here, and a button that fails is worse
              // than one that waits.
              (waiverGate.presented && !waiverGate.ready)
            }
            accentColor={accentColor}
          >
            {detailsForm.formState.isSubmitting ? t('savingEllipsis') : t('completeRegistration')}
          </BioLinkButton>
        </form>
      </BioLinkShell>
    )
  }

  // ── Success ─────────────────────────────────────────────────────────────────

  return (
    <BioLinkShell
      teamName={teamName}
      slug={slug}
      accentColor={accentColor}
      showBranding={showBranding}
    >
      <div className="py-8 text-center space-y-5">
        <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
          <svg
            className="w-8 h-8 text-green-600 dark:text-green-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold">{t('registeredTitle')}</h1>
          <p className="text-muted-foreground mt-2">
            {t.rich('successBody', { teamName, strong: (chunks) => <strong>{chunks}</strong> })}
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

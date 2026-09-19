'use client'

// The landing page for a team invitation email.
//
// Token-only, like /public/event-invitation — the secret in the URL IS the
// authorization, so there is no tenant slug to resolve and no contact session.
// It differs from that sibling in one way that shapes the whole page: accepting
// WRITES a team_members doc, so `acceptTeamInvitation` requires a real Firebase
// Auth user. The details call does not, which is why the invitation is shown
// first and sign-in is asked for only at the point of accepting — a stranger
// should be able to see what they are being invited to before being told to
// authenticate.

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import type { Route } from 'next'
import { reportPublicLoadFailure, reportPublicActionFailure } from '@/lib/publicQueryError'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { Users, Mail, ShieldCheck, CheckCircle2, AlertCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { callFunction } from '@/lib/callFunction'

export const dynamic = 'force-dynamic'

// ─── types ────────────────────────────────────────────────────────────────────

type InvitationRole = 'manager' | 'coach' | 'viewer'

interface InvitationDetails {
  invitationId: string
  teamId: string
  teamName?: string
  email: string
  role: InvitationRole
}

/** Every terminal reason the invitation cannot be used, in copy the reader can act on. */
type FailureKind = 'invalid' | 'expired' | 'alreadyAccepted' | 'planRequired' | 'generic'

// ─── error mapping ────────────────────────────────────────────────────────────

/**
 * Callable errors arrive as `functions/<code>`; the bare code is accepted too so
 * this keeps working if the SDK stops prefixing. The codes are the ones
 * getTeamInvitationDetails and acceptTeamInvitation actually throw — see
 * packages/functions/src/teams/. Anything unrecognised falls to 'generic'
 * rather than surfacing a raw message: these strings reach somebody who was
 * invited by email and has no idea what a precondition is.
 */
function failureKind(err: unknown): FailureKind {
  const raw =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : ''
  const message = err instanceof Error ? err.message : ''

  switch (raw.replace(/^functions\//, '')) {
    case 'not-found':
      return 'invalid'
    // NOT unconditionally 'expired'. The callable SDK raises this same code when
    // the REQUEST times out client-side — an unreachable backend produces
    // `functions/deadline-exceeded` verbatim, which was observed against a
    // stopped emulator. Reading that as expiry tells somebody holding a
    // perfectly good invitation that it is dead, and sends them off to ask for a
    // replacement that will behave identically. The server's own expiry carries
    // a message; a transport timeout does not, so only the former is expiry.
    case 'deadline-exceeded':
      return /expired/i.test(message) ? 'expired' : 'generic'
    case 'already-exists':
      return 'alreadyAccepted'
    // requireExtraUserPlan — the team dropped below the plan that allows a second
    // user, which can happen in the seven days between the invite and the click.
    case 'failed-precondition':
      return 'planRequired'
    default:
      return 'generic'
  }
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function TeamInvitationPage() {
  const params = useParams<{ token: string | string[] }>()
  const token = Array.isArray(params?.token) ? params.token[0] : (params?.token ?? '')
  const t = useTranslations('TeamInvitation')
  const { user, loading: authLoading } = useAuth()

  const [details, setDetails] = useState<InvitationDetails | null>(null)
  const [failure, setFailure] = useState<FailureKind | null>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    if (!token) {
      setFailure('invalid')
      setLoading(false)
      return
    }

    const fn = callFunction<{ token: string }, InvitationDetails>(
      'getTeamInvitationDetails'
    )

    let cancelled = false
    fn({ token })
      .then((result) => {
        if (!cancelled) setDetails(result.data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        reportPublicLoadFailure('team-invitation/details', err)
        setFailure(failureKind(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [token])

  const handleAccept = useCallback(async () => {
    if (accepting) return
    setAccepting(true)
    setFailure(null)

    try {
      const fn = callFunction<{ token: string }, { teamId: string }>(
        'acceptTeamInvitation'
      )
      await fn({ token })
      setAccepted(true)
    } catch (err) {
      reportPublicActionFailure('team-invitation/accept', err)
      setFailure(failureKind(err))
    } finally {
      setAccepting(false)
    }
  }, [token, accepting])

  // Written WITHOUT a locale prefix — the i18n router adds one on the other side.
  // It is a PATH, which is what login's `next` guard requires before it will follow it.
  const signInHref = `/login?next=${encodeURIComponent(`/public/team-invitation/${token}`)}` as Route

  const roleLabel = details ? t(`role_${details.role}` as Parameters<typeof t>[0]) : ''

  // ─── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Minimal top bar — matches /public/event-invitation, the sibling token-only
          route. No tenant branding: the team is named in the card below, and a
          studio logo up here would be a claim made before the token resolved. */}
      <div className="border-b bg-white px-5 py-3.5">
        <span className="text-sm font-bold tracking-tight text-foreground">Linyup</span>
      </div>

      <div className="flex-1 flex flex-col items-center px-5 pt-8 pb-12">
        <div className="w-full max-w-md space-y-5">
          {/* ── Loading ─────────────────────────────────────────────────────── */}
          {loading && (
            <div className="space-y-4">
              <Skeleton className="h-7 w-56" />
              <Skeleton className="h-4 w-64" />
              <div className="rounded-2xl border bg-white p-5 space-y-3">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-60" />
                <Skeleton className="h-4 w-40" />
              </div>
            </div>
          )}

          {/* ── Accepted ─────────────────────────────────────────────────────── */}
          {!loading && accepted && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center space-y-3">
              <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
              <p className="font-semibold text-emerald-800">
                {t('acceptedTitle', { team: details?.teamName ?? '' })}
              </p>
              <p className="text-sm text-emerald-800/80">{t('acceptedBody')}</p>
              <Link
                href="/dashboard"
                className="inline-block mt-2 rounded-xl bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:opacity-90 transition-opacity"
              >
                {t('goToDashboard')}
              </Link>
            </div>
          )}

          {/* ── Terminal failure, with no invitation to show ─────────────────── */}
          {!loading && !accepted && failure && !details && (
            <div className="rounded-2xl border bg-white p-8 text-center space-y-3">
              <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                <AlertCircle className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {t(`error_${failure}` as Parameters<typeof t>[0])}
              </p>
            </div>
          )}

          {/* ── The invitation ───────────────────────────────────────────────── */}
          {!loading && !accepted && details && (
            <>
              <div className="space-y-0.5">
                <h1 className="text-2xl font-bold">{t('title')}</h1>
                <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
              </div>

              <div className="rounded-2xl border bg-white p-5 space-y-4 shadow-sm">
                <div className="flex items-start gap-2 flex-wrap">
                  <h2 className="text-xl font-bold leading-tight">
                    {details.teamName ?? t('unnamedTeam')}
                  </h2>
                  <Badge variant="secondary" className="text-xs shrink-0 mt-0.5">
                    {roleLabel}
                  </Badge>
                </div>

                <div className="space-y-2 text-sm text-muted-foreground border-t pt-4">
                  <div className="flex items-center gap-2.5">
                    <Users className="h-4 w-4 shrink-0 text-foreground/40" />
                    <span>{t('roleLine', { role: roleLabel })}</span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <Mail className="h-4 w-4 shrink-0 text-foreground/40" />
                    <span>{t('sentTo', { email: details.email })}</span>
                  </div>
                </div>
              </div>

              {/* An error raised by the ACCEPT sits with the button that caused it,
                  rather than replacing the invitation the reader is looking at. */}
              {failure && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-destructive/10 border border-destructive/30">
                  <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive">
                    {t(`error_${failure}` as Parameters<typeof t>[0])}
                  </p>
                </div>
              )}

              {/* Signed in → accept. Signed out → sign in and come back here.
                  authLoading is held separately so the button never flashes the
                  wrong state on first paint. */}
              {authLoading ? (
                <Skeleton className="h-12 w-full rounded-xl" />
              ) : user ? (
                <button
                  onClick={handleAccept}
                  disabled={accepting}
                  className="w-full py-3.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {accepting ? t('accepting') : t('acceptBtn')}
                </button>
              ) : (
                <div className="space-y-2.5">
                  <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-muted border">
                    <ShieldCheck className="h-4 w-4 text-foreground/50 shrink-0 mt-0.5" />
                    <p className="text-sm text-muted-foreground">{t('signInRequired')}</p>
                  </div>
                  <Link
                    href={signInHref}
                    className="block w-full py-3.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm text-center hover:opacity-90 transition-opacity"
                  >
                    {t('signInBtn')}
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

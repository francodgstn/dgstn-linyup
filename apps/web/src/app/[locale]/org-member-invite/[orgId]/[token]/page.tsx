'use client'

// The accept surface for an ORGANIZATION MEMBER invitation — a person invited
// to help run an organization.
//
// NOT /org-invite/{orgId}/{invId}, which is the other relationship entirely:
// that page asks a studio OWNER to enroll their studio and move its billing onto
// the org plan. Somebody who was invited personally must never land there, so
// nothing on this page mentions studios, teams or billing, and it never asks
// which team you own.
//
// It is reachable SIGNED OUT on purpose: the invitee may have no Linyup account
// at all — that gap is the whole reason this rail exists. The token in the URL
// is what loads the invitation (through the unauthenticated
// getOrgMemberInvitation callable); it is NOT what grants anything. Accepting
// additionally requires the signed-in account's address to be the invited one,
// enforced server-side. The mismatch state below is the explanation, not the
// guard.

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import { type FunctionsError } from 'firebase/functions'
import { signIn, signUp, signOut, resetPassword } from '@/lib/auth'
import { useAuth } from '@/contexts/AuthContext'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Logo } from '@/components/Logo'
import { CheckCircle2, ShieldAlert, UserCog, XCircle } from 'lucide-react'
import type { Route } from 'next'
import type { OrgRole } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

interface InvitationDetails {
  orgId: string
  orgName: string
  email: string
  role: OrgRole
  invitedByName: string | null
  expiresAt: string | null
  hasAccount: boolean
}

/** The `details` payload of an HttpsError, which is where every refusal on this
 *  rail puts its machine-readable reason. */
function reasonOf(err: unknown): string {
  const details = (err as FunctionsError | null)?.details as { reason?: string } | undefined
  return details?.reason ?? ''
}

export default function OrgMemberInvitePage() {
  const { orgId, token } = useParams<{ orgId: string; token: string }>()
  const t = useTranslations('OrgMemberInvite')
  const { user, loading: authLoading } = useAuth()

  const [invitation, setInvitation] = useState<InvitationDetails | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'idle' | 'accepted' | 'declined'>('idle')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Account-creation form (shown only when the invitee has no account yet).
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const fn = callFunction<{ orgId: string; token: string }, InvitationDetails>(
          'getOrgMemberInvitation'
        )
        const res = await fn({ orgId, token })
        if (!cancelled) setInvitation(res.data)
      } catch (err) {
        if (cancelled) return
        const reason = reasonOf(err)
        setLoadError(
          reason === 'invitation_expired'
            ? t('errorExpired')
            : reason.startsWith('invitation_')
              ? t('errorAlreadyHandled')
              : t('errorNotFound')
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [orgId, token, t])

  const accept = useCallback(
    async (displayName?: string) => {
      const fn = callFunction('acceptOrgMemberInvitation')
      await fn({ orgId, token, displayName })
      setStatus('accepted')
    },
    [orgId, token]
  )

  function describeError(err: unknown): string {
    const reason = reasonOf(err)
    if (reason === 'email_mismatch') return t('mismatchTitle')
    if (reason === 'invitation_expired') return t('errorExpired')
    if (reason.startsWith('invitation_')) return t('errorAlreadyHandled')
    return t('errorGeneric')
  }

  async function handleAccept() {
    setBusy(true)
    setActionError(null)
    try {
      await accept()
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDecline() {
    setBusy(true)
    setActionError(null)
    try {
      const fn = callFunction('declineOrgMemberInvitation')
      await fn({ orgId, token })
      setStatus('declined')
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  // Sign in / create the account, then attach it — WITHOUT LEAVING THIS PAGE.
  //
  // Two reasons it is all here. The address is FIXED to the invited one, which
  // no general auth form can promise, and signing up with a different address is
  // precisely the thing that must not silently happen. And /login ignores its
  // `?redirect=` parameter today, so handing the invitee off to it would drop
  // them on the dashboard and make them go back to their inbox.
  //
  // /signup is doubly wrong for the same trip: its second step creates a
  // STUDIO, which an org admin has no reason to own.
  async function handleAuthAndAccept(e: React.FormEvent) {
    e.preventDefault()
    if (!invitation) return
    const creating = !invitation.hasAccount
    if (creating) {
      if (password.length < 8) {
        setActionError(t('errorPasswordShort'))
        return
      }
      if (password !== confirm) {
        setActionError(t('errorPasswordMismatch'))
        return
      }
    }
    setBusy(true)
    setActionError(null)
    try {
      if (creating) await signUp(invitation.email, password)
      else await signIn(invitation.email, password)
      await accept(creating ? name.trim() || undefined : undefined)
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? ''
      setActionError(
        code === 'auth/email-already-in-use'
          ? t('errorEmailInUse')
          : code === 'auth/weak-password'
            ? t('errorPasswordShort')
            : code === 'auth/wrong-password' ||
                code === 'auth/invalid-credential' ||
                code === 'auth/user-not-found'
              ? t('errorWrongPassword')
              : describeError(err)
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleReset() {
    if (!invitation) return
    setBusy(true)
    setActionError(null)
    try {
      await resetPassword(invitation.email)
      setActionError(t('resetSent'))
    } catch {
      setActionError(t('errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  const signedInEmail = user?.email ? user.email.toLowerCase() : null
  const mismatch = !!invitation && !!signedInEmail && signedInEmail !== invitation.email
  const roleLabel = (role: OrgRole) => (role === 'org_admin' ? t('roleAdmin') : t('roleViewer'))

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex justify-center">
          <Logo size={32} />
        </div>

        <Card>
          <CardHeader className="text-center pb-2">
            <div className="flex justify-center mb-3">
              <UserCog className="h-9 w-9 text-primary" />
            </div>
            <CardTitle>{t('title')}</CardTitle>
          </CardHeader>

          <CardContent className="space-y-4">
            {loading || authLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-9 w-full mt-4" />
              </div>
            ) : loadError ? (
              <div className="text-center space-y-3">
                <XCircle className="h-8 w-8 text-destructive mx-auto" />
                <p className="text-sm text-muted-foreground">{loadError}</p>
              </div>
            ) : status === 'accepted' && invitation ? (
              <div className="text-center space-y-3">
                <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto" />
                <p className="text-sm font-medium">
                  {t('acceptedTitle', { org: invitation.orgName })}
                </p>
                <Link
                  href={`/org/${invitation.orgId}` as Route}
                  className="inline-block text-sm text-primary hover:underline"
                >
                  {t('goToOrg')}
                </Link>
              </div>
            ) : status === 'declined' ? (
              <p className="text-sm text-center text-muted-foreground">{t('declinedTitle')}</p>
            ) : invitation ? (
              <>
                {/* What this invitation IS — and, just as important, what it is
                    not. The other org invitation moves a studio's billing; this
                    one says so explicitly so the two are never confused. */}
                <p className="text-sm text-center text-muted-foreground">
                  {invitation.invitedByName
                    ? t.rich('introBy', {
                        who: invitation.invitedByName,
                        org: invitation.orgName,
                        role: roleLabel(invitation.role),
                        strong: (c) => <span className="font-semibold text-foreground">{c}</span>,
                      })
                    : t.rich('intro', {
                        org: invitation.orgName,
                        role: roleLabel(invitation.role),
                        strong: (c) => <span className="font-semibold text-foreground">{c}</span>,
                      })}
                </p>
                <p className="text-xs text-center text-muted-foreground">{t('scopeNote')}</p>

                <div className="flex items-center justify-between text-sm py-2 border-y">
                  <span className="text-muted-foreground">{t('emailLabel')}</span>
                  <span className="font-medium break-all">{invitation.email}</span>
                </div>

                {mismatch ? (
                  // ── THE SHARP CASE ──────────────────────────────────────────
                  // Signed in as somebody else. Never offer to accept: attaching
                  // the wrong identity is exactly the failure this rail exists to
                  // avoid, and the token proves control of a mailbox, not of an
                  // account. Say both addresses, and give the only two honest
                  // ways forward.
                  <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/30">
                    <div className="flex gap-2">
                      <ShieldAlert className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                          {t('mismatchTitle')}
                        </p>
                        <p className="text-xs text-amber-800 dark:text-amber-300">
                          {t('mismatchBody', {
                            invited: invitation.email,
                            current: signedInEmail ?? '',
                          })}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true)
                        await signOut()
                        setBusy(false)
                      }}
                    >
                      {t('signOutAndSwitch')}
                    </Button>
                  </div>
                ) : user ? (
                  <>
                    {actionError && <p className="text-sm text-destructive">{actionError}</p>}
                    <div className="flex gap-2 pt-1">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={handleDecline}
                        disabled={busy}
                      >
                        {t('decline')}
                      </Button>
                      <Button className="flex-1" onClick={handleAccept} disabled={busy}>
                        {busy ? t('processing') : t('accept')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <form onSubmit={handleAuthAndAccept} className="space-y-3">
                    <p className="text-sm text-center text-muted-foreground">
                      {invitation.hasAccount ? t('signInPrompt') : t('createAccountPrompt')}
                    </p>
                    {!invitation.hasAccount && (
                      <div className="space-y-1.5">
                        <Label htmlFor="invite-name">{t('nameLabel')}</Label>
                        <Input
                          id="invite-name"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          autoComplete="name"
                        />
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="invite-password">{t('passwordLabel')}</Label>
                      <Input
                        id="invite-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete={invitation.hasAccount ? 'current-password' : 'new-password'}
                        required
                      />
                    </div>
                    {!invitation.hasAccount && (
                      <div className="space-y-1.5">
                        <Label htmlFor="invite-confirm">{t('confirmLabel')}</Label>
                        <Input
                          id="invite-confirm"
                          type="password"
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                          autoComplete="new-password"
                          required
                        />
                      </div>
                    )}
                    {actionError && <p className="text-sm text-destructive">{actionError}</p>}
                    <Button type="submit" className="w-full" disabled={busy}>
                      {busy
                        ? t('processing')
                        : invitation.hasAccount
                          ? t('signInAndJoin')
                          : t('createAccountAndJoin')}
                    </Button>
                    {invitation.hasAccount && (
                      // Without this, somebody who cannot remember their password
                      // has no way through — the invitation is bound to this one
                      // address, so "use another account" is not an answer.
                      <button
                        type="button"
                        onClick={handleReset}
                        disabled={busy}
                        className="block w-full text-center text-xs text-primary hover:underline"
                      >
                        {t('forgotPassword')}
                      </button>
                    )}
                  </form>
                )}
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

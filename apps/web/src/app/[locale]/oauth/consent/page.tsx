'use client'

// /oauth/consent?request=… — where a member decides whether an app (Claude,
// ChatGPT, a developer's client) may read one of their studios.
// docs/public-api.md → "OAuth".
//
// The api function's /oauth/authorize has already verified the app (its Client
// ID Metadata Document and redirect URI) and parked the request; this page only
// signs the member in, shows what is asked, and hands the decision to the
// consent callables. It never builds a redirect itself — the callable returns
// the one registered for the app, so nothing here can send a code elsewhere.
//
// What the member can grant is narrowed three times: to what the app asked
// for, to what their role in the chosen studio can read NOW, and to what they
// leave ticked. Contact details start unticked even when asked for.

import { useEffect, useMemo, useState } from 'react'
import type { Route } from 'next'
import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import type { ApiScope, TeamRole } from '@linyup/shared'
import { API_SCOPE_REQUIREMENTS } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { Link, useRouter } from '@/i18n/navigation'
import { Logo } from '@/components/Logo'
import { ApiScopeHint, ApiScopeName } from '@/components/api/ApiScopeText'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { callFunction } from '@/lib/callFunction'

interface ConsentTeamOption {
  teamId: string
  name: string
  role: TeamRole
  plugin_installed: boolean
  /** Barred from the public API outright — the demo playground, whose login is public. */
  api_blocked: boolean
  scopes: Array<{ scope: ApiScope; usable: boolean }>
}

interface ConsentRequest {
  client: { id: string; name: string; uri: string | null; logo_uri: string | null; redirect_host: string; recognised: boolean }
  scopes: ApiScope[]
  teams: ConsentTeamOption[]
  expires_at_ms: number
}

function requestIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('request')
}

function reasonOf(err: unknown): string | null {
  const details = (err as { details?: { reason?: unknown } } | null)?.details
  return typeof details?.reason === 'string' ? details.reason : null
}

/** A team the member can actually grant from: not blocked, plugin installed, one usable scope. */
function grantable(team: ConsentTeamOption): boolean {
  return !team.api_blocked && team.plugin_installed && team.scopes.some((s) => s.usable)
}

export default function OAuthConsentPage() {
  const t = useTranslations('OAuthConsent')
  const tk = useTranslations('ApiKeys')
  const router = useRouter()
  const { user, loading } = useAuth()
  const [requestId, setRequestId] = useState<string | null>(null)
  const [request, setRequest] = useState<ConsentRequest | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'expired' | 'error'>('loading')
  const [teamId, setTeamId] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<ApiScope>>(new Set())
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setRequestId(requestIdFromUrl()), [])

  // Not signed in: sign in and come straight back to this request.
  useEffect(() => {
    if (loading || requestId === null) return
    if (!user) {
      const next = `/oauth/consent?request=${encodeURIComponent(requestId)}`
      router.replace(`/login?next=${encodeURIComponent(next)}` as Route)
    }
  }, [loading, user, requestId, router])

  useEffect(() => {
    if (!user || !requestId) return
    let cancelled = false
    callFunction<{ requestId: string }, ConsentRequest>('getOAuthAuthorizationRequest')({ requestId })
      .then(({ data }) => {
        if (cancelled) return
        setRequest(data)
        const first = data.teams.find(grantable) ?? data.teams[0]
        setTeamId(first?.teamId ?? null)
        setState('ready')
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[oauth consent] load failed:', err)
        setState(reasonOf(err) === 'request_expired' ? 'expired' : 'error')
      })
    return () => {
      cancelled = true
    }
  }, [user, requestId])

  const team = useMemo(() => request?.teams.find((x) => x.teamId === teamId) ?? null, [request, teamId])

  // Choosing a studio resets the ticks to what that studio's role allows; contact details stay off.
  useEffect(() => {
    if (!team) return
    setChosen(new Set(team.scopes.filter((s) => s.usable && s.scope !== 'contacts:read:pii').map((s) => s.scope)))
  }, [team])

  function toggle(scope: ApiScope, on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev)
      if (on) next.add(scope)
      else {
        next.delete(scope)
        for (const [s, req] of Object.entries(API_SCOPE_REQUIREMENTS)) {
          if (req.requires?.includes(scope)) next.delete(s as ApiScope)
        }
      }
      return next
    })
  }

  async function decide(allow: boolean) {
    if (!requestId) return
    setBusy(allow ? 'allow' : 'deny')
    setError(null)
    try {
      const { data } = allow
        ? await callFunction<{ requestId: string; teamId: string; scopes: ApiScope[] }, { redirect: string }>(
            'approveOAuthAuthorization'
          )({ requestId, teamId: teamId!, scopes: [...chosen] })
        : await callFunction<{ requestId: string }, { redirect: string }>('denyOAuthAuthorization')({ requestId })
      // The app's own registered return address, from the server.
      window.location.assign(data.redirect)
    } catch (err) {
      console.error('[oauth consent] decision failed:', err)
      const reason = reasonOf(err)
      if (reason === 'request_expired' || reason === 'request_used') setState('expired')
      else setError(reason === 'plugin_not_installed' ? t('notInstalled') : t('errorGeneric'))
      setBusy(null)
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex justify-center">
          <Logo size={28} />
        </div>
        <div className="space-y-5 rounded-2xl border bg-card p-6 shadow-sm">{children}</div>
      </div>
    </div>
  )

  if (requestId === null || loading || !user || state === 'loading') {
    return shell(<p className="text-center text-sm text-muted-foreground">{t('loading')}</p>)
  }

  if (!requestId || state === 'expired') {
    return shell(
      <div className="space-y-2 text-center">
        <h1 className="text-lg font-semibold">{t('expiredTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('expiredBody')}</p>
      </div>
    )
  }

  if (state === 'error' || !request) {
    return shell(<p className="text-center text-sm text-destructive">{t('errorGeneric')}</p>)
  }

  const canAllow = !!team && grantable(team) && chosen.size > 0 && busy === null

  return shell(
    <>
      <div className="space-y-1.5 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('pageTitle')}</p>
        <h1 className="text-lg font-semibold">{t('title', { client: request.client.name })}</h1>
        <p className="text-xs text-muted-foreground">{t('redirectNote', { host: request.client.redirect_host })}</p>
      </div>

      {!request.client.recognised && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t('unrecognised')}</p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t('signedInAs', { email: user.email ?? '' })}</p>

      {request.teams.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noTeams')}</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t('teamLabel')}</p>
            {request.teams.length === 1 ? (
              <p className="text-sm">{request.teams[0].name}</p>
            ) : (
              <Select value={teamId ?? undefined} onValueChange={(v) => setTeamId(v as string)}>
                <SelectTrigger className="h-9 w-full">
                  <span className="flex flex-1 truncate text-left text-sm">{team?.name ?? ''}</span>
                </SelectTrigger>
                <SelectContent>
                  {request.teams.map((option) => (
                    <SelectItem key={option.teamId} value={option.teamId}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {team && team.api_blocked ? (
            <p className="rounded-lg bg-muted/40 p-3 text-sm">{t('teamBlocked')}</p>
          ) : team && !team.plugin_installed ? (
            <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
              <p>{t('notInstalled')}</p>
              {team.role === 'owner' && (
                <Link href={'/plugins?plugin=api-connectors' as Route} className="text-primary underline underline-offset-2">
                  {t('installLink')}
                </Link>
              )}
            </div>
          ) : team && !team.scopes.some((s) => s.usable) ? (
            <p className="rounded-lg bg-muted/40 p-3 text-sm">{t('noScopes')}</p>
          ) : team ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('scopesLabel')}</p>
              <ul className="divide-y rounded-lg border">
                {team.scopes.map(({ scope, usable }) => {
                  const blocked = !usable || (API_SCOPE_REQUIREMENTS[scope].requires ?? []).some((r) => !chosen.has(r))
                  return (
                    <li key={scope} className="flex items-start justify-between gap-4 p-3">
                      <div className="min-w-0">
                        <p className="text-sm">
                          <ApiScopeName scope={scope} />
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {usable ? <ApiScopeHint scope={scope} /> : t('scopeUnavailable')}
                        </p>
                      </div>
                      <Switch
                        checked={usable && chosen.has(scope)}
                        disabled={blocked}
                        onCheckedChange={(on: boolean) => toggle(scope, on)}
                        aria-label={scope}
                      />
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
        </>
      )}

      <div className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
        <p>{tk('neverShared')}</p>
        <p>{t('actsAsYou')}</p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" disabled={busy !== null} onClick={() => decide(false)}>
          {t('deny')}
        </Button>
        <Button className="flex-1" disabled={!canAllow} onClick={() => decide(true)}>
          {busy === 'allow' ? t('allowing') : t('allow')}
        </Button>
      </div>
    </>
  )
}

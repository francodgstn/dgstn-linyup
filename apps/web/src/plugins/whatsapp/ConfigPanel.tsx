'use client'

// WhatsApp plugin — Settings → Plugins owner config. Connects the studio's OWN
// WhatsApp Business number via Meta Embedded Signup (coexistence / Business
// App onboarding), so replies keep landing in the studio's own WhatsApp
// Business app. See docs/whatsapp-outbound.md for the whole design; this panel
// covers section "3. Connect / disconnect".
//
// Owner-only, same rule as the integration doc itself (SmsSenderCard's
// pattern): a manager cannot read `teams/{t}/integrations/whatsapp` at all, so
// this renders nothing for them rather than a panel that would 403 on load.
//
// CSP NOTE: this app defers Content-Security-Policy entirely today
// (see apps/web/next.config.ts — "CSP is deferred"; only frame-ancestors /
// X-Frame-Options are set, in src/proxy.ts, and only to control who may FRAME
// this app, not what this app may load). So loading connect.facebook.net's SDK
// and opening Meta's login popup need no CSP change right now. If a script-src
// / connect-src / frame-src policy is ever added, it will need to allow
// `https://connect.facebook.net` (script-src, the SDK) and
// `https://www.facebook.com` / `https://web.facebook.com` (frame-src/connect-src,
// FB.login's dialog) — scoped to this settings route only, the way the embed
// widget's frame-ancestors allowance is scoped to /embed/* in proxy.ts.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MessageCircle,
  RefreshCw,
  Unlink,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  WHATSAPP_BOOKING_REMINDER_TEMPLATE,
  WHATSAPP_LANGUAGES,
  whatsappTemplateStatusKey,
  type WhatsAppTemplateStatus,
} from '@linyup/shared'
import {
  useWhatsAppIntegration,
  useWhatsAppSignupConfig,
  useConnectWhatsApp,
  useRefreshWhatsAppStatus,
  useDisconnectWhatsApp,
  type ConnectWhatsAppRefusalReason,
} from './hooks'
import { loadFacebookSdk, type FacebookSdkWindow } from './facebookSdk'

/** Meta's Embedded Signup posts from facebook.com over https. Parsed as a URL
 *  so a look-alike host (`https://notfacebook.com`) cannot pass. */
export function isMetaOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string') return false
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))
  } catch {
    return false
  }
}
const LANGUAGE_LABEL: Record<string, string> = { en: 'EN', de: 'DE', fr: 'FR', it: 'IT' }

function errorReason(err: unknown): string | undefined {
  return (err as { details?: { reason?: string } } | null)?.details?.reason
}

export function ConfigPanel() {
  const t = useTranslations('Plugins')
  const { currentTeamId, teamRole } = useAuth()
  const canEdit = teamRole === 'owner'
  const { confirm, confirmDialog } = useConfirm()
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const integrationQ = useWhatsAppIntegration(currentTeamId, canEdit)
  const integration = integrationQ.data ?? null
  const isConnected = integration?.status === 'connected'
  const signupConfigQ = useWhatsAppSignupConfig(currentTeamId, canEdit && !isConnected)
  const connectMutation = useConnectWhatsApp(currentTeamId)
  const refreshMutation = useRefreshWhatsAppStatus(currentTeamId)
  const disconnectMutation = useDisconnectWhatsApp(currentTeamId)

  // Managers can't read the integration doc at all — hide the card entirely,
  // same as SmsSenderCard.
  if (!canEdit || !currentTeamId) return null

  function connectErrorMessage(reason: string | undefined): string {
    switch (reason as ConnectWhatsAppRefusalReason | undefined) {
      case 'not_business_app':
        return t('whatsappErrorNotBusinessApp')
      case 'number_taken':
        return t('whatsappErrorNumberTaken')
      case 'no_number':
      case 'several_numbers':
        return t('whatsappErrorNumberAmbiguous')
      case 'not_configured':
      case 'plugin_not_installed':
      case 'demo_tenant':
      case 'meta_error':
        return t('whatsappErrorGeneric')
      default:
        return t('whatsappErrorGeneric')
    }
  }

  async function beginConnect() {
    if (!currentTeamId || signupConfigQ.data?.available !== true) return
    const { appId, configId, graphVersion } = signupConfigQ.data
    setConnecting(true)
    setConnectError(null)

    let wabaId: string | null = null
    let phoneNumberId: string | null = null
    let cancelled = false

    function onMessage(event: MessageEvent) {
      // Only Meta's own origins — never trust an arbitrary postMessage sender.
      // Compared as a HOST over https, not as a string suffix: `endsWith` also
      // accepts `https://notfacebook.com`, which is somebody else's site.
      if (!isMetaOrigin(event.origin)) return
      let parsed: { type?: string; data?: Record<string, unknown> } | null = null
      try {
        parsed = typeof event.data === 'string' ? JSON.parse(event.data) : null
      } catch {
        return
      }
      if (!parsed || parsed.type !== 'WA_EMBEDDED_SIGNUP') return
      const data = parsed.data ?? {}
      if (data.event === 'CANCEL' || data.event === 'error') {
        cancelled = true
        return
      }
      if (typeof data.waba_id === 'string') wabaId = data.waba_id
      if (typeof data.phone_number_id === 'string') phoneNumberId = data.phone_number_id
    }

    window.addEventListener('message', onMessage)

    try {
      await loadFacebookSdk(appId, graphVersion)
      const FB = (window as FacebookSdkWindow).FB
      if (!FB) throw new Error('sdk_unavailable')

      await new Promise<void>((resolve, reject) => {
        FB.login(
          (response) => {
            if (cancelled) {
              reject(new Error('cancelled'))
              return
            }
            const code = response?.authResponse?.code
            if (!code) {
              reject(new Error('no_code'))
              return
            }
            if (!wabaId) {
              reject(new Error('no_waba'))
              return
            }
            connectMutation.mutate(
              {
                teamId: currentTeamId,
                code,
                wabaId,
                ...(phoneNumberId ? { phoneNumberId } : {}),
              },
              {
                onSuccess: () => resolve(),
                onError: (err) => reject(err),
              }
            )
          },
          {
            config_id: configId,
            response_type: 'code',
            override_default_response_type: true,
            extras: {
              setup: {},
              featureType: 'whatsapp_business_app_onboarding',
              sessionInfoVersion: '3',
            },
          }
        )
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      if (message === 'cancelled') {
        setConnectError(t('whatsappConnectCancelled'))
      } else if (message === 'no_code' || message === 'no_waba') {
        setConnectError(t('whatsappConnectIncomplete'))
      } else {
        setConnectError(connectErrorMessage(errorReason(err)))
      }
    } finally {
      window.removeEventListener('message', onMessage)
      setConnecting(false)
    }
  }

  async function onDisconnect() {
    if (!currentTeamId) return
    const ok = await confirm({
      title: t('whatsappDisconnectTitle'),
      description: t('whatsappDisconnectDesc'),
      confirmLabel: t('whatsappDisconnectAction'),
    })
    if (!ok) return
    disconnectMutation.mutate({ teamId: currentTeamId })
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (integrationQ.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        {t('loading')}
      </div>
    )
  }

  // ── Error state (last connect/refresh attempt failed server-side) ───────
  if (integration?.status === 'error') {
    return (
      <div className="flex flex-col gap-3 py-2">
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{integration.last_error || t('whatsappErrorGeneric')}</span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => refreshMutation.mutate({ teamId: currentTeamId })}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            {t('whatsappRefresh')}
          </Button>
          <Button size="sm" onClick={beginConnect} disabled={connecting || signupConfigQ.data?.available !== true}>
            {connecting && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {t('whatsappReconnect')}
          </Button>
        </div>
        {connectError && <p className="text-xs text-destructive">{connectError}</p>}
        {confirmDialog}
      </div>
    )
  }

  // ── Connected ─────────────────────────────────────────────────────────────
  if (isConnected && integration) {
    const templates = integration.templates ?? {}
    return (
      <div className="flex flex-col gap-3 py-2">
        <div className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="font-medium truncate">
                {integration.verified_name || integration.display_phone_number || t('whatsappConnected')}
              </p>
              {integration.display_phone_number && (
                <p className="text-xs text-muted-foreground truncate">{integration.display_phone_number}</p>
              )}
            </div>
          </div>
          <Badge
            variant="secondary"
            className="shrink-0 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
          >
            <CheckCircle2 className="h-3 w-3 mr-1" />
            {t('whatsappConnected')}
          </Badge>
        </div>

        {integration.quality_rating && (
          <p className="text-xs text-muted-foreground">
            {t('whatsappQualityRating', { rating: integration.quality_rating })}
          </p>
        )}

        <Separator />

        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('whatsappTemplateStatusTitle')}
          </p>
          <ul className="space-y-1">
            {WHATSAPP_LANGUAGES.map((lang) => {
              const state = templates[whatsappTemplateStatusKey(WHATSAPP_BOOKING_REMINDER_TEMPLATE.name, lang)]
              const status: WhatsAppTemplateStatus = state?.status ?? 'MISSING'
              return (
                <li key={lang} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">{LANGUAGE_LABEL[lang] ?? lang}</span>
                  <TemplateStatusBadge status={status} reason={state?.reason} t={t} />
                </li>
              )
            })}
          </ul>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => refreshMutation.mutate({ teamId: currentTeamId })}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
            )}
            {t('whatsappRefresh')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onDisconnect}
            disabled={disconnectMutation.isPending}
          >
            {disconnectMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Unlink className="h-3.5 w-3.5 mr-1" />
            )}
            {t('whatsappDisconnectAction')}
          </Button>
        </div>

        {confirmDialog}
      </div>
    )
  }

  // ── Not available on this deploy ─────────────────────────────────────────
  if (signupConfigQ.data?.available === false) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        <MessageCircle className="h-4 w-4 shrink-0 opacity-50" />
        <span>{t('whatsappNotAvailable')}</span>
      </div>
    )
  }

  // ── Not connected — explain, then Connect ───────────────────────────────
  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="space-y-1.5 text-sm text-muted-foreground">
        <p>{t('whatsappExplainOwnNumber')}</p>
        <p>{t('whatsappExplainBilling')}</p>
        <p>{t('whatsappExplainOptIn')}</p>
        <p>{t('whatsappExplainReplies')}</p>
      </div>

      <Button
        onClick={beginConnect}
        disabled={connecting || signupConfigQ.isLoading || signupConfigQ.data?.available !== true}
      >
        {connecting ? (
          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
        ) : (
          <ExternalLink className="h-4 w-4 mr-1" />
        )}
        {t('whatsappConnectAction')}
      </Button>

      {connectError && <p className="text-xs text-destructive">{connectError}</p>}
    </div>
  )
}

function TemplateStatusBadge({
  status,
  reason,
  t,
}: {
  status: WhatsAppTemplateStatus
  reason?: string | null
  t: ReturnType<typeof useTranslations>
}) {
  if (status === 'APPROVED') {
    return (
      <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
        {t('whatsappTemplateApproved')}
      </Badge>
    )
  }
  if (status === 'PENDING') {
    return (
      <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
        {t('whatsappTemplatePending')}
      </Badge>
    )
  }
  if (status === 'REJECTED') {
    return (
      <Badge
        variant="secondary"
        className="bg-destructive/10 text-destructive"
        title={reason || undefined}
      >
        {t('whatsappTemplateRejected')}
      </Badge>
    )
  }
  if (status === 'PAUSED' || status === 'DISABLED') {
    return <Badge variant="outline">{t('whatsappTemplatePaused')}</Badge>
  }
  return <Badge variant="outline">{t('whatsappTemplateMissing')}</Badge>
}

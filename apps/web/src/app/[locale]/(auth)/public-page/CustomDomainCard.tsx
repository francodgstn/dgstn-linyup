'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2, Copy, ExternalLink, Globe, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PlanUpgradeNotice } from '@/components/plan/PlanUpgradeNotice'
import { useCustomDomain } from '@/hooks/useCustomDomain'
import {
  CUSTOM_DOMAIN_ENV_REFUSAL,
  customDomainsAvailable,
  minimumPlanForFeature,
  planHasFeature,
  type PublicDomainStatus,
  type SaasPlan,
} from '@linyup/shared'
import { Tip } from '@/components/ui/tip'

/**
 * The studio's custom PUBLIC domain — where their pages are SERVED from, as
 * opposed to the email sender card next door, which is where their mail is SENT
 * from. They sit together on purpose: "our domain" is one question in a studio
 * owner's head, and splitting it across two screens makes them look unrelated.
 *
 * Design + the DNS reasoning: docs/custom-domains.md.
 */
export function CustomDomainCard({
  scope,
  entityId,
  plan,
  slug,
}: {
  scope: 'team' | 'org'
  entityId: string
  plan?: string
  slug?: string
}) {
  const t = useTranslations('CustomDomain')
  const {
    data: config,
    isLoading,
    registerDomain,
    checkDomain,
    removeDomain,
    isRegistering,
    isChecking,
    isRemoving,
  } = useCustomDomain(scope, entityId)

  // Production only (see customDomainsAvailable). Off-prod the form is not
  // merely hidden — it is replaced by a sentence saying why, because a form that
  // silently does nothing on the demo is how a prospect concludes the feature is
  // broken. The callable refuses independently; this is the explanation, not the
  // enforcement.
  const available = customDomainsAvailable(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID)

  const [hostname, setHostname] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  // Read the tier from PLAN_FEATURES rather than listing plans here — the same
  // `custom_domain` feature drives the landing page's comparison table and the
  // server's refusal, so the tier moves in one place.
  const isPaidPlan = !!plan && planHasFeature(plan as SaasPlan, 'custom_domain')

  async function handleRegister() {
    setError(null)
    if (!hostname.trim()) return
    try {
      await registerDomain(hostname.trim())
      setHostname('')
    } catch (err) {
      // The env refusal is a STABLE CODE, not prose — map it rather than showing
      // the server's English. Unreachable while the form is hidden off-prod, but
      // the code is the contract and a silent raw string is how that rots.
      const message = (err as Error).message
      setError(
        message === CUSTOM_DOMAIN_ENV_REFUSAL
          ? t('unavailableBody')
          : message || t('registerError')
      )
    }
  }

  async function handleCheck() {
    setError(null)
    try {
      await checkDomain()
    } catch (err) {
      setError((err as Error).message || t('checkError'))
    }
  }

  async function handleRemove() {
    setError(null)
    try {
      await removeDomain()
      setConfirmingRemove(false)
    } catch (err) {
      setError((err as Error).message || t('removeError'))
    }
  }

  function copy(value: string) {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <Globe className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
        <div>
          <p className="text-sm font-medium">{t('title')}</p>
          <p className="text-xs text-muted-foreground">
            {slug ? t('descriptionWithSlug', { slug }) : t('description')}
          </p>
        </div>
      </div>

      {!available && (
        <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
          <p className="text-xs font-medium">{t('unavailableTitle')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('unavailableBody')}</p>
        </div>
      )}

      {available && !config && !isPaidPlan && (
        <PlanUpgradeNotice
          feature="custom_domain"
          minPlan={minimumPlanForFeature('custom_domain')}
          title={t('upsellTitle')}
          description={t('upsellDescription')}
        />
      )}

      {available && !config && isPaidPlan && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="custom-domain">{t('hostnameLabel')}</Label>
            <Input
              id="custom-domain"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="book.theirdojo.ch"
              autoComplete="off"
              spellCheck={false}
            />
            {/* The suggestion is a hint, never a constraint — a German-speaking
                studio that wants buchen.theirdojo.ch should simply type it. */}
            <p className="text-xs text-muted-foreground">{t('hostnameHint')}</p>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button size="sm" onClick={handleRegister} disabled={isRegistering || !hostname.trim()}>
            {isRegistering ? t('registering') : t('registerButton')}
          </Button>
        </div>
      )}

      {available && config && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-medium font-mono break-all">{config.hostname}</p>
              {config.status === 'active' && (
                <a
                  href={`https://${config.hostname}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  {t('visit')} <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <StatusBadge status={config.status} />
          </div>

          {/* The DNS instruction stays visible while the domain is not yet live.
              Hiding it the moment the record is created is what turns "waiting
              for DNS" into a support ticket. */}
          {config.status !== 'active' && (
            <div className="space-y-2">
              <p className="text-xs font-medium">{t('dnsTitle')}</p>
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground w-20">
                        {t('dnsColType')}
                      </th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                        {t('dnsColHost')}
                      </th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                        {t('dnsColValue')}
                      </th>
                      <th className="px-2 py-2 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="px-3 py-2 font-mono text-muted-foreground">
                        {config.dns_record.type}
                      </td>
                      <td className="px-3 py-2 font-mono break-all">{config.dns_record.host}</td>
                      <td className="px-3 py-2 font-mono break-all">{config.dns_record.value}</td>
                      <td className="px-2 py-2">
                        <Tip label={t('copyValue')}>
                          <button
                            type="button"
                            onClick={() => copy(config.dns_record.value)}
                            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            aria-label={t('copyValue')}
                          >
                            {copied ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </Tip>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">{t('dnsNote')}</p>
            </div>
          )}

          {config.error && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-800 break-words">
              {config.error}
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-2 flex-wrap">
            {config.status !== 'active' && (
              <Button size="sm" variant="outline" onClick={handleCheck} disabled={isChecking}>
                {isChecking ? t('checking') : t('checkButton')}
              </Button>
            )}
            {confirmingRemove ? (
              <>
                <Button size="sm" variant="destructive" onClick={handleRemove} disabled={isRemoving}>
                  {isRemoving ? t('removing') : t('removeConfirm')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
                  {t('cancel')}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(true)}>
                {t('removeButton')}
              </Button>
            )}
          </div>

          {confirmingRemove && (
            <p className="text-xs text-muted-foreground">{t('removeWarning')}</p>
          )}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: PublicDomainStatus }) {
  const t = useTranslations('CustomDomain')
  if (status === 'active') {
    return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{t('statusActive')}</Badge>
  }
  if (status === 'verifying') {
    return <Badge variant="secondary">{t('statusVerifying')}</Badge>
  }
  if (status === 'error') {
    return <Badge variant="destructive">{t('statusError')}</Badge>
  }
  return <Badge variant="outline">{t('statusPending')}</Badge>
}

'use client'

// Settings → Emails: the SENDER half.
//
// These two cards used to live on Settings → Team behind an "Outreach" tab,
// while templates and the system-email toggles lived here. The split was not a
// distinction anyone could act on — both halves are "how this studio sends
// email", and both were already written against the SAME `EmailSettings` i18n
// namespace, which is the tell. Merged 2026-08-25; `/settings/team?tab=outreach`
// now redirects here so pins and bookmarks survive.
//
// The custom DOMAIN card used to sit here too, on the reasoning that "our
// domain" is one question in an owner's head. That was wrong: the domain a
// studio's PAGES are served from is a property of the pages, not of the mail,
// and an owner looking for it goes to Public pages. It moved there 2026-09-08.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { doc, updateDoc } from 'firebase/firestore'
import { CheckCircle2, Clock, Copy, Loader2, Mail, Plus, Send, Trash2, XCircle } from 'lucide-react'
import { TEAMS_COLLECTION, type Team } from '@linyup/shared'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { PlanUpgradeNotice } from '@/components/plan/PlanUpgradeNotice'
import { useEmailSenderSettings } from '@/hooks/useEmailSenderSettings'
import { Tip } from '@/components/ui/tip'

const KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function EmailSenderForm({
  teamId,
  plan,
}: {
  teamId: string
  plan: string | undefined
}) {
  const t = useTranslations('EmailSettings')
  const { user } = useAuth()
  const { data: config, isLoading, registerDomain, checkDomain, revertToManaged, isRegistering, isChecking, isReverting, sendTest, isSendingTest } =
    useEmailSenderSettings('team', teamId)

  const [domain, setDomain] = useState('')
  const [fromLocalPart, setFromLocalPart] = useState('info')
  const [registerError, setRegisterError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [testRecipient, setTestRecipient] = useState(user?.email ?? '')
  const [testResult, setTestResult] = useState<{ email: string; skipped: boolean; testMode: boolean } | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  // Populate recipient with signed-in user's email once auth resolves
  useEffect(() => {
    if (user?.email && !testRecipient) setTestRecipient(user.email)
  }, [user?.email]) // eslint-disable-line react-hooks/exhaustive-deps

  const isPaidPlan = plan === 'coach' || plan === 'studio' || plan === 'organization'
  const isByo = config?.model === 'byo_domain'

  async function handleRegister() {
    setRegisterError(null)
    if (!domain.trim()) return
    try {
      await registerDomain(domain.trim(), fromLocalPart.trim() || 'info')
    } catch (err) {
      setRegisterError((err as Error).message ?? t('registerError'))
    }
  }

  async function handleCheck() {
    try {
      await checkDomain()
    } catch {
      // status stays as-is; user can retry
    }
  }

  async function handleRevert() {
    try {
      await revertToManaged()
    } catch {
      // silent — cached state will update on next load
    }
  }

  async function handleSendTest() {
    setTestResult(null)
    setTestError(null)
    try {
      const result = await sendTest(testRecipient.trim() || undefined)
      setTestResult({ email: result.sentTo, skipped: result.skipped, testMode: result.testMode })
    } catch (err) {
      setTestError((err as Error).message ?? t('sendTestError'))
    }
  }

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 2000)
    })
  }

  function VerificationBadge({ status }: { status: string | undefined }) {
    if (status === 'verified') {
      return (
        <Badge variant="default" className="gap-1 bg-green-600 hover:bg-green-600">
          <CheckCircle2 className="h-3 w-3" />
          {t('statusVerified')}
        </Badge>
      )
    }
    if (status === 'failed') {
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" />
          {t('statusFailed')}
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
        <Clock className="h-3 w-3" />
        {t('statusPending')}
      </Badge>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Mail className="h-4 w-4" />
          {t('title')}
        </h3>
        <p className="text-xs text-muted-foreground mt-1">{t('subtitle')}</p>
      </div>

      {/* Managed sender card — always shown */}
      <div className={`rounded-lg border p-4 space-y-1 ${!isByo ? 'border-primary/40 bg-primary/5' : ''}`}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{t('managedTitle')}</p>
          {!isByo && (
            <Badge variant="secondary" className="text-xs">{t('active')}</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('managedDescription')}</p>
      </div>

      {/* BYO domain section */}
      {!isByo && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('byoSectionTitle')}
          </p>

          {!isPaidPlan ? (
            /* UX-42: this used to be a lock icon, upsell copy and nothing to
               click — a refusal with no way out. It speaks through the one
               shared notice now, which names the plan and opens the modal. */
            <PlanUpgradeNotice
              minPlan="coach"
              title={t('byoUpsellTitle')}
              description={t('byoUpsellDescription')}
            />
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-1">
                  <Label htmlFor="byo-domain">{t('domainLabel')}</Label>
                  <Input
                    id="byo-domain"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="theirdojo.ch"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="byo-from-local">{t('fromLocalPartLabel')}</Label>
                  <Input
                    id="byo-from-local"
                    value={fromLocalPart}
                    onChange={(e) => setFromLocalPart(e.target.value)}
                    placeholder="info"
                  />
                </div>
              </div>
              {fromLocalPart && domain && (
                <p className="text-xs text-muted-foreground">
                  {t('fromAddressPreview', { address: `${fromLocalPart || 'info'}@${domain}` })}
                </p>
              )}
              {registerError && (
                <p className="text-xs text-destructive">{registerError}</p>
              )}
              <Button
                size="sm"
                onClick={handleRegister}
                disabled={isRegistering || !domain.trim()}
              >
                {isRegistering ? t('registering') : t('registerButton')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* BYO domain active state */}
      {isByo && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium">{t('byoActiveTitle')}</p>
              <p className="text-xs text-muted-foreground">
                {t('byoActiveFrom', {
                  address: `${config.from_local_part ?? 'info'}@${config.domain}`,
                })}
              </p>
            </div>
            <VerificationBadge status={config.verification_status} />
          </div>

          {config.verification_status !== 'verified' && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-800">
              {t('pendingFallbackNote')}
            </div>
          )}

          {/* DNS records table */}
          {config.dns_records && config.dns_records.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium">{t('dnsRecordsTitle')}</p>
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground w-16">{t('dnsColType')}</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t('dnsColHost')}</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t('dnsColValue')}</th>
                      <th className="px-2 py-2 w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {config.dns_records.map((record, idx) => (
                      <tr key={idx} className={record.verified ? 'bg-green-50/50' : ''}>
                        <td className="px-3 py-2 font-mono text-muted-foreground">{record.type}</td>
                        <td className="px-3 py-2 font-mono break-all max-w-[160px]">{record.host}</td>
                        <td className="px-3 py-2 font-mono break-all max-w-[200px]">{record.value}</td>
                        <td className="px-2 py-2">
                          <Tip label={t('copyValue')}>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(record.value, `${idx}-value`)}
                              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                              aria-label={t('copyValue')}
                            >
                              {copiedKey === `${idx}-value`
                                ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                                : <Copy className="h-3.5 w-3.5" />
                              }
                            </button>
                          </Tip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">{t('dmarcNote')}</p>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={handleCheck}
              disabled={isChecking || isReverting}
            >
              {isChecking ? t('checking') : t('checkStatusButton')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleRevert}
              disabled={isChecking || isReverting}
              className="text-muted-foreground hover:text-foreground"
            >
              {isReverting ? t('reverting') : t('revertToManagedButton')}
            </Button>
          </div>
        </div>
      )}

      {/* Send test email — always shown */}
      <div className="space-y-3 pt-2 border-t">
        <div>
          <p className="text-sm font-medium">{t('sendTestTitle')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('sendTestDescription')}</p>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="team-test-recipient">{t('recipientLabel')}</Label>
            <Input
              id="team-test-recipient"
              type="email"
              value={testRecipient}
              onChange={(e) => {
                setTestRecipient(e.target.value)
                setTestResult(null)
                setTestError(null)
              }}
              placeholder={user?.email ?? 'you@example.com'}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSendTest}
            disabled={isSendingTest}
            className="shrink-0"
          >
            {isSendingTest ? t('sendingTest') : t('sendTestButton')}
          </Button>
        </div>
        {testResult && !testResult.skipped && !testResult.testMode && (
          <p className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('sendTestSuccess', { email: testResult.email })}
          </p>
        )}
        {testResult?.skipped && (
          <p className="text-xs text-amber-600">{t('sendTestSkipped')}</p>
        )}
        {testResult?.testMode && !testResult.skipped && (
          <p className="text-xs text-muted-foreground">{t('sendTestTestMode')}</p>
        )}
        {testError && (
          <p className="text-xs text-destructive">{testError}</p>
        )}
      </div>
    </div>
  )
}

export function OutreachCards({ teamId, team }: { teamId: string; team: Team }) {
  const t = useTranslations('EmailSettings')
  const qc = useQueryClient()

  type VarRow = { key: string; value: string }
  const [vars, setVars] = useState<VarRow[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (team?.outreach_placeholders) {
      setVars(
        Object.entries(team.outreach_placeholders).map(([key, value]) => ({
          key,
          value: value as string,
        }))
      )
    }
  }, [team?.outreach_placeholders])

  const addRow = () => setVars((prev) => [...prev, { key: '', value: '' }])

  const removeRow = (idx: number) => setVars((prev) => prev.filter((_, i) => i !== idx))

  const updateRow = (idx: number, field: 'key' | 'value', val: string) =>
    setVars((prev) => prev.map((row, i) => (i === idx ? { ...row, [field]: val } : row)))

  const onSave = async () => {
    setSaveError('')
    const invalid = vars.filter((v) => v.key && !KEY_REGEX.test(v.key))
    if (invalid.length > 0) {
      setSaveError(
        t('customVariablesInvalidKeys', { keys: invalid.map((v) => v.key).join(', ') })
      )
      return
    }
    const payload = Object.fromEntries(
      vars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value])
    )
    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { outreach_placeholders: payload })
      await qc.invalidateQueries({ queryKey: ['team', teamId] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-8">
      <Card>
        <CardContent className="pt-6">
          <EmailSenderForm teamId={teamId} plan={team.plan} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-5">
        <div>
          <h3 className="font-semibold text-sm">{t('customVariablesTitle')}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {t.rich('customVariablesDescription', {
              code: (chunks) => (
                <code className="font-mono text-xs bg-muted px-1 rounded">{chunks}</code>
              ),
            })}
          </p>
        </div>

        <div className="space-y-2">
          {vars.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <div className="flex items-center border rounded-md overflow-hidden flex-1">
                <span className="px-2 py-2 text-xs text-muted-foreground bg-muted border-r select-none font-mono">
                  {'{{'}
                </span>
                <input
                  value={row.key}
                  onChange={(e) => updateRow(idx, 'key', e.target.value)}
                  placeholder="variableName"
                  className="flex-1 px-2 py-2 text-sm font-mono outline-none bg-background"
                />
                <span className="px-2 py-2 text-xs text-muted-foreground bg-muted border-l select-none font-mono">
                  {'}}'}
                </span>
              </div>
              <input
                value={row.value}
                onChange={(e) => updateRow(idx, 'value', e.target.value)}
                placeholder={t('customVariablesValuePlaceholder')}
                className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => removeRow(idx)}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>

        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-4 w-4 mr-1.5" />
          {t('customVariablesAddButton')}
        </Button>

        {saveError && <p className="text-xs text-destructive">{saveError}</p>}

        <div className="flex items-center justify-end gap-3">
          {saved && !saving && (
            <span className="text-xs text-muted-foreground">{t('customVariablesSaved')}</span>
          )}
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? t('customVariablesSaving') : t('customVariablesSaveButton')}
          </Button>
        </div>
        </CardContent>
      </Card>
    </div>
  )
}

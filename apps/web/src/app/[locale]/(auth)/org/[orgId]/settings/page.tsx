'use client'

import { PageHeader } from '@/components/layout/PageHeader'
import { OrgContactDetailsCard } from '@/components/org/OrgContactDetailsCard'
import type { Route } from 'next'
import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useOrg } from '@/contexts/OrgContext'
import { useAuth } from '@/contexts/AuthContext'
import { useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Settings, Mail, Copy, CheckCircle2, Clock, XCircle, Share2 } from 'lucide-react'
import { ORGANIZATIONS_COLLECTION } from '@linyup/shared'
import type { Organization } from '@linyup/shared'
import { useEmailSenderSettings } from '@/hooks/useEmailSenderSettings'
import { SOCIAL_PLATFORMS, SOCIAL_LABELS } from '@/lib/bioLink'
import { Tip } from '@/components/ui/tip'

// The four languages the product speaks — same set as the i18n routing. Mirrors
// TEAM_LANGUAGES in settings/team/page.tsx (same semantics: Organization.language
// is the language the org authors content in, not the reader's dashboard
// language — see the field's doc comment in packages/shared/src/types/org.ts).
const ORG_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
] as const


// ─── terminology card ─────────────────────────────────────────────────────────

/**
 * The organisation's own social profiles.
 *
 * SAME SHAPE AS A STUDIO'S — `SocialLink[]`, the same `SOCIAL_PLATFORMS` list
 * and the same labels — because the renderer is already shared: `ContactBlock`
 * reads `ctx.socialLinks` without caring which tenant filled it. The org side
 * simply never filled it, so the website's "show social links" switch could not,
 * in any state, change what a visitor saw, and was removed rather than faked.
 * This is the field that earns it back.
 *
 * ONE INPUT PER PLATFORM, not a repeatable row: the platform list is closed (the
 * renderer maps each to an icon), so a free-form "add a link" control would let
 * somebody enter a platform nothing can draw.
 */
function OrgSocialLinksCard({
  orgId,
  org,
  isAdmin,
  onSaved,
}: {
  orgId: string
  org: Organization | null
  isAdmin: boolean
  onSaved: (msg: string, type?: 'success' | 'error') => void
}) {
  const t = useTranslations('OrgSettings')
  const qc = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)

  // Seed from the stored value once it arrives, and not again — re-seeding on
  // every render would fight whatever is being typed.
  useEffect(() => {
    if (dirty) return
    const next: Record<string, string> = {}
    for (const l of org?.socialLinks ?? []) next[l.platform] = l.url
    setUrls(next)
  }, [org?.socialLinks, dirty])

  async function handleSave() {
    setSaving(true)
    try {
      // BLANKS ARE DROPPED, not stored as empty strings: the renderer filters on
      // a truthy url anyway, and a row of empty entries would make an
      // organisation with no socials look like one with six broken links.
      const socialLinks = SOCIAL_PLATFORMS.filter((pf) => (urls[pf] ?? '').trim()).map((pf) => ({
        platform: pf,
        url: urls[pf].trim(),
      }))
      await updateDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId), { socialLinks })
      qc.invalidateQueries({ queryKey: ['org', orgId] })
      setDirty(false)
      onSaved(t('saveSuccess'))
    } catch {
      onSaved(t('saveError'), 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!isAdmin) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Share2 className="h-4 w-4" />
          {t('socialTitle')}
        </CardTitle>
        <CardDescription>{t('socialDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {SOCIAL_PLATFORMS.map((platform) => (
          <div key={platform} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-sm font-medium">{SOCIAL_LABELS[platform]}</span>
            <Input
              value={urls[platform] ?? ''}
              onChange={(e) => {
                setDirty(true)
                setUrls((prev) => ({ ...prev, [platform]: e.target.value }))
              }}
              placeholder="https://"
              className="h-8 font-mono text-sm"
            />
          </div>
        ))}
        <div className="flex justify-end">
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
            {t('saveButton')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── org email sender card ────────────────────────────────────────────────────

function OrgEmailSenderCard({ orgId, isAdmin }: { orgId: string; isAdmin: boolean }) {
  const t = useTranslations('EmailSettings')
  const { user } = useAuth()
  const {
    data: config,
    isLoading,
    registerDomain,
    checkDomain,
    revertToManaged,
    isRegistering,
    isChecking,
    isReverting,
    sendTest,
    isSendingTest,
  } = useEmailSenderSettings('org', orgId)

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
      // silent — status stays as-is
    }
  }

  async function handleRevert() {
    try {
      await revertToManaged()
    } catch {
      // silent
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('orgSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Managed card */}
            <div className={`rounded-lg border p-4 space-y-1 ${!isByo ? 'border-primary/40 bg-primary/5' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{t('managedTitle')}</p>
                {!isByo && (
                  <Badge variant="secondary" className="text-xs">{t('active')}</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('managedDescription')}</p>
            </div>

            {/* BYO domain — register */}
            {!isByo && isAdmin && (
              <div className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t('byoSectionTitle')}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2 space-y-1">
                    <Label htmlFor="org-byo-domain">{t('domainLabel')}</Label>
                    <Input
                      id="org-byo-domain"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      placeholder="myorg.ch"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="org-byo-from-local">{t('fromLocalPartLabel')}</Label>
                    <Input
                      id="org-byo-from-local"
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

            {/* BYO domain active */}
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

                {isAdmin && (
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
                )}
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
                  <Label htmlFor="org-test-recipient">{t('recipientLabel')}</Label>
                  <Input
                    id="org-test-recipient"
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
        )}
      </CardContent>
    </Card>
  )
}


// ─── page ─────────────────────────────────────────────────────────────────────

export default function OrgSettingsPage() {
  const tNav = useTranslations('Org')
  const { orgId } = useParams<{ orgId: string }>()
  const t = useTranslations('OrgSettings')
  const { org, loading, isAdmin } = useOrg()
  const qc = useQueryClient()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [language, setLanguage] = useState<'en' | 'de' | 'fr' | 'it'>('en')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  useEffect(() => {
    if (org) {
      setName(org.name)
      setDescription(org.description ?? '')
      // 'en' is what the field's readers already fall back to for an org with
      // no value (resolveSiteSourceLocale), so the control shows the truth
      // rather than an empty box that implies nothing has been decided.
      setLanguage(org.language ?? 'en')
    }
  }, [org])

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3500)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      await updateDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId), {
        name: name.trim(), description: description.trim(), language,
      })
      qc.invalidateQueries({ queryKey: ['org', orgId] })
      showToast(t('saveSuccess'))
    } catch {
      showToast(t('saveError'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* THE PAGE TITLES ITSELF, like every other org page.
          It used not to: the layout printed the destination's label for any
          entry without `ownsHeader`, and this page relied on that. The flag was
          the wrong default — thirteen of fourteen org pages title themselves, so
          eight of them printed their name twice — and deleting it left this one,
          the only genuine dependant, with no title at all. The first card keeps
          its own "General" heading, because it labels that card and not the
          page. */}
      <PageHeader
        title={t('pageTitle')}
        subtitle={t('pageSubtitle')}
        // What this page NO LONGER answers. Terminology and the affiliation lock
        // moved to their own destination; a reader who came here looking for
        // them needs the way there, not a dead end.
        quickLinks={[
          { href: `/org/${orgId}/affiliation-settings` as Route, label: tNav('affiliationSettings') },
        ]}
      />

      <Card>
        <CardHeader>
          {/* "General", not "Settings": this card holds the organisation's name
              and description, and its siblings are Terminology, Lock
              affiliation and the rest. Titling it after the whole page said
              nothing about which card it is. */}
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4" />
            {t('generalTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="org-name">{t('nameLabel')}</Label>
                <Input
                  id="org-name" value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('namePlaceholder')}
                  disabled={!isAdmin} required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="org-description">{t('descriptionLabel')}</Label>
                <Input
                  id="org-description" value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('descriptionPlaceholder')}
                  disabled={!isAdmin}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="org-language">{t('language')}</Label>
                <Select
                  value={language}
                  onValueChange={(v) => setLanguage(v as 'en' | 'de' | 'fr' | 'it')}
                  disabled={!isAdmin}
                >
                  <SelectTrigger id="org-language" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ORG_LANGUAGES.map((l) => (
                      <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('languageHint')}</p>
              </div>
              {isAdmin && (
                <Button type="submit" disabled={saving || !name.trim()}>
                  {saving ? '…' : t('saveButton')}
                </Button>
              )}
            </form>
          )}
        </CardContent>
      </Card>

      <OrgContactDetailsCard orgId={orgId} org={org} isAdmin={isAdmin} onSaved={showToast} />
      <OrgSocialLinksCard orgId={orgId} org={org} isAdmin={isAdmin} onSaved={showToast} />

      <OrgEmailSenderCard orgId={orgId} isAdmin={isAdmin} />

      {toast && (
        <div className={`fixed bottom-4 right-4 px-4 py-2.5 rounded-lg shadow-lg text-sm text-white z-50 ${
          toast.type === 'error' ? 'bg-destructive' : 'bg-green-600'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

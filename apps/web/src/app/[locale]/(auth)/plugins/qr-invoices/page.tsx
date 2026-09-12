'use client'

// QR-bill invoices plugin home — a setup checklist (legal profile + plugin
// settings, the two things `createInvoice` refuses on), the settings card
// (prefix / due days / footer / language), and the team's whole invoices log,
// newest first. Pattern: plugins/tarif-595/page.tsx. Issuing itself can start
// from here too (no contact preset — the dialog shows its own ContactPicker),
// or from a contact's own Payments segment when the sale is already about them.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { CheckCircle2, FileText, Loader2, Plus } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useLegalProfile } from '@/hooks/useLegalProfile'
import {
  invoiceLangOf,
  resolveInvoiceSettings,
  validateInvoiceSettings,
  validateLegalProfile,
  type InvoiceLang,
  type InvoiceSettings,
} from '@linyup/shared'
import { formatMoneyMinor } from '@/lib/payments'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoadMoreFooter } from '@/components/ui/load-more-footer'
import { saveInvoiceSettings, useInvalidateInvoices, useInvoiceSettings, useInvoices, type InvoiceRow } from '@/plugins/qr-invoices/hooks'
import { InvoiceActions, InvoiceStatusBadge } from '@/plugins/qr-invoices/InvoiceActions'
import { CreateInvoiceDialog } from '@/plugins/qr-invoices/CreateInvoiceDialog'

function ChecklistRow({
  done,
  label,
  href,
  actionLabel,
}: {
  done: boolean
  label: string
  href?: Route
  actionLabel?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <CheckCircle2
          className={`h-4 w-4 shrink-0 ${done ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/40'}`}
        />
        <span className="truncate text-sm">{label}</span>
      </div>
      {!done && href && actionLabel && (
        <Link href={href} className="shrink-0 text-sm text-primary hover:underline">
          {actionLabel}
        </Link>
      )}
    </div>
  )
}

const INVOICE_LANGUAGES: InvoiceLang[] = ['de', 'fr', 'it', 'en']
const LANGUAGE_NATIVE_NAME: Record<InvoiceLang, string> = {
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  en: 'English',
}

/** Plain-state card in the shape of settings/emails/SmsSenderCard.tsx: a local
 *  draft, a dirty flag, one Save button — every value round-trips through
 *  `validateInvoiceSettings` directly. */
function InvoiceSettingsCard({ teamId, settings }: { teamId: string; settings: InvoiceSettings | null | undefined }) {
  const t = useTranslations('QrInvoices')
  const { team, user } = useAuth()
  const invalidate = useInvalidateInvoices(teamId)
  const defaultLang = invoiceLangOf(team?.language)
  const baseline = resolveInvoiceSettings(settings)

  const [prefix, setPrefix] = useState(baseline.prefix)
  const [dueDays, setDueDays] = useState(String(baseline.due_days))
  const [footerText, setFooterText] = useState(baseline.footer_text ?? '')
  const [language, setLanguage] = useState<InvoiceLang>(baseline.language ?? defaultLang)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const resolved = resolveInvoiceSettings(settings)
    setPrefix(resolved.prefix)
    setDueDays(String(resolved.due_days))
    setFooterText(resolved.footer_text ?? '')
    setLanguage(resolved.language ?? defaultLang)
    setSaved(false)
    // Re-derive the baseline whenever the stored settings (or the team's own
    // language, the empty-doc fallback) change — never on local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  const draft = {
    prefix: prefix.trim().toUpperCase(),
    due_days: dueDays.trim() ? Number(dueDays) : NaN,
    footer_text: footerText.trim() || null,
    language,
  }
  const issues = validateInvoiceSettings(draft)
  const hasIssue = (path: string) => issues.some((i) => i.path === path)

  const dirty =
    draft.prefix !== baseline.prefix ||
    String(draft.due_days) !== String(baseline.due_days) ||
    draft.footer_text !== (baseline.footer_text ?? null) ||
    draft.language !== (baseline.language ?? defaultLang)

  async function save() {
    if (issues.length > 0) return
    setSaving(true)
    setSaved(false)
    try {
      await saveInvoiceSettings(teamId, user?.uid ?? null, {
        prefix: draft.prefix,
        due_days: draft.due_days,
        footer_text: draft.footer_text,
        language,
      })
      invalidate()
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('settingsTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="qri-prefix">{t('settingsPrefixLabel')}</Label>
            <Input
              id="qri-prefix"
              value={prefix}
              maxLength={10}
              onChange={(e) => {
                setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                setSaved(false)
              }}
            />
            {hasIssue('prefix') && <p className="text-xs text-destructive">{t('settingsPrefixError')}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qri-due-days">{t('settingsDueDaysLabel')}</Label>
            <Input
              id="qri-due-days"
              type="number"
              min={0}
              max={365}
              value={dueDays}
              onChange={(e) => {
                setDueDays(e.target.value)
                setSaved(false)
              }}
            />
            {hasIssue('due_days') && <p className="text-xs text-destructive">{t('settingsDueDaysError')}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qri-language">{t('settingsLanguageLabel')}</Label>
            <Select
              value={language}
              onValueChange={(v) => {
                setLanguage(v as InvoiceLang)
                setSaved(false)
              }}
            >
              <SelectTrigger id="qri-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVOICE_LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {LANGUAGE_NATIVE_NAME[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qri-footer">{t('settingsFooterLabel')}</Label>
          <Textarea
            id="qri-footer"
            rows={2}
            value={footerText}
            onChange={(e) => {
              setFooterText(e.target.value)
              setSaved(false)
            }}
            placeholder={t('settingsFooterPlaceholder')}
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          {saved && !dirty && <span className="text-xs text-muted-foreground">{t('settingsSaved')}</span>}
          <Button size="sm" onClick={() => void save()} disabled={saving || !dirty || issues.length > 0}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? t('settingsSaving') : t('settingsSave')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function InvoiceRowCard({ teamId, invoice, canManage }: { teamId: string; invoice: InvoiceRow; canManage: boolean }) {
  const name = `${invoice.debtor.givenname} ${invoice.debtor.familyname}`.trim()
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{invoice.number}</span>
          <InvoiceStatusBadge status={invoice.status} />
        </div>
        <div className="truncate text-sm text-muted-foreground">{name || '—'}</div>
        {invoice.description && <div className="truncate text-xs text-muted-foreground">{invoice.description}</div>}
        <div className="text-xs text-muted-foreground">{invoice.due_on}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-sm font-medium tabular-nums">{formatMoneyMinor(invoice.amount_minor, invoice.currency)}</span>
        <InvoiceActions teamId={teamId} invoice={invoice} canManage={canManage} />
      </div>
    </li>
  )
}

export default function QrInvoicesPluginPage() {
  const t = useTranslations('QrInvoices')
  const tPlugins = useTranslations('Plugins')
  const { currentTeamId, teamRole } = useAuth()
  const teamId = currentTeamId ?? null
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()
  const canManage = teamRole === 'owner' || teamRole === 'manager'

  const { data: legalProfile, isLoading: legalLoading } = useLegalProfile(teamId)
  const { data: settings, isLoading: settingsLoading } = useInvoiceSettings(teamId)
  const invoicesQ = useInvoices(teamId)
  const [createOpen, setCreateOpen] = useState(false)

  if (pluginsLoading) return <Skeleton className="m-6 h-40" />
  if (!teamId || !isInstalled('qr-invoices')) {
    return (
      <div className="p-6 space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">{t('title')}</h1>
          <Badge variant="secondary">{tPlugins('statusBeta')}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t('notInstalled')}</p>
        <p className="text-sm text-muted-foreground">{t('installHint')}</p>
      </div>
    )
  }

  const legalIssues = validateLegalProfile(legalProfile)
  const legalDone = !legalLoading && legalIssues.length === 0
  const configDone = !settingsLoading && validateInvoiceSettings(resolveInvoiceSettings(settings)).length === 0

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <FileText className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('title')}</h1>
        <Badge variant="secondary">{tPlugins('statusBeta')}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t('overviewIntro')}</p>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('checklistTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {legalLoading || settingsLoading ? (
              <Skeleton className="h-10" />
            ) : (
              <>
                <ChecklistRow
                  done={legalDone}
                  label={t('checklistLegalProfile')}
                  href={'/settings/team?tab=payments' as Route}
                  actionLabel={t('checklistComplete')}
                />
                {/* No link — the settings card that answers this sits right below. */}
                <ChecklistRow done={configDone} label={t('checklistConfig')} />
              </>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && <InvoiceSettingsCard teamId={teamId} settings={settings} />}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">{t('invoicesTitle')}</CardTitle>
          {canManage && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('createButton')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {invoicesQ.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : invoicesQ.rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">{t('invoicesEmpty')}</p>
          ) : (
            <>
              <ul className="divide-y">
                {invoicesQ.rows.map((inv) => (
                  <InvoiceRowCard key={inv.id} teamId={teamId} invoice={inv} canManage={canManage} />
                ))}
              </ul>
              <LoadMoreFooter
                shown={invoicesQ.rows.length}
                hasMore={invoicesQ.hasMore}
                loading={invoicesQ.isLoadingMore}
                onLoadMore={invoicesQ.loadMore}
                className="border-t"
              />
            </>
          )}
        </CardContent>
      </Card>

      <CreateInvoiceDialog teamId={teamId} open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}

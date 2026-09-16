'use client'

// Opening balances — a guided interview over the EXISTING manual-entry
// callable, nothing more: studio-language questions (cash, bank, money owed,
// unpaid bills, owner loan, member prepayments), a live-computed equity line
// that balances the entry by construction, one createManualEntry call.
// No new server surface; corrections go through the entries page's Reverse,
// like any other manual entry. Defaults come from the team's chart template
// (OPENING_BALANCE_ROLE_ACCOUNTS); the owner can re-pick any active account.
// docs/accounting.md → "Workflows"; plan: docs/finance-accrual.md.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, CheckCircle2, Plus, Scale, Trash2 } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import {
  OPENING_BALANCE_ROLE_ACCOUNTS,
  formatMinorUnits,
  type AccountingAccount,
} from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  callCreateManualEntry,
  useAccounts,
  useAccountingSettings,
  useInvalidateAccounting,
} from '@/plugins/finance/hooks'
import { FinanceBetaChip } from '@/components/finance/FinanceBetaChip'

/** '12.50' → 1250 minor units; invalid/negative → null. */
function parseMajor(v: string): number | null {
  const trimmed = v.trim()
  if (!trimmed) return 0
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const [int, frac = ''] = trimmed.split('.')
  return parseInt(int, 10) * 100 + parseInt(frac.padEnd(2, '0') || '0', 10)
}

/** Most recent fiscal-year start on or before today, as 'YYYY-MM-DD'. */
function fiscalYearStartDate(startMonth: number): string {
  const now = new Date()
  const year = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1
  return `${year}-${String(startMonth).padStart(2, '0')}-01`
}

type RoleKey = 'cash' | 'bank' | 'receivables' | 'payables' | 'ownerLoan' | 'deferredIncome'

interface RoleRow {
  key: RoleKey
  type: 'asset' | 'liability'
  label: string
  hint: string
}

interface CustomLine {
  account_code: string
  amount: string
}

export default function OpeningBalancesPage() {
  const t = useTranslations('Finance')
  const { currentTeamId, teamRole } = useAuth()
  const teamId = currentTeamId ?? null
  const isOwner = teamRole === 'owner'
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()

  const { data: settings } = useAccountingSettings(teamId)
  const { data: accounts = [] } = useAccounts(teamId)
  const invalidate = useInvalidateAccounting(teamId)

  const [draftDate, setDraftDate] = useState<string | null>(null)
  const [amounts, setAmounts] = useState<Record<RoleKey, string>>({
    cash: '', bank: '', receivables: '', payables: '', ownerLoan: '', deferredIncome: '',
  })
  const [roleAccounts, setRoleAccounts] = useState<Partial<Record<RoleKey, string>>>({})
  const [customLines, setCustomLines] = useState<CustomLine[]>([])
  const [equityAccount, setEquityAccount] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [posted, setPosted] = useState<{ id: string; period: string } | null>(null)

  const roleDefaults = settings ? OPENING_BALANCE_ROLE_ACCOUNTS[settings.chart_template] : null
  const activeAccounts = useMemo(() => accounts.filter((a) => a.active), [accounts])
  const activeCodes = useMemo(() => new Set(activeAccounts.map((a) => a.code)), [activeAccounts])
  const byCode = useMemo(
    () => new Map<string, AccountingAccount>(accounts.map((a) => [a.code, a])),
    [accounts]
  )

  if (pluginsLoading) return <Skeleton className="m-6 h-40" />
  if (!teamId || !isInstalled('finance')) {
    return <p className="p-6 text-sm text-muted-foreground">{t('notInstalled')}</p>
  }

  const date = draftDate ?? fiscalYearStartDate(settings?.fiscal_year_start_month ?? 1)
  const currency = settings?.base_currency ?? 'CHF'

  const rows: RoleRow[] = [
    { key: 'cash', type: 'asset', label: t('openingCash'), hint: t('openingCashHint') },
    { key: 'bank', type: 'asset', label: t('openingBank'), hint: t('openingBankHint') },
    { key: 'receivables', type: 'asset', label: t('openingReceivables'), hint: t('openingReceivablesHint') },
    { key: 'payables', type: 'liability', label: t('openingPayables'), hint: t('openingPayablesHint') },
    { key: 'ownerLoan', type: 'liability', label: t('openingOwnerLoan'), hint: t('openingOwnerLoanHint') },
    { key: 'deferredIncome', type: 'liability', label: t('openingDeferred'), hint: t('openingDeferredHint') },
  ]

  const resolvedRoleAccount = (key: RoleKey): string => {
    const chosen = roleAccounts[key]
    if (chosen) return chosen
    const seeded = roleDefaults?.[key]
    return seeded && activeCodes.has(seeded) ? seeded : ''
  }
  const resolvedEquityAccount = (() => {
    if (equityAccount) return equityAccount
    const seeded = roleDefaults?.equity
    return seeded && activeCodes.has(seeded) ? seeded : ''
  })()

  // Live totals (minor units). Guided rows carry their side by role; custom
  // lines take theirs from the account's type.
  let assetsTotal = 0
  let liabilitiesTotal = 0
  let hasInvalid = false
  let missingAccount = false
  for (const row of rows) {
    const minor = parseMajor(amounts[row.key])
    if (minor === null) { hasInvalid = true; continue }
    if (minor === 0) continue
    if (!resolvedRoleAccount(row.key)) missingAccount = true
    if (row.type === 'asset') assetsTotal += minor
    else liabilitiesTotal += minor
  }
  for (const line of customLines) {
    const minor = parseMajor(line.amount)
    if (minor === null) { hasInvalid = true; continue }
    if (minor === 0) continue
    const account = byCode.get(line.account_code)
    if (!account) { missingAccount = true; continue }
    if (account.type === 'asset') assetsTotal += minor
    else liabilitiesTotal += minor
  }
  const equityMinor = assetsTotal - liabilitiesTotal
  const anythingEntered = assetsTotal > 0 || liabilitiesTotal > 0
  const canPost =
    isOwner &&
    !posting &&
    anythingEntered &&
    !hasInvalid &&
    !missingAccount &&
    (equityMinor === 0 || !!resolvedEquityAccount)

  const submit = async () => {
    setPosting(true)
    try {
      const lines: Array<{ account_code: string; debit: number; credit: number }> = []
      for (const row of rows) {
        const minor = parseMajor(amounts[row.key]) ?? 0
        if (minor <= 0) continue
        lines.push({
          account_code: resolvedRoleAccount(row.key),
          debit: row.type === 'asset' ? minor : 0,
          credit: row.type === 'liability' ? minor : 0,
        })
      }
      for (const line of customLines) {
        const minor = parseMajor(line.amount) ?? 0
        if (minor <= 0) continue
        const account = byCode.get(line.account_code)
        if (!account) continue
        lines.push({
          account_code: line.account_code,
          debit: account.type === 'asset' ? minor : 0,
          credit: account.type === 'asset' ? 0 : minor,
        })
      }
      if (equityMinor > 0) {
        lines.push({ account_code: resolvedEquityAccount, debit: 0, credit: equityMinor })
      } else if (equityMinor < 0) {
        lines.push({ account_code: resolvedEquityAccount, debit: -equityMinor, credit: 0 })
      }
      const { data } = await callCreateManualEntry({
        teamId,
        dateMs: new Date(`${date}T12:00:00`).getTime(),
        description: t('openingDescription', { date }),
        lines,
      })
      invalidate()
      toast.success(t('openingPosted'))
      setPosted(data)
    } catch (err) {
      console.error('[finance] opening entry failed:', err)
      toast.error(t('actionFailed'))
    } finally {
      setPosting(false)
    }
  }

  const accountSelect = (
    value: string,
    onChange: (code: string) => void,
    types: Array<AccountingAccount['type']>
  ) => (
    <Select value={value || undefined} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger className="w-full sm:w-52">
        <SelectValue placeholder={t('selectAccount')} />
      </SelectTrigger>
      <SelectContent>
        {activeAccounts
          .filter((a) => types.includes(a.type))
          .map((a) => (
            <SelectItem key={a.code} value={a.code} label={`${a.code} · ${a.name}`} />
          ))}
      </SelectContent>
    </Select>
  )

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <Link
        href={'/plugins/finance' as Route}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('backToOverview')}
      </Link>
      <div className="flex items-center gap-2">
        <Scale className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('openingTitle')}</h1>
        <FinanceBetaChip />
      </div>
      <p className="text-sm text-muted-foreground">{t('openingIntro')}</p>

      {!isOwner ? (
        <p className="text-sm text-muted-foreground">{t('openingOwnerOnly')}</p>
      ) : posted ? (
        <Card>
          <CardContent className="flex items-start gap-3 p-6">
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-green-600" />
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('openingPosted')}</p>
              <p className="text-sm text-muted-foreground">{t('openingPostedHint')}</p>
              <Link href={'/plugins/finance/entries' as Route} className="inline-block">
                <Button size="sm" variant="outline">
                  {t('openingViewEntries')}
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="p-4">
              <div className="max-w-xs space-y-1">
                <Label>{t('openingDate')}</Label>
                <Input type="date" value={date} onChange={(e) => setDraftDate(e.target.value)} />
                <p className="text-xs text-muted-foreground">{t('openingDateHint')}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-4 p-4">
              {rows.map((row) => (
                <div
                  key={row.key}
                  className="flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0 sm:flex-row sm:items-center"
                >
                  <div className="flex-1">
                    <div className="text-sm font-medium">{row.label}</div>
                    <div className="text-xs text-muted-foreground">{row.hint}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {accountSelect(
                      resolvedRoleAccount(row.key),
                      (code) => setRoleAccounts((prev) => ({ ...prev, [row.key]: code })),
                      [row.type]
                    )}
                    <Input
                      className="w-28 text-right"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amounts[row.key]}
                      onChange={(e) =>
                        setAmounts((prev) => ({ ...prev, [row.key]: e.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">{currency}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('openingCustomTitle')}</CardTitle>
              <p className="text-xs text-muted-foreground">{t('openingCustomHint')}</p>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0">
              {customLines.map((line, i) => (
                <div key={i} className="flex items-center gap-2">
                  {accountSelect(
                    line.account_code,
                    (code) =>
                      setCustomLines((ls) =>
                        ls.map((l, j) => (j === i ? { ...l, account_code: code } : l))
                      ),
                    ['asset', 'liability']
                  )}
                  <Input
                    className="w-28 text-right"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={line.amount}
                    onChange={(e) =>
                      setCustomLines((ls) =>
                        ls.map((l, j) => (j === i ? { ...l, amount: e.target.value } : l))
                      )
                    }
                  />
                  <span className="text-xs text-muted-foreground">{currency}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setCustomLines((ls) => ls.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                // 6 guided rows + the equity line are 7 of the callable's 20-line
                // cap (MANUAL_ENTRY_MAX_LINES) — stop before the server would.
                disabled={customLines.length >= 12}
                onClick={() => setCustomLines((ls) => [...ls, { account_code: '', amount: '' }])}
              >
                <Plus className="mr-1 h-4 w-4" />
                {t('addLine')}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div>
                  <div className="text-xs text-muted-foreground">{t('assets')}</div>
                  <div className="text-sm font-medium tabular-nums">
                    {formatMinorUnits(assetsTotal)} {currency}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('liabilities')}</div>
                  <div className="text-sm font-medium tabular-nums">
                    {formatMinorUnits(liabilitiesTotal)} {currency}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('openingEquity')}</div>
                  <div className="text-sm font-medium tabular-nums">
                    {formatMinorUnits(equityMinor)} {currency}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex-1">
                  <div className="text-sm font-medium">{t('openingEquity')}</div>
                  <div className="text-xs text-muted-foreground">{t('openingEquityHint')}</div>
                </div>
                {accountSelect(resolvedEquityAccount, setEquityAccount, ['equity'])}
              </div>
              {hasInvalid && (
                <p className="text-xs text-destructive">{t('tplErr_amount_invalid')}</p>
              )}
              {missingAccount && (
                <p className="text-xs text-destructive">{t('selectAccount')}</p>
              )}
              <p className="text-xs text-amber-600">{t('openingDoubleWarning')}</p>
              <Button onClick={submit} disabled={!canPost}>
                {t('openingPost')}
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

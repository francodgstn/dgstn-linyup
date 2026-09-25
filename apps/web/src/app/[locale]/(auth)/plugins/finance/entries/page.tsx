'use client'

// Accounting entries — month picker, journal table with expandable lines,
// manual-entry dialog (owner), reverse action (owner), and a client-side CSV
// download of the displayed entries (the journal export an accountant asks
// for; DATEV-format export is roadmap).

import { Fragment, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, ChevronDown, ChevronRight, Download, ListOrdered, Plus, Trash2, Undo2 } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { formatMinorUnits, monthKey, type AccountingEntry } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { EntryTemplatesSection } from '@/components/finance/EntryTemplatesSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  callCreateManualEntry,
  callReverseEntry,
  useAccounts,
  useEntries,
  useInvalidateAccounting,
} from '@/plugins/finance/hooks'
import { FinanceBetaChip } from '@/components/finance/FinanceBetaChip'

function recentMonths(): string[] {
  const months: string[] = []
  const now = new Date()
  for (let i = 0; i < 24; i += 1) {
    months.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 15)))
  }
  return months
}

interface DraftLine {
  account_code: string
  debit: string
  credit: string
}

/** '12.50' → 1250 minor units; invalid/negative → null. */
function parseMajor(v: string): number | null {
  const trimmed = v.trim()
  if (!trimmed) return 0
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const [int, frac = ''] = trimmed.split('.')
  return parseInt(int, 10) * 100 + parseInt(frac.padEnd(2, '0') || '0', 10)
}

export default function AccountingEntriesPage() {
  const t = useTranslations('Finance')
  const { currentTeamId, teamRole } = useAuth()
  const teamId = currentTeamId ?? null
  const isOwner = teamRole === 'owner'
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()

  const months = useMemo(recentMonths, [])
  const [month, setMonth] = useState(months[0])
  const { data: entries = [], isLoading } = useEntries(teamId, month)
  const { data: accounts = [] } = useAccounts(teamId)
  const invalidate = useInvalidateAccounting(teamId)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [reverseTarget, setReverseTarget] = useState<AccountingEntry | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draftDescription, setDraftDescription] = useState('')
  const [draftDate, setDraftDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [draftLines, setDraftLines] = useState<DraftLine[]>([
    { account_code: '', debit: '', credit: '' },
    { account_code: '', debit: '', credit: '' },
  ])
  const [saving, setSaving] = useState(false)

  if (pluginsLoading) return <Skeleton className="m-6 h-40" />
  if (!teamId || !isInstalled('finance')) {
    return <p className="p-6 text-sm text-muted-foreground">{t('notInstalled')}</p>
  }

  const accountName = new Map(accounts.map((a) => [a.code, a.name]))
  const activeAccounts = accounts.filter((a) => a.active)

  const draftTotals = draftLines.reduce(
    (acc, l) => {
      acc.debit += parseMajor(l.debit) ?? 0
      acc.credit += parseMajor(l.credit) ?? 0
      return acc
    },
    { debit: 0, credit: 0 }
  )
  const draftBalanced = draftTotals.debit === draftTotals.credit && draftTotals.debit > 0

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submitEntry = async () => {
    setSaving(true)
    try {
      await callCreateManualEntry({
        teamId,
        dateMs: new Date(`${draftDate}T12:00:00`).getTime(),
        description: draftDescription.trim(),
        lines: draftLines
          .filter((l) => l.account_code)
          .map((l) => ({
            account_code: l.account_code,
            debit: parseMajor(l.debit) ?? 0,
            credit: parseMajor(l.credit) ?? 0,
          })),
      })
      invalidate()
      toast.success(t('entryCreated'))
      setDialogOpen(false)
      setDraftDescription('')
      setDraftLines([
        { account_code: '', debit: '', credit: '' },
        { account_code: '', debit: '', credit: '' },
      ])
    } catch (err) {
      console.error('[finance] manual entry failed:', err)
      toast.error(t('actionFailed'))
    } finally {
      setSaving(false)
    }
  }

  const confirmReverse = async () => {
    if (!reverseTarget) return
    try {
      await callReverseEntry({ teamId, entryId: reverseTarget.id })
      invalidate()
    } catch (err) {
      console.error('[finance] reverse failed:', err)
      toast.error(t('actionFailed'))
    } finally {
      setReverseTarget(null)
    }
  }

  const downloadCsv = () => {
    const header = ['entry_id', 'date', 'period', 'source', 'status', 'description', 'account_code', 'account_name', 'debit', 'credit']
    const lines = [header.join(',')]
    for (const e of entries) {
      for (const l of e.lines) {
        lines.push(
          [
            e.id,
            e.date?.toDate?.().toISOString?.().slice(0, 10) ?? '',
            e.period,
            e.source,
            e.status,
            `"${(e.description ?? '').replace(/"/g, '""')}"`,
            l.account_code,
            `"${(accountName.get(l.account_code) ?? '').replace(/"/g, '""')}"`,
            formatMinorUnits(l.debit),
            formatMinorUnits(l.credit),
          ].join(',')
        )
      }
    }
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `linyup-entries-${teamId}-${month}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <Link
        href={'/plugins/finance' as Route}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('backToOverview')}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ListOrdered className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t('entries')}</h1>
          <FinanceBetaChip />
        </div>
        <div className="flex items-center gap-2">
          <Select value={month} onValueChange={(v) => v && setMonth(v)}>
            <SelectTrigger size="sm" className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={downloadCsv} disabled={entries.length === 0}>
            <Download className="h-4 w-4 mr-1" />
            {t('downloadCsv')}
          </Button>
          {isOwner && (
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('newEntry')}
            </Button>
          )}
        </div>
      </div>

      {/* Quick-entry templates (rent, utilities, …) — posts via createManualEntry */}
      <EntryTemplatesSection teamId={teamId} isOwner={isOwner} />

      {isLoading ? (
        <Skeleton className="h-40" />
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noEntries')}</p>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead className="w-24">{t('date')}</TableHead>
                <TableHead>{t('description')}</TableHead>
                <TableHead className="w-24">{t('source')}</TableHead>
                <TableHead className="w-28 text-right">{t('amount')}</TableHead>
                <TableHead className="w-28"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <Fragment key={entry.id}>
                  <TableRow className="cursor-pointer" onClick={() => toggleExpanded(entry.id)}>
                    <TableCell>
                      {expanded.has(entry.id) ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {entry.date?.toDate?.().toLocaleDateString?.() ?? entry.period}
                    </TableCell>
                    <TableCell className={entry.status === 'reversed' ? 'line-through opacity-60' : ''}>
                      {entry.description}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t(`source_${entry.source}`)}</Badge>
                      {entry.status === 'reversed' && (
                        <Badge variant="secondary" className="ml-1">{t('reversed')}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {formatMinorUnits(entry.total_debit)}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {isOwner && entry.status === 'posted' && (
                        <Button size="sm" variant="ghost" onClick={() => setReverseTarget(entry)}>
                          <Undo2 className="h-4 w-4 mr-1" />
                          {t('reverse')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {expanded.has(entry.id) &&
                    entry.lines.map((line, i) => (
                      <TableRow key={`${entry.id}:${i}`} className="bg-muted/40">
                        <TableCell></TableCell>
                        <TableCell className="font-mono text-xs">{line.account_code}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {accountName.get(line.account_code) ?? line.account_code}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums" colSpan={2}>
                          {line.debit > 0 && `${t('debit')} ${formatMinorUnits(line.debit)}`}
                          {line.credit > 0 && `${t('credit')} ${formatMinorUnits(line.credit)}`}
                        </TableCell>
                        <TableCell></TableCell>
                      </TableRow>
                    ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Manual entry dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('newEntry')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('date')}</Label>
                <Input type="date" value={draftDate} onChange={(e) => setDraftDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t('description')}</Label>
                <Input value={draftDescription} onChange={(e) => setDraftDescription(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              {draftLines.map((line, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select
                    value={line.account_code || undefined}
                    onValueChange={(v) =>
                      v && setDraftLines((ls) => ls.map((l, j) => (j === i ? { ...l, account_code: v } : l)))
                    }
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder={t('selectAccount')} />
                    </SelectTrigger>
                    <SelectContent>
                      {activeAccounts.map((a) => (
                        <SelectItem key={a.code} value={a.code} label={`${a.code} · ${a.name}`} />
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className="w-28 text-right"
                    placeholder={t('debit')}
                    inputMode="decimal"
                    value={line.debit}
                    onChange={(e) =>
                      setDraftLines((ls) => ls.map((l, j) => (j === i ? { ...l, debit: e.target.value, credit: '' } : l)))
                    }
                  />
                  <Input
                    className="w-28 text-right"
                    placeholder={t('credit')}
                    inputMode="decimal"
                    value={line.credit}
                    onChange={(e) =>
                      setDraftLines((ls) => ls.map((l, j) => (j === i ? { ...l, credit: e.target.value, debit: '' } : l)))
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={draftLines.length <= 2}
                    onClick={() => setDraftLines((ls) => ls.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraftLines((ls) => [...ls, { account_code: '', debit: '', credit: '' }])}
              >
                <Plus className="h-4 w-4 mr-1" />
                {t('addLine')}
              </Button>
            </div>
            <p className={`text-xs ${draftBalanced ? 'text-muted-foreground' : 'text-destructive'}`}>
              {t('debit')} {formatMinorUnits(draftTotals.debit)} · {t('credit')} {formatMinorUnits(draftTotals.credit)}
              {draftBalanced ? ` — ${t('balanced')}` : ` — ${t('unbalancedError')}`}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('cancel')}</Button>
            <Button onClick={submitEntry} disabled={!draftBalanced || !draftDescription.trim() || saving}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reverse confirmation */}
      <AlertDialog open={!!reverseTarget} onOpenChange={(open) => !open && setReverseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('reverseConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('reverseConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReverse}>{t('reverse')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

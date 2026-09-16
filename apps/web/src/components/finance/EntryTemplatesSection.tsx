'use client'

// Entry templates — the streamlined manual-entry presets (rent, utilities,
// equipment, federation fees, owner loans, …) rendered above the journal on the
// entries page. Owner: use / edit / create / delete (non-system) + recurrence
// (auto-post). Manager: read-only list. "Use" fires the EXISTING
// createManualEntry callable with the template's two balanced lines — no new
// backend surface; recurring posting is the daily materializer's job.

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronDown, LayoutTemplate, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import {
  buildTemplateLines,
  validateEntryTemplate,
  type AccountingEntryTemplate,
  type EntryTemplateDraft,
  type EntryTemplateRecurrence,
} from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  callCreateManualEntry,
  deleteEntryTemplate,
  saveEntryTemplate,
  useAccounts,
  useEntryTemplates,
  useInvalidateAccounting,
} from '@/plugins/finance/hooks'

/** '12.50' → 1250 minor units; invalid/negative → null (same idiom as the
 * manual-entry dialog on this page). */
function parseMajor(v: string): number | null {
  const trimmed = v.trim()
  if (!trimmed) return null
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const [int, frac = ''] = trimmed.split('.')
  return parseInt(int, 10) * 100 + parseInt(frac.padEnd(2, '0') || '0', 10)
}

function formatMajor(minor: number | null): string {
  return minor == null ? '' : (minor / 100).toFixed(2)
}

interface EditorState {
  id: string | null // null = new template
  system: boolean
  name: string
  debit: string
  credit: string
  amount: string
  recurrence: EntryTemplateRecurrence
  dayOfMonth: string
  monthOfYear: string
  active: boolean
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  system: false,
  name: '',
  debit: '',
  credit: '',
  amount: '',
  recurrence: 'none',
  dayOfMonth: '1',
  monthOfYear: '1',
  active: true,
}

export function EntryTemplatesSection({ teamId, isOwner }: { teamId: string; isOwner: boolean }) {
  const t = useTranslations('Finance')
  const locale = useLocale()
  const { user } = useAuth()
  const { data: templates = [], isLoading } = useEntryTemplates(teamId)
  const { data: accounts = [] } = useAccounts(teamId)
  const invalidate = useInvalidateAccounting(teamId)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [useTarget, setUseTarget] = useState<AccountingEntryTemplate | null>(null)
  const [useDate, setUseDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [useAmount, setUseAmount] = useState('')
  const [useDescription, setUseDescription] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<AccountingEntryTemplate | null>(null)
  const [saving, setSaving] = useState(false)
  const [listOpen, setListOpen] = useState(false)

  const accountName = useMemo(() => new Map(accounts.map((a) => [a.code, a.name])), [accounts])
  const activeAccounts = accounts.filter((a) => a.active)
  const monthNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'long' })
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2026, i, 15)))
  }, [locale])

  // Starter templates are seeded at install, so an empty list only means the
  // plugin predates seeding (the next "Rebuild ledger" heals it) — show the
  // section to owners anyway (they can create templates), hide it for managers.
  if (isLoading) return null
  if (templates.length === 0 && !isOwner) return null

  // Map a validateEntryTemplate machine code to its i18n message.
  const errorLabel = (code: string): string => {
    const [key, param] = code.split(':')
    return t(`tplErr_${key}` as Parameters<typeof t>[0], { code: param ?? '' })
  }

  // Every one of these opens a dialog on top of the popover; close the popover
  // first so focus isn't trapped between two stacked overlays.
  const openEditor = (tpl: AccountingEntryTemplate | null) => {
    setListOpen(false)
    if (!tpl) {
      setEditor(EMPTY_EDITOR)
      return
    }
    setEditor({
      id: tpl.id,
      system: tpl.system,
      name: tpl.name,
      debit: tpl.debit_account_code,
      credit: tpl.credit_account_code,
      amount: formatMajor(tpl.amount_minor),
      recurrence: tpl.recurrence,
      dayOfMonth: String(tpl.day_of_month ?? 1),
      monthOfYear: String(tpl.month_of_year ?? 1),
      active: tpl.active,
    })
  }

  const editorDraft = (e: EditorState): EntryTemplateDraft => ({
    name: e.name,
    debit_account_code: e.debit,
    credit_account_code: e.credit,
    amount_minor: e.amount.trim() ? parseMajor(e.amount) : null,
    recurrence: e.recurrence,
    day_of_month: e.recurrence === 'none' ? null : parseInt(e.dayOfMonth, 10),
    month_of_year: e.recurrence === 'yearly' ? parseInt(e.monthOfYear, 10) : null,
  })
  // Invalid amount text ('abc') must surface as amount_invalid, not silently
  // become null: patch it in when parse fails but the field isn't empty.
  const editorErrors = editor
    ? (() => {
        const errs = validateEntryTemplate(editorDraft(editor), activeAccounts)
        if (
          editor.amount.trim() &&
          parseMajor(editor.amount) == null &&
          !errs.includes('amount_invalid')
        ) {
          errs.push('amount_invalid')
        }
        return errs
      })()
    : []

  const submitEditor = async () => {
    if (!editor || editorErrors.length > 0 || !user) return
    setSaving(true)
    try {
      await saveEntryTemplate(
        teamId,
        { ...editorDraft(editor), active: editor.active },
        editor.id,
        user.uid
      )
      invalidate()
      toast.success(t('templateSaved'))
      setEditor(null)
    } catch (err) {
      console.error('[finance] template save failed:', err)
      toast.error(t('actionFailed'))
    } finally {
      setSaving(false)
    }
  }

  const openUse = (tpl: AccountingEntryTemplate) => {
    setListOpen(false)
    setUseTarget(tpl)
    setUseDate(new Date().toISOString().slice(0, 10))
    setUseAmount(formatMajor(tpl.amount_minor))
    setUseDescription(tpl.name)
  }

  const useAmountMinor = useTarget?.amount_minor ?? parseMajor(useAmount)
  const submitUse = async () => {
    if (!useTarget || useAmountMinor == null || useAmountMinor <= 0) return
    setSaving(true)
    try {
      await callCreateManualEntry({
        teamId,
        dateMs: new Date(`${useDate}T12:00:00`).getTime(),
        description: useDescription.trim() || useTarget.name,
        lines: buildTemplateLines(useTarget, useAmountMinor),
      })
      invalidate()
      toast.success(t('entryCreated'))
      setUseTarget(null)
    } catch (err) {
      console.error('[finance] template post failed:', err)
      toast.error(t('actionFailed'))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteEntryTemplate(teamId, deleteTarget.id)
      invalidate()
      toast.success(t('templateDeleted'))
    } catch (err) {
      console.error('[finance] template delete failed:', err)
      toast.error(t('actionFailed'))
    } finally {
      setDeleteTarget(null)
    }
  }

  const recurrenceBadge = (tpl: AccountingEntryTemplate): string | null => {
    if (tpl.recurrence === 'monthly') return t('recurrence_monthly')
    if (tpl.recurrence === 'yearly') return t('recurrence_yearly')
    return null
  }

  return (
    <div>
      <Popover open={listOpen} onOpenChange={setListOpen}>
        <PopoverTrigger render={<Button size="sm" variant="outline" />}>
          <LayoutTemplate className="h-4 w-4 mr-1" />
          {t('templatesTitle')}
          {templates.length > 0 && (
            <Badge variant="secondary" className="ml-1.5 text-[0.625rem]">
              {templates.length}
            </Badge>
          )}
          <ChevronDown className="h-3.5 w-3.5 ml-1 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[min(40rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto p-3 space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{t('templatesTitle')}</h2>
            {isOwner && (
              <Button size="sm" variant="outline" onClick={() => openEditor(null)}>
                <Plus className="h-4 w-4 mr-1" />
                {t('newTemplate')}
              </Button>
            )}
          </div>

          {templates.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('templatesEmpty')}</p>
          ) : (
            <div className="rounded-lg border divide-y">
              {templates.map((tpl) => (
                <div
                  key={tpl.id}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5 ${tpl.active ? '' : 'opacity-60'}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{tpl.name}</span>
                      {recurrenceBadge(tpl) && (
                        <Badge variant="secondary" className="text-[0.625rem]">
                          {recurrenceBadge(tpl)}
                        </Badge>
                      )}
                      {!tpl.active && (
                        <Badge variant="outline" className="text-[0.625rem]">
                          {t('inactive')}
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {tpl.debit_account_code} {accountName.get(tpl.debit_account_code) ?? ''} →{' '}
                      {tpl.credit_account_code} {accountName.get(tpl.credit_account_code) ?? ''}
                      {' · '}
                      {tpl.amount_minor != null
                        ? `${formatMajor(tpl.amount_minor)}`
                        : t('amountAskAtUse')}
                      {tpl.recurrence !== 'none' && tpl.next_run_at && (
                        <>
                          {' '}
                          · {t('nextRun')} {tpl.next_run_at.toDate().toLocaleDateString()}
                        </>
                      )}
                    </div>
                    {tpl.last_error && (
                      <p className="text-xs text-amber-600">
                        {t('templateLastError', { code: tpl.last_error })}
                      </p>
                    )}
                  </div>
                  {isOwner && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!tpl.active}
                        onClick={() => openUse(tpl)}
                      >
                        <Play className="h-3.5 w-3.5 mr-1" />
                        {t('useTemplate')}
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => openEditor(tpl)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {!tpl.system && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            setListOpen(false)
                            setDeleteTarget(tpl)
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Editor dialog */}
      <Dialog open={!!editor} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editor?.id ? t('editTemplate') : t('newTemplate')}</DialogTitle>
          </DialogHeader>
          {editor && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>{t('templateName')}</Label>
                <Input
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{t('debitAccount')}</Label>
                  <Select
                    value={editor.debit || undefined}
                    onValueChange={(v) => v && setEditor({ ...editor, debit: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('selectAccount')} />
                    </SelectTrigger>
                    <SelectContent>
                      {activeAccounts.map((a) => (
                        <SelectItem key={a.code} value={a.code} label={`${a.code} · ${a.name}`} />
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>{t('creditAccount')}</Label>
                  <Select
                    value={editor.credit || undefined}
                    onValueChange={(v) => v && setEditor({ ...editor, credit: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('selectAccount')} />
                    </SelectTrigger>
                    <SelectContent>
                      {activeAccounts.map((a) => (
                        <SelectItem key={a.code} value={a.code} label={`${a.code} · ${a.name}`} />
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{t('fixedAmount')}</Label>
                  <Input
                    inputMode="decimal"
                    placeholder={t('amountAskAtUse')}
                    value={editor.amount}
                    onChange={(e) => setEditor({ ...editor, amount: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('recurrenceLabel')}</Label>
                  <Select
                    value={editor.recurrence}
                    onValueChange={(v) =>
                      v && setEditor({ ...editor, recurrence: v as EntryTemplateRecurrence })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['none', 'monthly', 'yearly'] as const).map((r) => (
                        <SelectItem key={r} value={r}>
                          {t(`recurrence_${r}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {editor.recurrence !== 'none' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>{t('dayOfMonth')}</Label>
                    <Select
                      value={editor.dayOfMonth}
                      onValueChange={(v) => v && setEditor({ ...editor, dayOfMonth: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
                          <SelectItem key={d} value={d}>
                            {d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {editor.recurrence === 'yearly' && (
                    <div className="space-y-1">
                      <Label>{t('monthOfYear')}</Label>
                      <Select
                        value={editor.monthOfYear}
                        onValueChange={(v) => v && setEditor({ ...editor, monthOfYear: v })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {monthNames.map((name, i) => (
                            <SelectItem key={i} value={String(i + 1)}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}
              {editor.recurrence !== 'none' && (
                <p className="text-xs text-muted-foreground">{t('autoPostHint')}</p>
              )}
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={editor.active}
                  onChange={(e) => setEditor({ ...editor, active: e.target.checked })}
                />
                {t('active')}
              </label>
              {editorErrors.length > 0 && editor.name.trim() !== '' && (
                <ul className="space-y-0.5 text-xs text-destructive">
                  {editorErrors.map((code) => (
                    <li key={code}>{errorLabel(code)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={submitEditor} disabled={editorErrors.length > 0 || saving}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Use dialog */}
      <Dialog open={!!useTarget} onOpenChange={(open) => !open && setUseTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{useTarget?.name}</DialogTitle>
          </DialogHeader>
          {useTarget && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {useTarget.debit_account_code} {accountName.get(useTarget.debit_account_code) ?? ''}{' '}
                → {useTarget.credit_account_code}{' '}
                {accountName.get(useTarget.credit_account_code) ?? ''}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{t('date')}</Label>
                  <Input type="date" value={useDate} onChange={(e) => setUseDate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>{t('amount')}</Label>
                  <Input
                    inputMode="decimal"
                    value={useAmount}
                    disabled={useTarget.amount_minor != null}
                    onChange={(e) => setUseAmount(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>{t('description')}</Label>
                <Input value={useDescription} onChange={(e) => setUseDescription(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUseTarget(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={submitUse}
              disabled={saving || useAmountMinor == null || useAmountMinor <= 0}
            >
              {t('postEntry')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTemplateTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteTemplateBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{t('delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

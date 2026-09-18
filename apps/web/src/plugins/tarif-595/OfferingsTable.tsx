'use client'

// The offering → position map as a data table: one row per plan, class and
// course, with the position pickers, the unit, the pass size, the PT
// companion and the free text as cells; sortable by name and state, filtered
// by a search box and an "unmapped only" switch. Dense on purpose — a studio
// with thirty offerings maps them in one sitting, scanning down a column.
//
// A row filled by `suggestTarif595Mappings` carries `suggestion` and renders
// tinted with the model's one-line reason under the picker, until the manager
// touches its position — the page clears the mark on edit. The table itself
// decides nothing: every value is the page's row state, every change goes
// back through `onUpdate`.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { SortingState } from '@tanstack/react-table'
import { AlertTriangle, CheckCircle2, Circle, Loader2, Sparkles } from 'lucide-react'
import {
  TARIF595_FREE_TEXT_CODE,
  type Tarif595Lang,
  type Tarif595MappingSuccessor,
  type Tarif595OfferingKind,
  type Tarif595SuggestionConfidence,
  type Tarif595Unit,
} from '@linyup/shared'
import type { Tarif595PositionExpiry } from '@linyup/shared/tarif595-positions'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { PositionPicker } from './PositionPicker'

export interface OfferingRow {
  key: string
  kind: Tarif595OfferingKind
  id: string
  name: string
  position: string | null
  unit: Tarif595Unit | ''
  entries: string
  ptPosition: string | null
  customName: string
  /** Set when the position came from the model and has not been edited since. */
  suggestion: { confidence: Tarif595SuggestionConfidence; reason: string } | null
  /** The position pair that takes over from a line date on — how a mapping
   *  survives the yearly edition change without losing the old year's receipts
   *  (`Tarif595OfferingMapping.successor`). */
  successor: Tarif595MappingSuccessor | null
}

export type OfferingRowErrors = Record<string, { message?: string } | undefined> | undefined

const UNITS: Tarif595Unit[] = ['month', 'year', 'lesson', 'entry', 'flat']

/** The expiry of a position, or null when it needs no attention. */
export type ExpiryOf = (code: string | null) => Tarif595PositionExpiry | null

/** A replacement the model proposed for a row whose position expires — shown
 *  beside the row, applied only by the manager's click. */
export interface OfferingReplacement {
  position: string
  ptPosition: string | null
  reason: string
}

type RowState = 'expiring' | 'unmapped' | 'suggested' | 'mapped'

/** The worse of the row's two positions: expired beats expiring beats fine.
 *  A row that already names its successor needs no attention — the old
 *  position keeps serving the old year's lines, the successor the new year's. */
function rowExpiry(r: OfferingRow, expiryOf: ExpiryOf): Tarif595PositionExpiry | null {
  if (r.successor) return null
  const found = [expiryOf(r.position), expiryOf(r.ptPosition)].filter((e): e is Tarif595PositionExpiry => !!e && e.status !== 'ok')
  return found.find((e) => e.status === 'expired') ?? found[0] ?? null
}

function rowState(r: OfferingRow, expiryOf: ExpiryOf): RowState {
  if (!r.position) return 'unmapped'
  if (rowExpiry(r, expiryOf)) return 'expiring'
  return r.suggestion ? 'suggested' : 'mapped'
}

// What needs the manager first sorts first: a mapping that is about to stop
// working, then what was never mapped, then what is waiting for a review.
const STATE_RANK: Record<RowState, number> = { expiring: 0, unmapped: 1, suggested: 2, mapped: 3 }

export function OfferingsTable({
  rows,
  language,
  errorsByKey,
  onUpdate,
  expiryOf,
  positionLabel,
  replacements,
  onUseReplacement,
  onSuggestReplacements,
  suggestingReplacements,
}: {
  rows: OfferingRow[]
  language: Tarif595Lang
  errorsByKey: Record<string, OfferingRowErrors>
  onUpdate: (key: string, patch: Partial<OfferingRow>) => void
  expiryOf: ExpiryOf
  /** `code — official text` in the receipt language, for a proposed replacement. */
  positionLabel: (code: string) => string
  replacements: Record<string, OfferingReplacement>
  onUseReplacement: (key: string) => void
  onSuggestReplacements: () => void
  suggestingReplacements: boolean
}) {
  const t = useTranslations('Tarif595Settings')
  const [filter, setFilter] = useState('')
  const [unmappedOnly, setUnmappedOnly] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'state', desc: false }])

  const data = useMemo(() => (unmappedOnly ? rows.filter((r) => rowState(r, expiryOf) === 'unmapped') : rows), [rows, unmappedOnly, expiryOf])
  const unmapped = rows.filter((r) => rowState(r, expiryOf) === 'unmapped').length
  const expiringRows = rows.filter((r) => rowState(r, expiryOf) === 'expiring')
  // The date the banner names: the EARLIEST last valid day among the rows.
  const firstExpiry = expiringRows
    .map((r) => rowExpiry(r, expiryOf)?.validUntil ?? null)
    .filter((d): d is string => !!d)
    .sort()[0]

  const kindLabel = (kind: Tarif595OfferingKind) => (kind === 'subscription' ? t('kind.subscription') : kind === 'activity' ? t('kind.activity') : t('kind.course'))
  const unitLabel = (unit: Tarif595Unit) =>
    unit === 'month' ? t('unit.month') : unit === 'year' ? t('unit.year') : unit === 'lesson' ? t('unit.lesson') : unit === 'entry' ? t('unit.entry') : t('unit.flat')

  const columns = useMemo<Array<DataTableColumn<OfferingRow>>>(
    () => [
      {
        id: 'state',
        accessorFn: (r) => STATE_RANK[rowState(r, expiryOf)],
        header: () => <span className="sr-only">{t('table.state')}</span>,
        enableGlobalFilter: false,
        size: 36,
        cell: ({ row }) => {
          const s = rowState(row.original, expiryOf)
          const expired = s === 'expiring' && rowExpiry(row.original, expiryOf)?.status === 'expired'
          const title =
            s === 'expiring'
              ? expired
                ? t('table.stateExpired')
                : t('table.stateExpiring')
              : s === 'mapped'
                ? t('table.stateMapped')
                : s === 'suggested'
                  ? t('table.stateSuggested')
                  : t('table.stateUnmapped')
          return (
            <span title={title} className="inline-flex">
              {s === 'expiring' ? (
                <AlertTriangle className={cn('h-4 w-4', expired ? 'text-destructive' : 'text-amber-600 dark:text-amber-400')} />
              ) : s === 'mapped' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              ) : s === 'suggested' ? (
                <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground/40" />
              )}
            </span>
          )
        },
      },
      {
        id: 'name',
        accessorFn: (r) => `${r.name} ${kindLabel(r.kind)}`,
        header: () => t('offeringName'),
        size: 220,
        cell: ({ row }) => (
          <div className="min-w-44 space-y-0.5">
            <div className="text-sm font-medium leading-tight">{row.original.name}</div>
            <Badge variant="outline" className="text-xs uppercase">
              {kindLabel(row.original.kind)}
            </Badge>
          </div>
        ),
      },
      {
        id: 'position',
        accessorFn: (r) => r.position ?? '',
        header: () => t('offeringPosition'),
        enableSorting: false,
        size: 300,
        cell: ({ row }) => {
          const r = row.original
          const err = errorsByKey[r.key]?.position?.message
          return (
            <div className="min-w-64 space-y-1">
              <PositionPicker value={r.position} onChange={(code) => onUpdate(r.key, { position: code, suggestion: null })} language={language} allowExpired />
              {r.suggestion && (
                <p className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    {t('suggest.rowLabel')}
                    {r.suggestion.reason ? ` · ${r.suggestion.reason}` : ''}
                    {r.suggestion.confidence === 'low' ? ` · ${t('suggest.lowConfidence')}` : ''}
                  </span>
                </p>
              )}
              {r.successor ? (
                <p className="flex items-start gap-1 text-xs text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="min-w-0 flex-1">{t('expiry.successorLine', { date: r.successor.from, position: positionLabel(r.successor.position) })}</span>
                  <button type="button" className="shrink-0 underline underline-offset-2 hover:text-foreground" onClick={() => onUpdate(r.key, { successor: null })}>
                    {t('expiry.removeSuccessor')}
                  </button>
                </p>
              ) : (
                <ExpiryNote expiry={expiryOf(r.position)} />
              )}
              {!r.successor && replacements[r.key] && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 px-2 py-1.5 text-xs dark:border-amber-700/50 dark:bg-amber-950/30">
                  <Sparkles className="h-3 w-3 shrink-0 text-amber-700 dark:text-amber-400" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{t('expiry.replacementLabel')}: </span>
                    {positionLabel(replacements[r.key].position)}
                    {replacements[r.key].reason ? ` · ${replacements[r.key].reason}` : ''}
                  </span>
                  <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => onUseReplacement(r.key)}>
                    {t('expiry.useReplacement')}
                  </Button>
                </div>
              )}
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )
        },
      },
      {
        id: 'unit',
        accessorFn: (r) => r.unit,
        header: () => t('offeringUnit'),
        enableSorting: false,
        enableGlobalFilter: false,
        size: 150,
        cell: ({ row }) => {
          const r = row.original
          const err = errorsByKey[r.key]?.unit?.message
          return (
            <div className="min-w-32 space-y-1">
              <Select value={r.unit || undefined} onValueChange={(v) => onUpdate(r.key, { unit: v as Tarif595Unit })}>
                <SelectTrigger>
                  <SelectValue placeholder={t('offeringUnitPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => (
                    <SelectItem key={u} value={u}>
                      {unitLabel(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )
        },
      },
      {
        id: 'entries',
        accessorFn: (r) => r.entries,
        header: () => t('offeringEntries'),
        enableSorting: false,
        enableGlobalFilter: false,
        size: 90,
        cell: ({ row }) => {
          const r = row.original
          if (r.unit !== 'entry') return null
          const err = errorsByKey[r.key]?.entries?.message
          return (
            <div className="space-y-1">
              <Input type="number" min={1} value={r.entries} onChange={(e) => onUpdate(r.key, { entries: e.target.value })} className="w-20" />
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )
        },
      },
      {
        id: 'ptPosition',
        accessorFn: (r) => r.ptPosition ?? '',
        header: () => t('offeringPtPosition'),
        enableSorting: false,
        enableGlobalFilter: false,
        size: 260,
        cell: ({ row }) => {
          const r = row.original
          const err = errorsByKey[r.key]?.ptPosition?.message
          return (
            <div className="min-w-56 space-y-1">
              <PositionPicker value={r.ptPosition} onChange={(code) => onUpdate(r.key, { ptPosition: code })} language={language} allowExpired />
              <ExpiryNote expiry={expiryOf(r.ptPosition)} />
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )
        },
      },
      {
        id: 'customName',
        accessorFn: (r) => r.customName,
        header: () => t('offeringCustomText'),
        enableSorting: false,
        enableGlobalFilter: false,
        size: 220,
        cell: ({ row }) => {
          const r = row.original
          if (r.position !== TARIF595_FREE_TEXT_CODE) return null
          const err = errorsByKey[r.key]?.customName?.message
          return (
            <div className="min-w-48 space-y-1">
              <Input value={r.customName} onChange={(e) => onUpdate(r.key, { customName: e.target.value })} placeholder={t('offeringCustomTextPlaceholder')} />
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [errorsByKey, language, t, expiryOf, replacements, positionLabel]
  )

  return (
    <div className="space-y-3">
      {/* The list changes every 1 January. A mapping that is fine today can
          refuse the first receipt of the new year, so the rows it concerns are
          named here, sorted first below, and offered a replacement — proposed
          as of the day after expiry, applied only by a click. */}
      {expiringRows.length > 0 && firstExpiry && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1">{t('expiry.banner', { count: expiringRows.length, date: firstExpiry })}</p>
          <Button type="button" size="sm" variant="outline" onClick={onSuggestReplacements} disabled={suggestingReplacements}>
            {suggestingReplacements ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {suggestingReplacements ? t('suggest.running') : t('expiry.suggestReplacements')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('table.searchPlaceholder')} className="h-8 w-56" />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={unmappedOnly} onCheckedChange={setUnmappedOnly} />
          <Label className="font-normal">{t('table.unmappedOnly', { count: unmapped })}</Label>
        </label>
        <span className="ml-auto text-xs text-muted-foreground">{t('table.summary', { mapped: rows.length - unmapped, total: rows.length })}</span>
      </div>
      <DataTable
        columns={columns}
        data={data}
        getRowId={(r) => r.key}
        globalFilter={filter}
        onGlobalFilterChange={setFilter}
        sorting={sorting}
        onSortingChange={setSorting}
        emptyMessage={unmappedOnly ? t('table.allMapped') : t('offeringsNone')}
        dense
        rowClassName={(r) => cn(r.suggestion && 'bg-amber-50/50 dark:bg-amber-950/20')}
      />
    </div>
  )
}

/** "Valid until …" under a picker whose position expires soon, or no longer is. */
function ExpiryNote({ expiry }: { expiry: Tarif595PositionExpiry | null }) {
  const t = useTranslations('Tarif595Settings')
  if (!expiry || expiry.status === 'ok' || !expiry.validUntil) return null
  const expired = expiry.status === 'expired'
  return (
    <p className={cn('flex items-start gap-1 text-xs', expired ? 'text-destructive' : 'text-amber-700 dark:text-amber-400')}>
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{expired ? t('expiry.rowExpired', { date: expiry.validUntil }) : t('expiry.rowExpiring', { date: expiry.validUntil })}</span>
    </p>
  )
}

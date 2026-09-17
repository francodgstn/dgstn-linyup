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
import { CheckCircle2, Circle, Sparkles } from 'lucide-react'
import {
  TARIF595_FREE_TEXT_CODE,
  type Tarif595Lang,
  type Tarif595OfferingKind,
  type Tarif595SuggestionConfidence,
  type Tarif595Unit,
} from '@linyup/shared'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
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
}

export type OfferingRowErrors = Record<string, { message?: string } | undefined> | undefined

const UNITS: Tarif595Unit[] = ['month', 'year', 'lesson', 'entry', 'flat']

function rowState(r: OfferingRow): 'mapped' | 'suggested' | 'unmapped' {
  if (!r.position) return 'unmapped'
  return r.suggestion ? 'suggested' : 'mapped'
}

const STATE_RANK = { unmapped: 0, suggested: 1, mapped: 2 } as const

export function OfferingsTable({
  rows,
  language,
  errorsByKey,
  onUpdate,
}: {
  rows: OfferingRow[]
  language: Tarif595Lang
  errorsByKey: Record<string, OfferingRowErrors>
  onUpdate: (key: string, patch: Partial<OfferingRow>) => void
}) {
  const t = useTranslations('Tarif595Settings')
  const [filter, setFilter] = useState('')
  const [unmappedOnly, setUnmappedOnly] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'state', desc: false }])

  const data = useMemo(() => (unmappedOnly ? rows.filter((r) => rowState(r) === 'unmapped') : rows), [rows, unmappedOnly])
  const unmapped = rows.filter((r) => rowState(r) === 'unmapped').length

  const kindLabel = (kind: Tarif595OfferingKind) => (kind === 'subscription' ? t('kind.subscription') : kind === 'activity' ? t('kind.activity') : t('kind.course'))
  const unitLabel = (unit: Tarif595Unit) =>
    unit === 'month' ? t('unit.month') : unit === 'year' ? t('unit.year') : unit === 'lesson' ? t('unit.lesson') : unit === 'entry' ? t('unit.entry') : t('unit.flat')

  const columns = useMemo<Array<DataTableColumn<OfferingRow>>>(
    () => [
      {
        id: 'state',
        accessorFn: (r) => STATE_RANK[rowState(r)],
        header: () => <span className="sr-only">{t('table.state')}</span>,
        enableGlobalFilter: false,
        size: 36,
        cell: ({ row }) => {
          const s = rowState(row.original)
          const title = s === 'mapped' ? t('table.stateMapped') : s === 'suggested' ? t('table.stateSuggested') : t('table.stateUnmapped')
          return (
            <span title={title} className="inline-flex">
              {s === 'mapped' ? (
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
    [errorsByKey, language, t]
  )

  return (
    <div className="space-y-3">
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

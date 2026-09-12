'use client'

// Tarif 595 position picker — a searchable combobox over the ~250-row position
// table, grouped by chapter and labelled in the receipt language. The table is
// DATA (see the module header of packages/shared/src/data/tarif595/positions.ts
// for why it lives on its own `@linyup/shared/tarif595-positions` subpath):
// loaded lazily via a dynamic `import()` inside a `useQuery` so it never lands
// in this page's initial bundle.
//
// `useTarif595PositionsTable` is exported so the settings page can build its
// `positionExists` validation context off the SAME cache entry — one dynamic
// import serves both the picker and the resolver, never two.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import type { Tarif595Lang } from '@linyup/shared'
import type { Tarif595Chapter, Tarif595Position } from '@linyup/shared/tarif595-positions'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface Tarif595PositionsTable {
  positions: readonly Tarif595Position[]
  chapters: readonly Tarif595Chapter[]
}

export const TARIF595_POSITIONS_QUERY_KEY = ['tarif595-positions-table']

/** Lazy-loads the position table once; the query cache is shared by every
 *  PositionPicker on the page AND by the settings page's `positionExists`
 *  check, so the ~160 KB module is fetched at most once. */
export function useTarif595PositionsTable() {
  return useQuery<Tarif595PositionsTable>({
    queryKey: TARIF595_POSITIONS_QUERY_KEY,
    staleTime: Infinity,
    queryFn: async () => {
      const mod = await import('@linyup/shared/tarif595-positions')
      return { positions: mod.TARIF595_POSITIONS, chapters: mod.TARIF595_CHAPTERS }
    },
  })
}

/** Positions valid on `dateIso`, or every position when `allowExpired`. */
function visiblePositions(table: Tarif595PositionsTable, dateIso: string, allowExpired: boolean) {
  if (allowExpired) return table.positions
  return table.positions.filter((p) => dateIso >= p.valid_from && (p.valid_until === null || dateIso <= p.valid_until))
}

export interface PositionPickerProps {
  value: string | null
  onChange: (code: string | null) => void
  language: Tarif595Lang
  /** Include positions no longer valid today — needed so an already-mapped
   *  (now-expired) code stays visible and selectable rather than vanishing
   *  from its own picker. */
  allowExpired?: boolean
  disabled?: boolean
  className?: string
}

export function PositionPicker({
  value,
  onChange,
  language,
  allowExpired = false,
  disabled,
  className,
}: PositionPickerProps) {
  const t = useTranslations('Tarif595Settings')
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useTarif595PositionsTable()

  const groups = useMemo(() => {
    if (!data) return []
    const positions = visiblePositions(data, todayIso(), allowExpired)
    const byChapter = new Map<string, Tarif595Position[]>()
    for (const p of positions) {
      const list = byChapter.get(p.chapter)
      if (list) list.push(p)
      else byChapter.set(p.chapter, [p])
    }
    return data.chapters
      .map((c) => ({ chapter: c, positions: byChapter.get(c.id) ?? [] }))
      .filter((g) => g.positions.length > 0)
  }, [data, allowExpired])

  if (isLoading) return <Skeleton className={cn('h-8 w-full rounded-lg', className)} />

  const selected = data?.positions.find((p) => p.code === value) ?? null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={cn(
          'flex h-8 w-full items-center justify-between rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
          !selected && 'text-muted-foreground',
          className
        )}
      >
        <span className="flex-1 text-left truncate">
          {selected ? `${selected.code} — ${selected.text[language]}` : t('positionPlaceholder')}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={t('positionSearchPlaceholder')} />
          <CommandList>
            <CommandEmpty>{t('positionEmpty')}</CommandEmpty>
            {groups.map(({ chapter, positions }) => (
              <CommandGroup key={chapter.id} heading={chapter.title[language]}>
                {positions.map((p) => (
                  <CommandItem
                    key={p.code}
                    value={p.code}
                    keywords={[p.code, p.text[language]]}
                    onSelect={(code) => {
                      onChange(code === value ? null : code)
                      setOpen(false)
                    }}
                  >
                    <Check className={cn('mr-2 h-4 w-4', value === p.code ? 'opacity-100' : 'opacity-0')} />
                    <span className="truncate">
                      {p.code} — {p.text[language]}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

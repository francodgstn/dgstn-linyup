'use client'

// A shadcn-style data table on TanStack Table v9: the `Table` primitives with
// sorting, a global text filter and a sticky header, for the dense grids that
// outgrow a hand-rolled <Table> (the first is the Tarif 595 offerings map:
// two position pickers, a unit, a count and a text per row, over as many rows
// as the studio has plans and classes).
//
// Column definitions type against `dataTableFeatures`, so a consumer imports
// `DataTableColumn<Row>` and never repeats the features list. Cells are free
// to render inputs — the table owns nothing but order and visibility, which
// is what makes it safe to put form controls in it.

import { useMemo } from 'react'
import {
  columnFilteringFeature,
  columnSizingFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFns,
  globalFilteringFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  columnSizingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns,
})

export type DataTableColumn<TData extends RowData> = ColumnDef<typeof dataTableFeatures, TData>

export interface DataTableProps<TData extends RowData> {
  columns: Array<DataTableColumn<TData>>
  data: TData[]
  getRowId: (row: TData) => string
  /** Controlled global text filter (matched against every accessor column
   *  with `enableGlobalFilter`). */
  globalFilter?: string
  onGlobalFilterChange?: (value: string) => void
  sorting?: SortingState
  onSortingChange?: (next: SortingState) => void
  emptyMessage?: string
  /** Tighter rows for grids of controls. */
  dense?: boolean
  className?: string
  rowClassName?: (row: TData) => string | undefined
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  globalFilter,
  onGlobalFilterChange,
  sorting,
  onSortingChange,
  emptyMessage,
  dense,
  className,
  rowClassName,
}: DataTableProps<TData>) {
  const state = useMemo(
    () => ({ ...(globalFilter !== undefined ? { globalFilter } : {}), ...(sorting ? { sorting } : {}) }),
    [globalFilter, sorting]
  )
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    getRowId: (row) => getRowId(row),
    state,
    globalFilterFn: 'includesString',
    onGlobalFilterChange: (updater) => {
      if (!onGlobalFilterChange) return
      const next = typeof updater === 'function' ? updater(globalFilter ?? '') : updater
      onGlobalFilterChange(typeof next === 'string' ? next : '')
    },
    onSortingChange: (updater) => {
      if (!onSortingChange) return
      onSortingChange(typeof updater === 'function' ? updater(sorting ?? []) : updater)
    },
  })

  const rows = table.getRowModel().rows
  const cell = dense ? 'px-2 py-1.5 align-top' : 'align-top'

  return (
    <div className={cn('overflow-x-auto rounded-md border', className)}>
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
                return (
                  <TableHead key={header.id} className={cn(dense && 'h-9 px-2', 'whitespace-nowrap')} style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}>
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        <table.FlexRender header={header} />
                        {sorted === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : sorted === 'desc' ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-20 text-center text-sm text-muted-foreground">
                {emptyMessage ?? '—'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id} className={rowClassName?.(row.original)}>
                {row.getAllCells().map((c) => (
                  <TableCell key={c.id} className={cell}>
                    <table.FlexRender cell={c} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

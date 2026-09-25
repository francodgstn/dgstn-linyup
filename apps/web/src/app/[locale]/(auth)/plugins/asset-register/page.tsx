'use client'

// Asset register — the equipment list behind the statement of assets
// (docs/finance-accrual.md → "Assets", register-only slice). CASH MODE POSTS NOTHING:
// registering/editing/disposing writes only the register doc; book values are
// INDICATIVE straight-line arithmetic (shared assetBookValue), computed here
// for the list, the totals and the statement-of-assets CSV. Registration ≠
// purchase: acquired_at drives the schedule, so old equipment enters already
// part-depreciated. Depreciation POSTINGS arrive with accrual mode, not here.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { QuickLinks } from '@/components/layout/QuickLinks'
import { PluginNotInstalled } from '@/components/plugins/PluginNotInstalled'
import { toast } from 'sonner'
import { Boxes, Download, Info, Pencil, Plus, Trash2, Undo2 } from 'lucide-react'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { storage } from '@/lib/firebase'
import {
  ASSET_CATEGORIES,
  ASSET_REGISTER_SUBCOLLECTION,
  DEFAULT_USEFUL_LIFE_MONTHS,
  assetBookValue,
  assetQuantity,
  assetUnitCostMinor,
  formatMinorUnits,
  type Asset,
  type AssetCategory,
  type AssetDisposalKind,
} from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
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
import { useQueryClient } from '@tanstack/react-query'
import {
  deleteAsset,
  disposeAsset,
  saveAsset,
  useAssets,
  type AssetDraft,
} from '@/plugins/asset-register/hooks'

/** '12.50' → 1250 minor units; invalid/negative → null. */
function parseMajor(v: string): number | null {
  const trimmed = v.trim()
  if (!trimmed) return 0
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const [int, frac = ''] = trimmed.split('.')
  return parseInt(int, 10) * 100 + parseInt(frac.padEnd(2, '0') || '0', 10)
}

const MAX_PHOTO_MB = 5

async function uploadPhoto(teamId: string, assetId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const sRef = storageRef(
    storage,
    `teams/${teamId}/${ASSET_REGISTER_SUBCOLLECTION}/${assetId}/photo.${ext}`
  )
  await uploadBytes(sRef, file)
  return getDownloadURL(sRef)
}

/** Sort orders offered in the list. `acquired_desc` is the default and matches
 *  what the register shows before anyone touches a control. */
type AssetSortKey = 'acquired_desc' | 'acquired_asc' | 'name' | 'cost_desc' | 'value_desc'
const ASSET_SORT_KEYS: AssetSortKey[] = [
  'acquired_desc',
  'acquired_asc',
  'name',
  'cost_desc',
  'value_desc',
]

interface DraftState {
  name: string
  category: AssetCategory
  acquiredDate: string // 'YYYY-MM-DD'
  costText: string
  quantityText: string
  lifeText: string
  lifeTouched: boolean
  location: string
  note: string
  photoUrl: string | null
  photoFile: File | null
}

const emptyDraft = (): DraftState => ({
  name: '',
  category: 'equipment',
  acquiredDate: new Date().toISOString().slice(0, 10),
  costText: '',
  quantityText: '1',
  lifeText: String(DEFAULT_USEFUL_LIFE_MONTHS.equipment),
  lifeTouched: false,
  location: '',
  note: '',
  photoUrl: null,
  photoFile: null,
})

export default function AssetRegisterPage() {
  const t = useTranslations('AssetRegister')
  const tPlugins = useTranslations('Plugins')
  const { currentTeamId, teamRole, user, team } = useAuth()
  const teamId = currentTeamId ?? null
  // Managers maintain the register alongside owners — the head coach knows what
  // kit exists. Matches the asset_register write rule; the rules are the gate,
  // this is only what the UI offers.
  const canEdit = teamRole === 'owner' || teamRole === 'manager'
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()

  const { data: assets = [], isLoading } = useAssets(teamId)
  const qc = useQueryClient()
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['asset-register', teamId] })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftState>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [disposeTarget, setDisposeTarget] = useState<Asset | null>(null)
  const [disposeKind, setDisposeKind] = useState<AssetDisposalKind>('sold')
  const [disposeDate, setDisposeDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [proceedsText, setProceedsText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Asset | null>(null)
  // Browsing state. Client-side by design: the register is a bounded list a
  // studio can read end to end, so a query per keystroke would buy nothing and
  // cost a read. Everything below filters the array already in hand.
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<AssetCategory | 'all'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disposed'>('active')
  const [sortKey, setSortKey] = useState<AssetSortKey>('acquired_desc')

  const now = Date.now()
  const valuations = useMemo(
    () =>
      new Map(
        assets.map((a) => [
          a.id,
          assetBookValue(
            {
              cost_minor: a.cost_minor,
              useful_life_months: a.useful_life_months,
              acquired_at_ms: a.acquired_at?.toMillis?.() ?? now,
            },
            // A disposed asset's schedule stops at its disposal.
            a.status === 'disposed' ? (a.disposed_at?.toMillis?.() ?? now) : now
          ),
        ])
      ),
    [assets, now]
  )

  // WHAT THE LIST SHOWS. The totals above deliberately stay whole-register:
  // "Total cost" that silently became "total cost of the rows I am looking at"
  // is a number whose meaning depends on a control somewhere else on the page.
  // The count line under the filters is what reports the narrowing.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = assets.filter((a) => {
      if (statusFilter === 'active' && a.status === 'disposed') return false
      if (statusFilter === 'disposed' && a.status !== 'disposed') return false
      if (categoryFilter !== 'all' && a.category !== categoryFilter) return false
      if (!q) return true
      // Name, where it lives and the note — the three fields that carry words.
      return (
        a.name.toLowerCase().includes(q) ||
        (a.location ?? '').toLowerCase().includes(q) ||
        (a.note ?? '').toLowerCase().includes(q)
      )
    })
    const byName = (a: Asset, b: Asset) => a.name.localeCompare(b.name)
    const acquiredMs = (a: Asset) => a.acquired_at?.toMillis?.() ?? 0
    const book = (a: Asset) => valuations.get(a.id)?.book_value_minor ?? 0
    const sorted = [...rows]
    switch (sortKey) {
      case 'name': sorted.sort(byName); break
      case 'acquired_desc': sorted.sort((a, b) => acquiredMs(b) - acquiredMs(a) || byName(a, b)); break
      case 'acquired_asc': sorted.sort((a, b) => acquiredMs(a) - acquiredMs(b) || byName(a, b)); break
      case 'cost_desc': sorted.sort((a, b) => b.cost_minor - a.cost_minor || byName(a, b)); break
      case 'value_desc': sorted.sort((a, b) => book(b) - book(a) || byName(a, b)); break
    }
    // Disposed rows sink to the bottom whatever the sort — they are history, and
    // a sort that interleaves them makes the live register harder to read.
    return sorted.sort(
      (a, b) => (a.status === 'disposed' ? 1 : 0) - (b.status === 'disposed' ? 1 : 0)
    )
  }, [assets, search, categoryFilter, statusFilter, sortKey, valuations])

  if (pluginsLoading) return <Skeleton className="m-6 h-40" />
  if (!teamId || !isInstalled('asset-register')) {
    return (
      <PluginNotInstalled
        pluginId="asset-register"
        icon={Boxes}
        title={t('notInstalledTitle')}
        body={t('notInstalledBody')}
      />
    )
  }

  const currency = team?.default_currency ?? 'CHF'
  const active = assets.filter((a) => a.status !== 'disposed')
  const totalCost = active.reduce((s, a) => s + a.cost_minor, 0)
  const totalBook = active.reduce((s, a) => s + (valuations.get(a.id)?.book_value_minor ?? 0), 0)
  // Units vs rows: a batch row is one asset on the schedule but many things in
  // the room, and "how many do we own" is the question the register is asked.
  const totalUnits = active.reduce((s, a) => s + assetQuantity(a), 0)


  const filtersActive = search.trim() !== '' || categoryFilter !== 'all' || statusFilter !== 'active'
  const clearFilters = () => {
    setSearch('')
    setCategoryFilter('all')
    setStatusFilter('active')
  }

  const costMinor = parseMajor(draft.costText)
  const lifeMonths = /^\d+$/.test(draft.lifeText.trim()) ? parseInt(draft.lifeText, 10) : null
  const quantity = /^\d+$/.test(draft.quantityText.trim()) ? parseInt(draft.quantityText, 10) : null
  const draftValid =
    draft.name.trim().length > 0 &&
    !!draft.acquiredDate &&
    costMinor !== null &&
    costMinor > 0 &&
    lifeMonths !== null &&
    lifeMonths >= 1 &&
    quantity !== null &&
    quantity >= 1

  const openCreate = () => {
    setEditingId(null)
    setDraft(emptyDraft())
    setDialogOpen(true)
  }
  const openEdit = (a: Asset) => {
    setEditingId(a.id)
    setDraft({
      name: a.name,
      category: a.category,
      acquiredDate: a.acquired_at?.toDate?.().toISOString?.().slice(0, 10) ?? '',
      costText: formatMinorUnits(a.cost_minor),
      quantityText: String(assetQuantity(a)),
      lifeText: String(a.useful_life_months),
      lifeTouched: true,
      location: a.location ?? '',
      note: a.note ?? '',
      photoUrl: a.photoUrl ?? null,
      photoFile: null,
    })
    setDialogOpen(true)
  }

  const submit = async () => {
    if (!draftValid) return
    setSaving(true)
    try {
      const base: AssetDraft = {
        name: draft.name,
        category: draft.category,
        acquired_at_ms: new Date(`${draft.acquiredDate}T12:00:00`).getTime(),
        cost_minor: costMinor!,
        quantity: quantity!,
        useful_life_months: lifeMonths!,
        location: draft.location.trim() || null,
        note: draft.note.trim() || null,
        photoUrl: draft.photoUrl,
      }
      const id = await saveAsset(teamId, base, editingId, user?.uid ?? '')
      if (draft.photoFile) {
        const url = await uploadPhoto(teamId, id, draft.photoFile)
        await saveAsset(teamId, { ...base, photoUrl: url }, id, user?.uid ?? '')
      }
      invalidate()
      toast.success(t('assetSaved'))
      setDialogOpen(false)
    } catch (err) {
      console.error('[finance] asset save failed:', err)
      toast.error(t('actionFailed'))
    } finally {
      setSaving(false)
    }
  }

  const confirmDispose = async () => {
    if (!disposeTarget) return
    const proceeds = parseMajor(proceedsText)
    try {
      await disposeAsset(teamId, disposeTarget.id, {
        kind: disposeKind,
        disposedAtMs: new Date(`${disposeDate}T12:00:00`).getTime(),
        proceedsMinor: disposeKind === 'sold' ? (proceeds ?? 0) : null,
      })
      invalidate()
      toast.success(t('assetDisposed'))
    } catch (err) {
      console.error('[finance] asset dispose failed:', err)
      toast.error(t('actionFailed'))
    } finally {
      setDisposeTarget(null)
      setProceedsText('')
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteAsset(teamId, deleteTarget.id)
      invalidate()
      toast.success(t('assetDeleted'))
    } catch (err) {
      console.error('[finance] asset delete failed:', err)
      toast.error(t('actionFailed'))
    } finally {
      setDeleteTarget(null)
    }
  }

  const downloadStatement = () => {
    const header = [
      'name', 'category', 'location', 'acquired_at', 'quantity', 'cost', 'unit_cost',
      'useful_life_months', 'months_elapsed', 'accumulated_depreciation', 'book_value', 'status',
    ]
    const lines = [header.join(',')]
    for (const a of assets) {
      const v = valuations.get(a.id)!
      lines.push(
        [
          `"${a.name.replace(/"/g, '""')}"`,
          a.category,
          `"${(a.location ?? '').replace(/"/g, '""')}"`,
          a.acquired_at?.toDate?.().toISOString?.().slice(0, 10) ?? '',
          assetQuantity(a),
          formatMinorUnits(a.cost_minor),
          formatMinorUnits(assetUnitCostMinor(a)),
          a.useful_life_months,
          v.months_elapsed,
          formatMinorUnits(v.accumulated_minor),
          formatMinorUnits(v.book_value_minor),
          a.status,
        ].join(',')
      )
    }
    lines.push(
      ['"TOTAL (active)"', '', '', '', totalUnits, formatMinorUnits(totalCost), '', '', '',
        formatMinorUnits(totalCost - totalBook), formatMinorUnits(totalBook), ''].join(',')
    )
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `linyup-statement-of-assets-${teamId}-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Boxes className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{t('assetsTitle')}</h1>
          </div>
          {/* Finance is where these values become a statement of assets, and it
              is the page that answers "and what does this mean for my books".
              Falls back to the marketplace when it is not installed, so the way
              in survives — same as the payments page's line. */}
          <QuickLinks
            links={[
              {
                href: (isInstalled('finance')
                  ? '/plugins/finance'
                  : '/plugins?plugin=finance') as Route,
                label: tPlugins('financeNavLabel'),
              },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={downloadStatement} disabled={assets.length === 0}>
            <Download className="mr-1 h-4 w-4" />
            {t('statementCsv')}
          </Button>
          {canEdit && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t('addAsset')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 sm:max-w-md">
        {(
          [
            [
              t('assetsActiveCount'),
              totalUnits > active.length
                ? `${active.length} · ${t('assetsUnits', { count: totalUnits })}`
                : String(active.length),
            ],
            [t('assetsTotalCost'), `${formatMinorUnits(totalCost)} ${currency}`],
            [t('assetsTotalBookValue'), `${formatMinorUnits(totalBook)} ${currency}`],
          ] as Array<[string, string]>
        ).map(([label, value]) => (
          <div key={label}>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-sm font-medium tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      {/* The one thing an owner has to understand about this page: the values
          are an estimate and nothing here touches the books. It was a grey
          one-liner in accountant's words; a callout in plain words is the
          difference between being read and being skipped. */}
      <div className="flex items-start gap-2.5 rounded-lg border bg-muted/40 p-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">{t('assetsIndicativeHint')}</p>
      </div>

      {/* Browse controls. Search first because it is what people reach for; the
          two narrowing selects then the order. Wraps on a phone. */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('searchPlaceholder')}
          className="w-full sm:w-72"
        />
        <Select value={categoryFilter} onValueChange={(v) => v && setCategoryFilter(v as AssetCategory | 'all')}>
          <SelectTrigger size="sm" className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filterAllCategories')}</SelectItem>
            {ASSET_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{t(`assetCategory_${c}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v as 'all' | 'active' | 'disposed')}>
          <SelectTrigger size="sm" className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t('filterInUse')}</SelectItem>
            <SelectItem value="disposed">{t('filterDisposed')}</SelectItem>
            <SelectItem value="all">{t('filterAllStatuses')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortKey} onValueChange={(v) => v && setSortKey(v as AssetSortKey)}>
          <SelectTrigger size="sm" className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ASSET_SORT_KEYS.map((k) => (
              <SelectItem key={k} value={k}>{t(`sort_${k}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            {t('clearFilters')}
          </Button>
        )}
      </div>
      {filtersActive && (
        <p className="text-xs text-muted-foreground">
          {t('showingCount', { shown: visible.length, total: assets.length })}
        </p>
      )}

      {isLoading ? (
        <Skeleton className="h-40" />
      ) : assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('assetsEmpty')}</p>
      ) : visible.length === 0 ? (
        // An empty REGISTER and an empty RESULT are different problems: the
        // first wants "add your first item", the second wants the way back.
        <div className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          <p>{t('noMatches')}</p>
          <Button size="sm" variant="outline" onClick={clearFilters}>
            {t('clearFilters')}
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('assetName')}</TableHead>
                <TableHead className="w-32">{t('assetCategory')}</TableHead>
                <TableHead className="w-28">{t('acquiredAt')}</TableHead>
                <TableHead className="w-28 text-right">{t('assetCost')}</TableHead>
                <TableHead className="w-28 text-right">{t('bookValue')}</TableHead>
                <TableHead className="w-36"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((a) => {
                const v = valuations.get(a.id)!
                const disposed = a.status === 'disposed'
                return (
                  <TableRow key={a.id} className={disposed ? 'opacity-60' : ''}>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{a.name}</span>
                        {assetQuantity(a) > 1 && (
                          <Badge variant="outline" className="tabular-nums">
                            {`×${assetQuantity(a)}`}
                          </Badge>
                        )}
                      </div>
                      {a.location && (
                        <div className="text-xs text-muted-foreground">{a.location}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{t(`assetCategory_${a.category}`)}</TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {a.acquired_at?.toDate?.().toLocaleDateString?.() ?? '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatMinorUnits(a.cost_minor)}
                      {assetQuantity(a) > 1 && (
                        <div className="text-xs text-muted-foreground">
                          {t('assetUnitCost', {
                            amount: formatMinorUnits(assetUnitCostMinor(a)),
                          })}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatMinorUnits(v.book_value_minor)}
                    </TableCell>
                    <TableCell className="text-right">
                      {disposed ? (
                        <Badge variant="secondary">{t(`assetDisposal_${a.disposal_kind ?? 'scrapped'}`)}</Badge>
                      ) : (
                        canEdit && (
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" onClick={() => openEdit(a)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => setDisposeTarget(a)}>
                              <Undo2 className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(a)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? t('editAsset') : t('addAsset')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('assetName')}</Label>
              <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('assetCategory')}</Label>
                <Select
                  value={draft.category}
                  onValueChange={(v) =>
                    v &&
                    setDraft((d) => ({
                      ...d,
                      category: v as AssetCategory,
                      lifeText: d.lifeTouched
                        ? d.lifeText
                        : String(DEFAULT_USEFUL_LIFE_MONTHS[v as AssetCategory]),
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSET_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c} label={t(`assetCategory_${c}`)} />
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('acquiredAt')}</Label>
                <Input
                  type="date"
                  value={draft.acquiredDate}
                  onChange={(e) => setDraft((d) => ({ ...d, acquiredDate: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{`${t('assetCost')} (${currency})`}</Label>
                <Input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={draft.costText}
                  onChange={(e) => setDraft((d) => ({ ...d, costText: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">{t('assetCostHint')}</p>
              </div>
              <div className="space-y-1">
                <Label>{t('assetQuantity')}</Label>
                <Input
                  inputMode="numeric"
                  value={draft.quantityText}
                  onChange={(e) => setDraft((d) => ({ ...d, quantityText: e.target.value }))}
                />
                {/* The derived unit cost, shown only when it says something a
                    single-item row does not already say. */}
                {costMinor !== null && quantity !== null && quantity > 1 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('assetUnitCost', {
                      amount: `${formatMinorUnits(
                        assetUnitCostMinor({ cost_minor: costMinor, quantity })
                      )} ${currency}`,
                    })}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('usefulLifeMonths')}</Label>
              <Input
                inputMode="numeric"
                value={draft.lifeText}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, lifeText: e.target.value, lifeTouched: true }))
                }
              />
              <p className="text-xs text-muted-foreground">{t('usefulLifeHint')}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('assetLocation')}</Label>
                <Input value={draft.location} onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('assetNote')}</Label>
                <Input value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('assetPhoto')}</Label>
              {draft.photoUrl && !draft.photoFile && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={draft.photoUrl} alt="" className="h-20 w-20 rounded object-cover" />
              )}
              <Input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null
                  if (file && file.size > MAX_PHOTO_MB * 1024 * 1024) {
                    toast.error(t('assetPhotoTooLarge', { mb: MAX_PHOTO_MB }))
                    return
                  }
                  setDraft((d) => ({ ...d, photoFile: file }))
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('cancel')}</Button>
            <Button onClick={submit} disabled={!draftValid || saving}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dispose dialog */}
      <Dialog open={!!disposeTarget} onOpenChange={(open) => !open && setDisposeTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('disposeAsset')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{disposeTarget?.name}</p>
            <div className="space-y-1">
              <Label>{t('disposalKind')}</Label>
              <Select value={disposeKind} onValueChange={(v) => v && setDisposeKind(v as AssetDisposalKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sold" label={t('assetDisposal_sold')} />
                  <SelectItem value="scrapped" label={t('assetDisposal_scrapped')} />
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('disposalDate')}</Label>
              <Input type="date" value={disposeDate} onChange={(e) => setDisposeDate(e.target.value)} />
            </div>
            {disposeKind === 'sold' && (
              <div className="space-y-1">
                <Label>{`${t('disposalProceeds')} (${currency})`}</Label>
                <Input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={proceedsText}
                  onChange={(e) => setProceedsText(e.target.value)}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('disposalCashModeHint')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisposeTarget(null)}>{t('cancel')}</Button>
            <Button onClick={confirmDispose}>{t('disposeAsset')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteAssetTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteAssetBody')}</AlertDialogDescription>
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

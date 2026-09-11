'use client'

import { useMemo, useState } from 'react'
import { useTabParam } from '@/hooks/useTabParam'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { collection, doc, getDoc, query, updateDoc, where, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { Gift, RefreshCw, Info } from 'lucide-react'
import {
  TEAMS_COLLECTION,
  REFERRALS_COLLECTION,
} from '@linyup/shared'
import { Tip } from '@/components/ui/tip'
import { usePagedQuery } from '@/hooks/usePagedQuery'
import { useContactsByIds } from '@/hooks/useContactsByIds'
import { LoadMoreFooter } from '@/components/ui/load-more-footer'

/**
 * A referral names two people, and both ids are on the row — so both are links
 * to their records, the same fix UX-63 made on /bookings. A row whose id never
 * resolved to a name still links (the id IS the record); one with no id at all
 * stays plain text rather than linking to nothing.
 */
function ReferralPersonCell({ contactId, name }: { contactId?: string; name: string }) {
  if (!contactId) return <>{name}</>
  return (
    <Link href={`/contacts/${contactId}` as Route} className="hover:underline">
      {name}
    </Link>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ReferralStatus = 'friend_booked' | 'friend_signed_up' | 'pending_reward' | 'rewarded'
type ReferralAction = 'confirm_membership' | 'mark_rewarded'

interface Referral {
  id: string
  referrer_contact_id: string
  referred_contact_id: string
  team_id: string
  status: ReferralStatus
  reward: { reward_type: string; reward_amount: number } | null
  reward_notes: string | null
  created_at: { toDate: () => Date } | null
}

const STATUS_VALUES: ReferralStatus[] = ['friend_booked', 'friend_signed_up', 'pending_reward', 'rewarded']

const STATUS_CLASSNAMES: Record<ReferralStatus, string> = {
  friend_booked:    'bg-muted text-muted-foreground',
  friend_signed_up: 'bg-blue-100 text-blue-700',
  pending_reward:   'bg-amber-100 text-amber-700',
  rewarded:         'bg-green-100 text-green-700',
}

function StatusBadge({ status }: { status: ReferralStatus }) {
  const t = useTranslations('Referrals')
  const className = STATUS_CLASSNAMES[status] ?? 'bg-muted text-muted-foreground'
  const label = t(`statuses.${status}` as Parameters<typeof t>[0])
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  )
}

function formatDate(ts: Referral['created_at']) {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString()
}

function getActionForStatus(status: ReferralStatus): ReferralAction | null {
  if (status === 'friend_signed_up') return 'confirm_membership'
  if (status === 'pending_reward') return 'mark_rewarded'
  return null
}

// ─── Action dialog ────────────────────────────────────────────────────────────

function ActionDialog({
  open,
  action,
  referral,
  referrerName,
  referredName,
  onConfirm,
  onClose,
}: {
  open: boolean
  action: ReferralAction | null
  referral: Referral | null
  referrerName: string
  referredName: string
  onConfirm: (payload: {
    action: ReferralAction
    reward?: { reward_type: string; reward_amount: number }
    reward_notes?: string
  }) => Promise<void>
  onClose: () => void
}) {
  const t = useTranslations('Referrals')
  const [rewardType, setRewardType] = useState('')
  const [rewardAmount, setRewardAmount] = useState('')
  const [rewardNotes, setRewardNotes] = useState('')
  const [loading, setLoading] = useState(false)

  if (!action || !referral) return null

  const isMarkRewarded = action === 'mark_rewarded'

  async function handleConfirm() {
    setLoading(true)
    try {
      const payload: Parameters<typeof onConfirm>[0] = { action: action! }
      if (isMarkRewarded) {
        payload.reward = { reward_type: rewardType.trim(), reward_amount: parseFloat(rewardAmount) }
        if (rewardNotes.trim()) payload.reward_notes = rewardNotes.trim()
      }
      await onConfirm(payload)
      setRewardType(''); setRewardAmount(''); setRewardNotes('')
      onClose()
    } finally {
      setLoading(false)
    }
  }

  const confirmDisabled = loading || (isMarkRewarded && (
    !rewardType.trim() || !rewardAmount || isNaN(parseFloat(rewardAmount)) || parseFloat(rewardAmount) <= 0
  ))

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isMarkRewarded ? t('actionDialog.titleMarkRewarded') : t('actions.confirmMembership')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            <span>{t('actionDialog.referrerLabel')} </span><strong className="text-foreground">{referrerName}</strong>
            <br />
            <span>{t('actionDialog.referredLabel')} </span><strong className="text-foreground">{referredName}</strong>
          </div>
          {isMarkRewarded ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('actionDialog.rewardIntro')}</p>
              <div className="space-y-1">
                <Label htmlFor="reward-type">{t('actionDialog.rewardTypeLabel')}</Label>
                <Input
                  id="reward-type"
                  placeholder={t('actionDialog.rewardTypePlaceholder')}
                  value={rewardType}
                  onChange={(e) => setRewardType(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="reward-amount">{t('actionDialog.rewardAmountLabel')}</Label>
                <Input
                  id="reward-amount"
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder={t('actionDialog.rewardAmountPlaceholder')}
                  value={rewardAmount}
                  onChange={(e) => setRewardAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="reward-notes">{t('actionDialog.notesLabel')}</Label>
                <Textarea
                  id="reward-notes"
                  rows={2}
                  value={rewardNotes}
                  onChange={(e) => setRewardNotes(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t.rich('actionDialog.confirmMembershipText', {
                referredName,
                referrerName,
                strong: (chunks) => <strong className="text-foreground">{chunks}</strong>,
              })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>{t('actionDialog.cancel')}</Button>
          <Button onClick={handleConfirm} disabled={confirmDisabled}>
            {loading
              ? (isMarkRewarded ? t('actionDialog.saving') : t('actionDialog.confirming'))
              : (isMarkRewarded ? t('actions.markRewarded') : t('actions.confirmMembership'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

function SettingsTab({
  enabled,
  teamId,
  onToggle,
}: {
  enabled: boolean
  teamId: string
  onToggle: (v: boolean) => Promise<void>
}) {
  const t = useTranslations('Referrals')
  const [localEnabled, setLocalEnabled] = useState(enabled)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const isDirty = localEnabled !== enabled

  async function handleSave() {
    setSaving(true)
    try {
      await onToggle(localEnabled)
      toast.success(t('settings.saveSuccess'))
    } catch {
      toast.error(t('settings.saveError'))
    } finally {
      setSaving(false)
    }
  }

  async function handleGenerateCodes() {
    setGenerating(true)
    try {
      const fn = httpsCallable<{ teamId: string }, { generated: number }>(functions, 'generateReferralCodes')
      const result = await fn({ teamId })
      toast.success(t('settings.generateSuccess', { count: result.data.generated }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('settings.generateError')
      toast.error(msg)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-semibold">{t('settings.heading')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('settings.description')}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Switch
          id="referral-enabled"
          checked={localEnabled}
          onCheckedChange={setLocalEnabled}
        />
        <Label htmlFor="referral-enabled">{t('settings.enableLabel')}</Label>
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={!isDirty || saving}>
          {saving ? t('settings.saving') : t('settings.saveButton')}
        </Button>
        <Button
          variant="outline"
          onClick={handleGenerateCodes}
          disabled={generating || !localEnabled}
          title={t('settings.generateButtonTitle')}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${generating ? 'animate-spin' : ''}`} />
          {generating ? t('settings.generating') : t('settings.generateButton')}
        </Button>
      </div>
    </div>
  )
}

const REFERRALS_PAGE_SIZE = 100

function useReferralsPage(teamId: string, status: ReferralStatus | null) {
  return usePagedQuery<Referral>({
    queryKey: ['referrals', teamId, status ?? 'all'],
    pageSize: REFERRALS_PAGE_SIZE,
    base: () =>
      query(
        collection(db, REFERRALS_COLLECTION),
        where('team_id', '==', teamId),
        ...(status ? [where('status', '==', status)] : []),
        orderBy('created_at', 'desc')
      ),
    map: (d) => ({ id: d.id, ...(d.data() as Omit<Referral, 'id'>) }),
  })
}

// ─── Referrals list tab ───────────────────────────────────────────────────────

function ReferralsTab({
  teamId,
  referralEnabled,
}: {
  teamId: string
  referralEnabled: boolean
}) {
  const t = useTranslations('Referrals')
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<ReferralStatus | null>(null)
  const [selectedReferral, setSelectedReferral] = useState<Referral | null>(null)
  const [selectedAction, setSelectedAction] = useState<ReferralAction | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)

  // A PAGE of referrals, newest first, with the status filter in the QUERY (the
  // (`team_id`, `status`, `created_at`) index exists for it) — and the names it
  // needs resolved by id, not by loading every contact the studio ever had
  // (docs/scalability-2026-09.md §17 A9). A referral may name an archived or
  // deleted person; a by-id read brings them back, a live-roster read would not.
  const referralsQ = useReferralsPage(teamId, statusFilter)
  const referrals = referralsQ.rows
  const isLoading = referralsQ.isLoading
  const namedIds = useMemo(
    () => referrals.flatMap((r) => [r.referrer_contact_id, r.referred_contact_id]),
    [referrals]
  )
  const { data: contactsById } = useContactsByIds(namedIds)
  const contactName = (contactId: string) => {
    const c = contactsById?.get(contactId)
    return c ? `${c.firstname || ''} ${c.lastname || ''}`.trim() || contactId : contactId
  }

  const visible = referrals

  async function handleConfirm(payload: {
    action: ReferralAction
    reward?: { reward_type: string; reward_amount: number }
    reward_notes?: string
  }) {
    if (!selectedReferral) return
    const fn = httpsCallable<
      { referralId: string; action: ReferralAction; reward?: { reward_type: string; reward_amount: number }; reward_notes?: string },
      { success: boolean; newStatus: string }
    >(functions, 'confirmReferral')
    await fn({ referralId: selectedReferral.id, ...payload })
    toast.success(t('toasts.updateSuccess'))
    queryClient.invalidateQueries({ queryKey: ['referrals', teamId] })
  }

  const referrerName = selectedReferral ? (contactName(selectedReferral.referrer_contact_id)) : ''
  const referredName = selectedReferral ? (contactName(selectedReferral.referred_contact_id)) : ''

  const filterOptions: (ReferralStatus | null)[] = [null, ...STATUS_VALUES]

  return (
    <div className="space-y-4">
      {!referralEnabled && (
        <div className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
          {t('disabledBanner')}
        </div>
      )}

      {/* Status filters + info */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1.5 flex-wrap flex-1">
          {filterOptions.map((value) => (
            <Button
              key={String(value)}
              size="sm"
              variant={statusFilter === value ? 'secondary' : 'ghost'}
              onClick={() => setStatusFilter(value)}
            >
              {value === null ? t('filters.all') : t(`statuses.${value}` as Parameters<typeof t>[0])}
            </Button>
          ))}
        </div>
        <Tip label={t('table.statusGuide')}>
          <Button size="sm" variant="ghost" onClick={() => setInfoOpen(true)} aria-label={t('table.statusGuide')}>
            <Info className="h-4 w-4" />
          </Button>
        </Tip>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 rounded" />)}
        </div>
      ) : visible.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-12">{t('table.empty')}</p>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('table.referrer')}</TableHead>
                <TableHead>{t('table.referred')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead>{t('table.date')}</TableHead>
                <TableHead>{t('table.reward')}</TableHead>
                <TableHead className="text-right">{t('table.action')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => {
                const action = getActionForStatus(r.status)
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <ReferralPersonCell
                        contactId={r.referrer_contact_id}
                        name={contactName(r.referrer_contact_id)}
                      />
                    </TableCell>
                    <TableCell>
                      <ReferralPersonCell
                        contactId={r.referred_contact_id}
                        name={contactName(r.referred_contact_id)}
                      />
                    </TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                    <TableCell>{formatDate(r.created_at)}</TableCell>
                    <TableCell>
                      {r.reward
                        ? <span className="text-sm">{t('table.rewardFormat', { type: r.reward.reward_type, amount: r.reward.reward_amount })}</span>
                        : <span className="text-muted-foreground">{t('table.noValue')}</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {action && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setSelectedReferral(r); setSelectedAction(action) }}
                        >
                          {action === 'confirm_membership' ? t('actions.confirmMembership') : t('actions.markRewarded')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <LoadMoreFooter
            shown={visible.length}
            hasMore={referralsQ.hasMore}
            loading={referralsQ.isLoadingMore}
            onLoadMore={referralsQ.loadMore}
            className="border-t"
          />
        </div>
      )}

      <ActionDialog
        open={!!selectedReferral && !!selectedAction}
        action={selectedAction}
        referral={selectedReferral}
        referrerName={referrerName}
        referredName={referredName}
        onConfirm={handleConfirm}
        onClose={() => { setSelectedReferral(null); setSelectedAction(null) }}
      />

      {/* Status info dialog */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('statusInfo.dialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">{t('statusInfo.intro')}</p>
            {STATUS_VALUES.map((status) => (
              <div key={status} className="space-y-1">
                <StatusBadge status={status} />
                <p className="text-muted-foreground text-xs">{t(`statusInfo.description.${status}` as Parameters<typeof t>[0])}</p>
              </div>
            ))}
            <p className="text-muted-foreground text-xs pt-1">
              <strong>{t('statusInfo.flowLabel')}</strong>{' '}
              {t('statusInfo.flow', {
                friendBooked: t('statuses.friend_booked'),
                friendSignedUp: t('statuses.friend_signed_up'),
                pendingReward: t('statuses.pending_reward'),
                rewarded: t('statuses.rewarded'),
              })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInfoOpen(false)}>{t('statusInfo.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const REFERRAL_TABS = ['settings', 'referrals'] as const

export default function ReferralsPluginPage() {
  const { currentTeamId } = useAuth()
  const queryClient = useQueryClient()
  const t = useTranslations('Referrals')
  const [activeTab, setActiveTab] = useTabParam(REFERRAL_TABS, 'referrals')

  const { data: team, isLoading } = useQuery({
    queryKey: ['team-referral-settings', currentTeamId],
    enabled: !!currentTeamId,
    queryFn: async () => {
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, currentTeamId!))
      return snap.data() as { settings?: { referral?: { enabled?: boolean } } } | undefined
    },
  })

  const referralEnabled = !!team?.settings?.referral?.enabled

  const saveSettingsMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!currentTeamId) throw new Error('Not authenticated')
      await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), {
        'settings.referral.enabled': enabled,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-referral-settings', currentTeamId] })
    },
    onError: () => toast.error(t('toasts.settingsSaveError')),
  })

  if (isLoading || !currentTeamId) {
    return (
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Gift className="h-5 w-5 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('subtitle')}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {(['referrals', 'settings'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab === 'referrals' ? t('tabs.referrals') : t('tabs.settings')}
          </button>
        ))}
      </div>

      {activeTab === 'settings' && (
        <SettingsTab
          enabled={referralEnabled}
          teamId={currentTeamId}
          onToggle={(v) => saveSettingsMutation.mutateAsync(v)}
        />
      )}
      {activeTab === 'referrals' && (
        <ReferralsTab teamId={currentTeamId} referralEnabled={referralEnabled} />
      )}
    </div>
  )
}

'use client'

import { PageHeader } from '@/components/layout/PageHeader'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { collection, getDocs, query, where, getDoc, doc, getCountFromServer, limit } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { liveContactConstraints } from '@/lib/liveContacts'
import { useTranslations } from 'next-intl'
import { useOrg } from '@/contexts/OrgContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
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
import { Building2, Plus, Trash2, KeyRound } from 'lucide-react'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useParams } from 'next/navigation'
import {
  ORGANIZATIONS_COLLECTION, ORG_TEAMS_SUBCOLLECTION,
  TEAMS_COLLECTION, TEAM_MEMBERS_SUBCOLLECTION,
  USERS_COLLECTION, CONTACTS_COLLECTION,
} from '@linyup/shared'
import type { OrgTeam, TeamAccessRequest, TeamAccessType } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { Tip } from '@/components/ui/tip'

interface OrgTeamRow extends OrgTeam {
  id: string
  teamName?: string
  ownerName?: string
  activeMemberships?: number
}

function useTeamAccessRequests(orgId: string) {
  return useQuery<Record<string, TeamAccessRequest>>({
    queryKey: ['team-access-requests', orgId],
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, ORGANIZATIONS_COLLECTION, orgId, 'team_access_requests'),
      )
      const result: Record<string, TeamAccessRequest> = {}
      snap.docs.forEach((d) => { result[d.id] = { ...d.data() } as TeamAccessRequest })
      return result
    },
  })
}

function useOrgTeams(orgId: string) {
  return useQuery<OrgTeamRow[]>({
    queryKey: ['org-teams', orgId],
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_TEAMS_SUBCOLLECTION),
          where('status', 'in', ['active', 'invited'])
        )
      )
      const rows = snap.docs.map((d) => ({ ...d.data(), id: d.id } as OrgTeamRow))

      await Promise.all(
        rows.map(async (row) => {
          // EVERY ENRICHMENT HERE IS OPTIONAL, AND ONE OF THEM USED TO COST THE
          // WHOLE PAGE.
          //
          // An org admin is NOT automatically a member of the studios in the
          // organisation, and each of these reads is gated on membership rather
          // than on org role: `teams/{id}` is member-or-creator (rules ~L462),
          // `team_members` is member-only, and `users/{id}` is own-profile-only
          // ("Restricts PII (email) exposure"). For a real federation — studios
          // owned by other people — all three are denied.
          //
          // They were unguarded inside a `Promise.all`, so ONE denial rejected
          // the whole query function and the page rendered "No teams have joined
          // this organization yet." to an organisation that had two. It reads as
          // an empty org rather than as a failed read, which is why it was
          // reported as the org account having no team (Franco, 2026-08-27).
          //
          // The contacts count below already had this guard; now they all do. A
          // row that cannot be enriched loses its detail, not its existence —
          // the id is from `org_teams`, which the org admin CAN read, so the row
          // is always real even when nothing decorates it.
          const [teamDoc, ownerSnap] = await Promise.allSettled([
            getDoc(doc(db, TEAMS_COLLECTION, row.teamId)),
            getDocs(
              query(
                collection(db, TEAMS_COLLECTION, row.teamId, TEAM_MEMBERS_SUBCOLLECTION),
                where('role', '==', 'owner'),
                limit(1)
              )
            ),
          ])

          if (teamDoc.status === 'fulfilled' && teamDoc.value.exists()) {
            row.teamName = teamDoc.value.data().name
          }

          const owners = ownerSnap.status === 'fulfilled' ? ownerSnap.value : null
          if (owners && !owners.empty) {
            const ownerId = owners.docs[0].data().userId as string
            try {
              const userDoc = await getDoc(doc(db, USERS_COLLECTION, ownerId))
              if (userDoc.exists()) {
                const u = userDoc.data()
                row.ownerName = u.displayName || u.email || ownerId
              }
            } catch {
              row.ownerName = undefined
            }
          }

          // THE SAME NUMBER THE ORG DASHBOARD SHOWS, and it now asks the same
          // question — because two org pages printing different figures under
          // the organisation's own word for affiliation is worse than either
          // being wrong alone. Two things changed here:
          //
          //   LIVE CONTACTS ONLY (`liveContactConstraints`). It counted every
          //   contact that was not in the bin, archived ones included, so a
          //   studio's column included the people who had left it.
          //
          //   THIS ORGANISATION'S affiliation, and a CURRENT one. `has_active`
          //   is true for a studio's own internal club membership and for a
          //   governing body the studio merely tracks; under a column headed
          //   with the org's own term that read as the federation's coverage.
          //   `active_org_ids` answers both halves — whose, and whether it is
          //   still valid (`org_ids` would count a licence that lapsed last
          //   season). It needs the backfill; see AffiliationSummary.
          try {
            const countSnap = await getCountFromServer(
              query(
                collection(db, CONTACTS_COLLECTION),
                where('teamId', '==', row.teamId),
                ...liveContactConstraints(),
                where('affiliation_summary.active_org_ids', 'array-contains', orgId)
              )
            )
            row.activeMemberships = countSnap.data().count
          } catch {
            row.activeMemberships = undefined
          }
        })
      )
      return rows
    },
  })
}

// ─── RequestAccessDialog ──────────────────────────────────────────────────────

function RequestAccessDialog({
  open,
  orgId,
  team,
  onClose,
  onSuccess,
}: {
  open: boolean
  orgId: string
  team: OrgTeamRow | null
  onClose: () => void
  onSuccess: () => void
}) {
  const t = useTranslations('OrgTeams')
  const [accessType, setAccessType] = useState<TeamAccessType>('view')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const fn = httpsCallable(functions, 'requestTeamAccess')
      await fn({ orgId, teamId: team?.teamId, accessType })
      onSuccess()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('requestAccessTitle')}</DialogTitle>
          <DialogDescription>
            {t.rich('requestAccessDescription', {
              teamName: team?.teamName ?? team?.teamId ?? '',
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label>{t('accessLevelLabel')}</Label>
            <Select value={accessType} onValueChange={(v) => setAccessType(v as TeamAccessType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="view">{t('accessLevelView')}</SelectItem>
                <SelectItem value="manage">{t('accessLevelManage')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>{t('cancel')}</Button>
            <Button type="submit" disabled={loading}>
              {loading ? t('sending') : t('requestAccessSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── InviteDialog ─────────────────────────────────────────────────────────────

function InviteDialog({
  open,
  orgId,
  onClose,
  onSuccess,
}: {
  open: boolean
  orgId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const t = useTranslations('OrgTeams')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setLoading(true)
    setError(null)
    try {
      const fn = httpsCallable(functions, 'inviteTeamToOrg')
      await fn({ orgId, inviteeEmail: email.trim() })
      setEmail('')
      onSuccess()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('inviteTitle')}</DialogTitle>
          <DialogDescription>{t('inviteDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">{t('inviteEmail')}</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@team.example.com"
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={loading || !email.trim()}>
              {loading ? t('sending') : t('inviteSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OrgTeamsPage() {
  const { orgId } = useParams<{ orgId: string }>()
  const t = useTranslations('OrgTeams')
  const { isAdmin, affiliationTerm } = useOrg()
  const { user } = useAuth()
  const qc = useQueryClient()
  const { data: teams, isLoading } = useOrgTeams(orgId)
  const { data: accessRequests } = useTeamAccessRequests(orgId)

  const [inviteOpen, setInviteOpen] = useState(false)
  const [requestAccessTarget, setRequestAccessTarget] = useState<OrgTeamRow | null>(null)
  const [removeTarget, setRemoveTarget] = useState<OrgTeamRow | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Client-side, over the rows already in hand — the studio name is the only
  // thing anyone types here, and it is denormalised onto the row for the table.
  const term = search.trim().toLowerCase()
  const visible = useMemo(() => {
    const rows = teams ?? []
    if (!term) return rows
    return rows.filter((row) => (row.teamName ?? row.teamId).toLowerCase().includes(term))
  }, [teams, term])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['org-teams', orgId] })
    qc.invalidateQueries({ queryKey: ['team-access-requests', orgId] })
  }

  async function handleRemove() {
    if (!removeTarget) return
    setActionLoading(true)
    try {
      const fn = httpsCallable(functions, 'removeTeamFromOrg')
      await fn({ orgId: orgId, teamId: removeTarget.teamId })
      showToast(t('removedSuccess'))
      invalidate()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Error')
    } finally {
      setActionLoading(false)
      setRemoveTarget(null)
    }
  }

  function statusVariant(status: string) {
    if (status === 'active') return 'default' as const
    if (status === 'invited') return 'secondary' as const
    return 'outline' as const
  }

  function statusLabel(status: string) {
    if (status === 'active') return t('statusActive')
    if (status === 'invited') return t('statusInvited')
    return t('statusRemoved')
  }

  function formatDate(ts: { seconds: number } | null | undefined) {
    if (!ts) return ''
    return new Date(ts.seconds * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        action={
          isAdmin ? (
            <Button onClick={() => setInviteOpen(true)} size="sm">
              <Plus className="h-4 w-4 mr-1.5" />
              {t('inviteButton')}
            </Button>
          ) : undefined
        }
      />

      {/* Search — mounted once there is a list to narrow. A field over a page
          that has no teams yet is a control with nothing to do. */}
      {!isLoading && (teams?.length ?? 0) > 0 && (
        <div className="max-w-xs">
          <SearchInput
            className="h-9 text-sm"
            placeholder={t('searchPlaceholder')}
            value={search}
            onValueChange={setSearch}
          />
        </div>
      )}

      <div className="rounded-md border">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : !teams || teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <Building2 className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-muted-foreground text-sm">{t('noTeams')}</p>
            {isAdmin && (
              <Button variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" />
                {t('inviteButton')}
              </Button>
            )}
          </div>
        ) : visible.length === 0 ? (
          // Its own copy, not `noTeams` — a search that matched nothing and an
          // organization with no teams are different situations, and reusing the
          // second reads as the teams having disappeared.
          <div className="py-16 text-center text-muted-foreground text-sm">
            {t('emptySearch', { query: search.trim() })}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colTeam')}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3 hidden md:table-cell">{t('colOwner')}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3 hidden sm:table-cell">{t('colJoined')}</th>
                {/* THE TENANT'S OWN NOUN, verbatim and on its own. It was
                    `Active {affiliationTerm.toLowerCase()}` — hardcoded English
                    in a four-locale product, and a `toLowerCase()` on arbitrary
                    tenant text that reads as a typo in German, where nouns are
                    capitalised ("Aktive lizenz"). The word alone is unambiguous
                    in a table of the organisation's own studios, and it is
                    exactly what the dashboard figure showing this number is
                    captioned with. */}
                <th className="text-right font-medium text-muted-foreground px-4 py-3 hidden sm:table-cell">{affiliationTerm}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colStatus')}</th>
                {isAdmin && <th className="px-4 py-3 w-12" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((row) => (
                <tr key={row.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium">{row.teamName ?? row.teamId}</td>
                  <td className="px-4 py-3 text-muted-foreground text-sm hidden md:table-cell">
                    {row.ownerName ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                    {formatDate(row.joined as { seconds: number } | null | undefined)}
                  </td>
                  <td className="px-4 py-3 text-right hidden sm:table-cell">
                    {row.activeMemberships ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {/* Request Access button — only show for active teams */}
                        {row.status === 'active' && (() => {
                          const req = accessRequests?.[row.teamId]
                          if (req?.status === 'pending' && req.requestedBy === user?.uid) {
                            return (
                              <Badge variant="secondary" className="text-xs font-normal">
                                Access requested
                              </Badge>
                            )
                          }
                          if (req?.status === 'approved') {
                            return (
                              <Badge variant="default" className="text-xs font-normal">
                                Access granted
                              </Badge>
                            )
                          }
                          return (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 text-xs text-muted-foreground"
                              onClick={() => setRequestAccessTarget(row)}
                            >
                              <KeyRound className="h-3.5 w-3.5 mr-1" />
                              Request access
                            </Button>
                          )
                        })()}
                        {row.status === 'active' && (
                          <Tip label={t('removeButton')}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => setRemoveTarget(row)}
                              aria-label={t('removeButton')}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </Tip>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <InviteDialog
        open={inviteOpen}
        orgId={orgId}
        onClose={() => setInviteOpen(false)}
        onSuccess={() => { invalidate(); showToast(t('inviteSentSuccess')) }}
      />

      <RequestAccessDialog
        open={!!requestAccessTarget}
        orgId={orgId}
        team={requestAccessTarget}
        onClose={() => setRequestAccessTarget(null)}
        onSuccess={() => { invalidate(); showToast('Access request sent to team owner') }}
      />

      <AlertDialog open={!!removeTarget} onOpenChange={(v) => !v && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmRemoveTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmRemoveMessage', { name: removeTarget?.teamName ?? removeTarget?.teamId ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              disabled={actionLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {actionLoading ? t('processing') : t('removeButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {toast && (
        <div className="fixed bottom-4 right-4 px-4 py-2.5 rounded-lg shadow-lg text-sm text-white bg-green-600 z-50">
          {toast}
        </div>
      )}
    </div>
  )
}

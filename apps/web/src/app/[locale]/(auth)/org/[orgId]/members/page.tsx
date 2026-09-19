'use client'

import { PageHeader } from '@/components/layout/PageHeader'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { collection, getDocs, query as firestoreQuery } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/contexts/AuthContext'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { UserPlus, Trash2, MailX, Clock } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import {
  ORGANIZATIONS_COLLECTION,
  ORG_MEMBERS_SUBCOLLECTION,
  ORG_MEMBER_INVITATIONS_SUBCOLLECTION,
} from '@linyup/shared'
import type { OrgMember, OrgMemberInvitation, OrgRole } from '@linyup/shared'
import { Tip } from '@/components/ui/tip'
import { callFunction } from '@/lib/callFunction'

interface OrgMemberRow extends OrgMember {
  id: string
  displayName?: string
  email?: string
}

interface OrgInvitationRow extends OrgMemberInvitation {
  id: string
}

function useOrgMembers(orgId: string) {
  return useQuery<OrgMemberRow[]>({
    queryKey: ['org-members', orgId],
    queryFn: async () => {
      const snap = await getDocs(
        firestoreQuery(collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_MEMBERS_SUBCOLLECTION))
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id } as OrgMemberRow))
    },
  })
}

// ─── invitations ──────────────────────────────────────────────────────────────

/** Pending + recently-closed invitations, read straight from Firestore. The rule
 *  (org_member_invitations) allows org_admin only — an org_viewer would be
 *  refused, so the query is mounted behind `isAdmin`. */
function useOrgInvitations(orgId: string, enabled: boolean) {
  return useQuery<OrgInvitationRow[]>({
    queryKey: ['org-member-invitations', orgId],
    enabled,
    queryFn: async () => {
      const snap = await getDocs(
        firestoreQuery(
          collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_MEMBER_INVITATIONS_SUBCOLLECTION)
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as OrgInvitationRow)
    },
  })
}

// ─── InviteMemberDialog ───────────────────────────────────────────────────────

function InviteMemberDialog({
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
  const t = useTranslations('OrgMembers')
  const locale = useLocale()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('org_admin')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setLoading(true)
    setError(null)
    try {
      // AN INVITATION, not a grant. `addOrgMember` (UX-34) could only ever add
      // an address that ALREADY had a Linyup account and refused every other
      // one with "no_account" — a dead end with nothing on the other side of
      // it. `inviteOrgMember` (packages/functions/src/orgs/memberInvitations.ts)
      // works either way: the person accepts for themselves, creating an account
      // on the way in if they need one.
      //
      // `locale` only pins the language of the emailed link (the studio's admin
      // is the best signal we have for the invitee's); the server validates it.
      const fn = callFunction('inviteOrgMember')
      await fn({ orgId, email: email.trim(), role, locale })
      setEmail('')
      onSuccess()
      onClose()
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code ?? ''
      setError(
        code === 'functions/already-exists'
          ? t('inviteAlreadyMember')
          : code === 'functions/invalid-argument'
            ? t('inviteBadEmail')
            : err instanceof Error
              ? err.message
              : 'Unknown error'
      )
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
            <Label htmlFor="add-email">{t('addEmail')}</Label>
            <Input
              id="add-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-role">{t('addRole')}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as OrgRole)}>
              <SelectTrigger id="add-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="org_admin">{t('role_org_admin')}</SelectItem>
                <SelectItem value="org_viewer">{t('role_org_viewer')}</SelectItem>
              </SelectContent>
            </Select>
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

export default function OrgMembersPage() {
  const { orgId } = useParams<{ orgId: string }>()
  const t = useTranslations('OrgMembers')
  const { user } = useAuth()
  const { isAdmin } = useOrg()
  const qc = useQueryClient()
  const { data: members, isLoading } = useOrgMembers(orgId)
  const { data: invitations } = useOrgInvitations(orgId, isAdmin)

  const [addOpen, setAddOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<OrgMemberRow | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<OrgInvitationRow | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Client-side, over the rows already in hand. Name and email are matched
  // separately rather than against one joined string, so a query cannot match by
  // straddling the boundary between them.
  const term = search.trim().toLowerCase()
  const visible = useMemo(() => {
    const rows = members ?? []
    if (!term) return rows
    return rows.filter(
      (m) =>
        (m.displayName ?? '').toLowerCase().includes(term) ||
        (m.email ?? '').toLowerCase().includes(term)
    )
  }, [members, term])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['org-members', orgId] })
    qc.invalidateQueries({ queryKey: ['org-member-invitations', orgId] })
  }

  // Only PENDING rows are shown. An expired one is swept to 'expired' by
  // expireOrgMemberInvitations (a daily task) — but the deadline is also
  // compared here, so a row whose sweep has not run yet is not offered as live.
  // Nothing on this page depends on the sweep having happened.
  //
  // The search narrows this list too: the two lists are one roster of people as
  // far as the person typing is concerned, and a pending invitation that stayed
  // on screen while the members table narrowed would look like a match.
  const pendingInvitations = (invitations ?? []).filter(
    (i) =>
      i.status === 'pending' &&
      (!i.expires_at || (i.expires_at as unknown as { seconds: number }).seconds * 1000 > Date.now()) &&
      (!term || i.email.toLowerCase().includes(term))
  )

  async function handleRevoke() {
    if (!revokeTarget) return
    setActionLoading(true)
    try {
      const fn = callFunction('revokeOrgMemberInvitation')
      await fn({ orgId, invitationId: revokeTarget.id })
      showToast(t('inviteRevoked'))
      invalidate()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Error')
    } finally {
      setActionLoading(false)
      setRevokeTarget(null)
    }
  }

  async function handleRoleChange(m: OrgMemberRow, role: OrgRole) {
    if (role === m.role) return
    setActionLoading(true)
    try {
      const fn = callFunction('updateOrgMemberRole')
      await fn({ orgId, userId: m.userId, role })
      showToast(t('roleChangedSuccess'))
      invalidate()
    } catch (err: unknown) {
      // 'last admin' is a precondition, not a bug — an org that demotes its
      // only admin locks everyone out, so the server refuses and says which.
      const code = (err as { code?: string } | null)?.code ?? ''
      showToast(
        code === 'functions/failed-precondition'
          ? t('lastAdminBlocked')
          : err instanceof Error
            ? err.message
            : 'Error'
      )
    } finally {
      setActionLoading(false)
    }
  }

  async function handleRemove() {
    if (!removeTarget) return
    setActionLoading(true)
    try {
      const fn = callFunction('removeOrgMember')
      await fn({ orgId: orgId, userId: removeTarget.userId })
      showToast(t('removedSuccess'))
      invalidate()
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code ?? ''
      showToast(
        code === 'functions/failed-precondition'
          ? t('lastAdminBlocked')
          : err instanceof Error
            ? err.message
            : 'Error'
      )
    } finally {
      setActionLoading(false)
      setRemoveTarget(null)
    }
  }

  function roleLabel(role: OrgRole) {
    return role === 'org_admin' ? t('role_org_admin') : t('role_org_viewer')
  }

  function formatDate(ts: { seconds: number } | null | undefined) {
    if (!ts) return ''
    return new Date(ts.seconds * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        action={
          isAdmin ? (
            <Button onClick={() => setAddOpen(true)} size="sm">
              <UserPlus className="h-4 w-4 mr-1.5" />
              {t('inviteButton')}
            </Button>
          ) : undefined
        }
      />

      {/* Search — mounted once there is a list to narrow. A field over a page
          that has no members yet is a control with nothing to do. */}
      {!isLoading && (members?.length ?? 0) > 0 && (
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
            {[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : !members || members.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">{t('noMembers')}</div>
        ) : visible.length === 0 ? (
          // Its own copy, not `noMembers` — a search that matched nothing and an
          // organization with no other members are different situations, and
          // reusing the second reads as the members having disappeared.
          <div className="p-8 text-center text-muted-foreground text-sm">
            {t('emptySearch', { query: search.trim() })}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colMember')}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3">{t('colRole')}</th>
                <th className="text-left font-medium text-muted-foreground px-4 py-3 hidden sm:table-cell">{t('colAdded')}</th>
                {isAdmin && <th className="px-4 py-3 w-12" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((m) => {
                const isSelf = m.userId === user?.uid
                return (
                  <tr key={m.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium">{m.displayName ?? m.email ?? m.userId}</div>
                      {isSelf && <span className="text-xs text-muted-foreground">({t('you')})</span>}
                    </td>
                    <td className="px-4 py-3">
                      {isAdmin ? (
                        <Select
                          value={m.role}
                          onValueChange={(v) => handleRoleChange(m, v as OrgRole)}
                          disabled={actionLoading}
                        >
                          <SelectTrigger
                            className="h-8 w-[150px]"
                            aria-label={t('roleChange')}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="org_admin">{t('role_org_admin')}</SelectItem>
                            <SelectItem value="org_viewer">{t('role_org_viewer')}</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant={m.role === 'org_admin' ? 'default' : 'secondary'}>
                          {roleLabel(m.role)}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                      {formatDate(m.joined as { seconds: number } | null | undefined)}
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        {!isSelf && (
                          <Tip label={t('removeButton')}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => setRemoveTarget(m)}
                              aria-label={t('removeButton')}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </Tip>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pending invitations — people who have been asked but have not accepted
          yet. Deliberately a SEPARATE list from the members table: an invitation
          is not a membership, and showing the two together is how a list starts
          claiming an organisation has an admin it does not have. */}
      {isAdmin && pendingInvitations.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            {t('pendingTitle')}
          </h3>
          <div className="rounded-md border divide-y">
            {pendingInvitations.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{inv.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('pendingExpires', { date: formatDate(inv.expires_at as unknown as { seconds: number }) })}
                  </div>
                </div>
                <Badge variant="secondary">{roleLabel(inv.role)}</Badge>
                <Tip label={t('inviteRevoke')}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => setRevokeTarget(inv)}
                    aria-label={t('inviteRevoke')}
                  >
                    <MailX className="h-4 w-4" />
                  </Button>
                </Tip>
              </div>
            ))}
          </div>
        </div>
      )}

      <InviteMemberDialog
        open={addOpen}
        orgId={orgId}
        onClose={() => setAddOpen(false)}
        onSuccess={() => { invalidate(); showToast(t('inviteSuccess')) }}
      />

      <AlertDialog open={!!revokeTarget} onOpenChange={(v) => !v && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmRevokeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmRevokeMessage', { email: revokeTarget?.email ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              disabled={actionLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {actionLoading ? t('processing') : t('inviteRevoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!removeTarget} onOpenChange={(v) => !v && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmRemoveTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmRemoveMessage')}</AlertDialogDescription>
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

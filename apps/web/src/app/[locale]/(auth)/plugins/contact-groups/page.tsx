'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import {
  doc, updateDoc, arrayUnion, arrayRemove,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useActiveContacts } from '@/hooks/useActiveContacts'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { Link, useRouter } from '@/i18n/navigation'
import type { Route } from 'next'
import { CONTACTS_COLLECTION, personInitials } from '@linyup/shared'
import type { Contact, ContactGroup } from '@linyup/shared'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from 'sonner'
import { FolderTree, Plus, ChevronRight, MoreHorizontal, Pencil, Trash2, FolderPlus, Users, X, Check, FolderOpen, Zap } from 'lucide-react'
import { GroupPickerPopover } from '@/plugins/contact-groups/GroupPickerPopover'
import {
  useContactGroups, useInvalidateContactGroups, buildGroupTree, groupWithDescendantIds,
  createGroup, updateGroup, deleteGroup, freezeGroupToManual,
  contactMatchesGroup, groupsForContact, isDynamicGroup, useContactFilterContext,
} from '@/plugins/contact-groups/hooks'
import type { GroupTreeNode } from '@/plugins/contact-groups/hooks'
import { GroupRuleDialog, stashRuleForContactsPage } from '@/plugins/contact-groups/GroupRuleDialog'
import { Tip } from '@/components/ui/tip'

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Sentinel `selectedId` for the "not in any group" bucket. Not a group id —
 *  no such document exists — so it must never be passed to group mutations. */
const UNGROUPED_ID = '__ungrouped__'

const GROUP_COLORS = [
  '#6b7280', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
]


// The roster comes through the ONE hook (`@/hooks/useActiveContacts`). This
// page declared a copy "with the same key as the contacts page" — but the key
// had drifted (three segments to the hook's four), so it was a second fetch of
// the whole roster after all (docs/scalability-2026-09.md §17 A7). A count
// aggregation for the manual groups was considered and not added: the page
// holds the roster anyway — the dynamic groups and the member list are derived
// from it, lazily, by design — so a count query would be a read on top of the
// read, not instead of it.

// ─── create / rename dialog ───────────────────────────────────────────────────

function GroupFormDialog({
  open, onOpenChange, title, initialName, initialColor, isCreate, onSubmit,
}: {
  open: boolean; onOpenChange: (v: boolean) => void
  title: string
  initialName?: string
  initialColor?: string | null
  /** Create, not edit — only then is the dynamic-group route worth offering. */
  isCreate?: boolean
  onSubmit: (name: string, color: string | null) => Promise<void>
}) {
  const t = useTranslations('ContactGroups')
  const [name, setName] = useState(initialName ?? '')
  const [color, setColor] = useState<string | null>(initialColor ?? null)
  const [busy, setBusy] = useState(false)

  // Reset fields each time the dialog opens for a (possibly different) group
  const [lastOpen, setLastOpen] = useState(false)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) { setName(initialName ?? ''); setColor(initialColor ?? null) }
  }

  const handleSubmit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    try { await onSubmit(trimmed, color); onOpenChange(false) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1">
            <label className="text-sm font-medium">{t('fieldName')}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('fieldColor')}</label>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setColor(null)}
                className={`h-7 w-7 rounded-full border-2 flex items-center justify-center transition-all ${
                  color === null ? 'border-primary' : 'border-transparent hover:border-border'
                }`}
              ><X className="h-3.5 w-3.5 text-muted-foreground" /></button>
              {GROUP_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)}
                  className={`h-7 w-7 rounded-full border-2 transition-all ${
                    color === c ? 'border-primary scale-110' : 'border-transparent hover:scale-105'
                  }`}
                  style={{ background: c }}
                >
                  {color === c && <Check className="h-3.5 w-3.5 text-white mx-auto" />}
                </button>
              ))}
            </div>
          </div>
          {/* THE OTHER KIND OF GROUP, named where you'd look for it.
              A dynamic group cannot be created here — its membership IS a
              contact filter, so it can only be born from one, and the entry
              point sits inside the saved-filters popover on the Contacts page.
              Nothing on this page said so, which left this form quietly unable
              to make half of what "group" means, with no explanation.
              Create only: when editing an existing group this is just noise. */}
          {isCreate && (
            <div className="rounded-lg border border-dashed p-3 space-y-2">
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Zap className="h-3.5 w-3.5 shrink-0 text-violet-500 mt-px" />
                <span>{t('dynamicHint')}</span>
              </p>
              <Link
                href={'/contacts' as Route}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                {t('dynamicHintCta')}
                <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          )}
        </div>
        <DialogFooter>
          <button onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
            {t('cancel')}
          </button>
          <button onClick={handleSubmit} disabled={busy || !name.trim()}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            {t('save')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── add members dialog ───────────────────────────────────────────────────────

function AddMembersDialog({
  open, onOpenChange, group, contacts, onAdded,
}: {
  open: boolean; onOpenChange: (v: boolean) => void
  group: ContactGroup
  contacts: Contact[]
  onAdded: () => void
}) {
  const t = useTranslations('ContactGroups')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const [lastOpen, setLastOpen] = useState(false)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) { setSearch(''); setPicked(new Set()) }
  }

  const candidates = useMemo(() => {
    const sq = search.trim().toLowerCase()
    return contacts
      .filter((c) => !(c.group_ids ?? []).includes(group.id))
      .filter((c) => !sq || `${c.firstname} ${c.lastname}`.toLowerCase().includes(sq))
  }, [contacts, group.id, search])

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleAdd = async () => {
    if (picked.size === 0) return
    setBusy(true)
    try {
      await Promise.all([...picked].map((id) =>
        updateDoc(doc(db, CONTACTS_COLLECTION, id), { group_ids: arrayUnion(group.id) })
      ))
      onAdded()
      onOpenChange(false)
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('addMembersTitle', { name: group.name })}</DialogTitle></DialogHeader>
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('searchContacts')}
        />
        <div className="max-h-64 overflow-y-auto space-y-0.5 -mx-1 px-1">
          {candidates.map((c) => (
            <button key={c.id} type="button" onClick={() => toggle(c.id)}
              className="flex items-center gap-2.5 w-full px-2 py-1.5 text-sm rounded-lg hover:bg-accent transition-colors text-left"
            >
              <span className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                picked.has(c.id) ? 'bg-primary border-primary' : 'border-input'
              }`}>
                {picked.has(c.id) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
              </span>
              <span className="h-7 w-7 rounded-full shrink-0 flex items-center justify-center bg-muted text-muted-foreground text-[10px] font-semibold">
                {personInitials(c)}
              </span>
              <span className="truncate">{c.firstname} {c.lastname}</span>
            </button>
          ))}
          {candidates.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">{t('noContactsToAdd')}</p>
          )}
        </div>
        <DialogFooter>
          <button onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
            {t('cancel')}
          </button>
          <button onClick={handleAdd} disabled={busy || picked.size === 0}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            {t('addCount', { count: picked.size })}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── group tree row ───────────────────────────────────────────────────────────

function GroupRow({
  node, selectedId, expanded, onToggleExpand, onSelect, directCounts, totalCounts,
  onAddSub, onRename, onDelete, onViewRule,
}: {
  node: GroupTreeNode
  selectedId: string | null
  expanded: Set<string>
  onToggleExpand: (id: string) => void
  onSelect: (id: string) => void
  directCounts: Map<string, number>
  totalCounts: Map<string, number>
  onAddSub: (g: ContactGroup) => void
  onRename: (g: ContactGroup) => void
  onDelete: (g: ContactGroup) => void
  onViewRule: (g: ContactGroup) => void
}) {
  const t = useTranslations('ContactGroups')
  const { group, children, depth } = node
  const isExpanded = expanded.has(group.id)
  const isSelected = selectedId === group.id
  const direct = directCounts.get(group.id) ?? 0
  const total = totalCounts.get(group.id) ?? 0

  return (
    <>
      <div
        className={`flex items-center gap-1 rounded-lg transition-colors group ${
          isSelected ? 'bg-primary/10' : 'hover:bg-muted/60'
        }`}
        style={{ paddingLeft: `${depth * 20}px` }}
      >
        <button type="button"
          onClick={() => children.length > 0 && onToggleExpand(group.id)}
          className={`p-1.5 rounded text-muted-foreground transition-transform ${
            children.length > 0 ? 'hover:text-foreground' : 'opacity-0 pointer-events-none'
          } ${isExpanded ? 'rotate-90' : ''}`}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => onSelect(group.id)}
          className="flex-1 flex items-center gap-2 py-2 text-left min-w-0"
        >
          <span className="h-2.5 w-2.5 rounded-full shrink-0 border border-border/40"
            style={{ background: group.color ?? 'transparent' }} />
          <span className={`text-sm truncate ${isSelected ? 'font-semibold' : 'font-medium'}`}>{group.name}</span>
          {/* Derived membership, marked in the tree so a manual and a dynamic
              group are never mistaken for each other at a glance. */}
          {isDynamicGroup(group) && (
            <Zap className="h-3 w-3 shrink-0 text-violet-500" aria-label={t('dynamicBadge')} />
          )}
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {total > direct ? `${direct} · ${total}` : direct}
          </span>
        </button>
        <Popover>
          <PopoverTrigger
            className="p-1.5 mr-1 rounded text-muted-foreground opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 hover:text-foreground transition-all"
            aria-label={t('groupActions')}
          >
            <MoreHorizontal className="h-4 w-4" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48 p-1">
            <button type="button" onClick={() => onAddSub(group)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-muted transition-colors text-left">
              <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />{t('addSubgroup')}
            </button>
            {isDynamicGroup(group) && (
              <button type="button" onClick={() => onViewRule(group)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-muted transition-colors text-left">
                <Zap className="h-4 w-4 shrink-0 text-violet-500" />{t('viewRule')}
              </button>
            )}
            <button type="button" onClick={() => onRename(group)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-muted transition-colors text-left">
              <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" />{t('editGroup')}
            </button>
            <button type="button" onClick={() => onDelete(group)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-destructive hover:bg-destructive/10 transition-colors text-left">
              <Trash2 className="h-4 w-4 shrink-0" />{t('deleteGroup')}
            </button>
          </PopoverContent>
        </Popover>
      </div>
      {isExpanded && children.map((child) => (
        <GroupRow key={child.group.id} node={child} selectedId={selectedId} expanded={expanded}
          onToggleExpand={onToggleExpand} onSelect={onSelect}
          directCounts={directCounts} totalCounts={totalCounts}
          onAddSub={onAddSub} onRename={onRename} onDelete={onDelete} onViewRule={onViewRule} />
      ))}
    </>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function ContactGroupsPage() {
  const t = useTranslations('ContactGroups')
  const { currentTeamId, user } = useAuth()
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()
  const router = useRouter()
  const qc = useQueryClient()

  const { data: groups = [], isLoading: groupsLoading } = useContactGroups(currentTeamId)
  const { data: contacts = [], isLoading: contactsLoading } = useActiveContacts(currentTeamId)
  const invalidateGroups = useInvalidateContactGroups(currentTeamId)
  const invalidateContacts = () => qc.invalidateQueries({ queryKey: ['contacts'] })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [formMode, setFormMode] = useState<
    | { kind: 'create'; parent: ContactGroup | null }
    | { kind: 'edit'; group: ContactGroup }
    | null
  >(null)
  const [confirmDelete, setConfirmDelete] = useState<ContactGroup | null>(null)
  const [addMembersOpen, setAddMembersOpen] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')
  const [includeSubgroups, setIncludeSubgroups] = useState(false)
  const [ruleGroup, setRuleGroup] = useState<ContactGroup | null>(null)

  const filterCtx = useContactFilterContext(groups)
  const tree = useMemo(() => buildGroupTree(groups), [groups])
  const selectedGroup = groups.find((g) => g.id === selectedId) ?? null
  // The "Ungrouped" bucket isn't a group — it's the absence of one, so it can't
  // live in the tree (no id, no parent, nothing to rename or delete). It's a
  // sentinel selection instead, which keeps `groups` honestly the real groups.
  const ungroupedSelected = selectedId === UNGROUPED_ID
  // "In no group" must account for dynamic groups too — someone matched by a
  // rule is filed, even though nothing was written to their group_ids.
  const ungrouped = useMemo(
    () => contacts.filter((c) => groupsForContact(c, groups, filterCtx).length === 0),
    [contacts, groups, filterCtx]
  )

  // Member counts, direct and including descendants. Both go through
  // contactMatchesGroup so a MANUAL group counts its group_ids and a DYNAMIC one
  // resolves its rule — the caller never branches on which kind it is.
  const { directCounts, totalCounts } = useMemo(() => {
    const direct = new Map<string, number>()
    const total = new Map<string, number>()
    for (const g of groups) {
      direct.set(g.id, contacts.filter((c) => contactMatchesGroup(c, g, filterCtx)).length)
      const ids = groupWithDescendantIds(groups, g.id)
      const targets = groups.filter((x) => ids.has(x.id))
      total.set(g.id, contacts.filter((c) => targets.some((x) => contactMatchesGroup(c, x, filterCtx))).length)
    }
    return { directCounts: direct, totalCounts: total }
  }, [contacts, groups, filterCtx])

  const members = useMemo(() => {
    const sq = memberSearch.trim().toLowerCase()
    const bySearch = (c: Contact) =>
      !sq || `${c.firstname} ${c.lastname}`.toLowerCase().includes(sq)
    if (ungroupedSelected) return ungrouped.filter(bySearch)
    if (!selectedGroup) return []
    const ids = includeSubgroups
      ? groupWithDescendantIds(groups, selectedGroup.id)
      : new Set([selectedGroup.id])
    const targets = groups.filter((g) => ids.has(g.id))
    return contacts
      .filter((c) => targets.some((g) => contactMatchesGroup(c, g, filterCtx)))
      .filter(bySearch)
  }, [contacts, groups, selectedGroup, includeSubgroups, memberSearch, ungroupedSelected, ungrouped, filterCtx])

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleFormSubmit = async (name: string, color: string | null) => {
    if (!currentTeamId || !user || !formMode) return
    try {
      if (formMode.kind === 'create') {
        const id = await createGroup(currentTeamId, user.uid, {
          name, parent_id: formMode.parent?.id ?? null, color: color ?? undefined,
        })
        if (formMode.parent) setExpanded((prev) => new Set(prev).add(formMode.parent!.id))
        setSelectedId(id)
      } else {
        await updateGroup(currentTeamId, formMode.group.id, { name, color: color ?? null } as Partial<ContactGroup>, groups)
      }
      invalidateGroups()
    } catch {
      toast.error(t('errorSave'))
    }
  }

  const handleDelete = async () => {
    if (!currentTeamId || !confirmDelete) return
    try {
      await deleteGroup(currentTeamId, confirmDelete, groups)
      if (selectedId === confirmDelete.id) setSelectedId(null)
      invalidateGroups()
      invalidateContacts()
      toast.success(t('deletedToast', { name: confirmDelete.name }))
    } catch {
      toast.error(t('errorSave'))
    } finally {
      setConfirmDelete(null)
    }
  }

  // Freeze a dynamic group. One atomic batch where it fits, so the group can
  // never be left carrying BOTH a rule and stored membership — see
  // freezeGroupToManual.
  const handleConvertToManual = async (memberIds: string[]) => {
    if (!currentTeamId || !ruleGroup) return
    try {
      await freezeGroupToManual(currentTeamId, ruleGroup.id, memberIds)
      invalidateGroups()
      invalidateContacts()
      toast.success(t('convertedToast', { name: ruleGroup.name }))
    } catch {
      toast.error(t('errorSave'))
    }
  }

  const removeMember = async (contactId: string) => {
    if (!selectedGroup) return
    await updateDoc(doc(db, CONTACTS_COLLECTION, contactId), { group_ids: arrayRemove(selectedGroup.id) })
    invalidateContacts()
  }

  const isLoading = pluginsLoading || groupsLoading

  // ── not installed gate ──
  if (!pluginsLoading && !isInstalled('contact-groups')) {
    return (
      <div className="max-w-md mx-auto text-center py-24 space-y-4">
        <FolderTree className="h-10 w-10 mx-auto text-muted-foreground/40" />
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('notInstalled')}</p>
        <button type="button" onClick={() => router.push('/settings/plugins' as Route)}
          className="inline-flex items-center px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
          {t('goToPlugins')}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t('subtitle')}</p>
        </div>
        <button type="button" onClick={() => setFormMode({ kind: 'create', parent: null })}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors shrink-0">
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">{t('newGroup')}</span>
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(280px,2fr)_3fr] items-start">
        {/* Tree */}
        <div className="rounded-xl border bg-card p-2">
          {isLoading && (
            <div className="space-y-2 p-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 rounded-lg" />)}
            </div>
          )}
          {!isLoading && tree.length === 0 && (
            <div className="text-center py-12 px-4 space-y-2">
              <FolderTree className="h-8 w-8 mx-auto text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('emptyState')}</p>
            </div>
          )}
          {!isLoading && tree.map((node) => (
            <GroupRow key={node.group.id} node={node} selectedId={selectedId} expanded={expanded}
              onToggleExpand={toggleExpand} onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
              directCounts={directCounts} totalCounts={totalCounts}
              onAddSub={(g) => setFormMode({ kind: 'create', parent: g })}
              onRename={(g) => setFormMode({ kind: 'edit', group: g })}
              onDelete={(g) => setConfirmDelete(g)}
              onViewRule={(g) => setRuleGroup(g)} />
          ))}
          {/* Ungrouped — below a divider because it is NOT a group: it can't be
              renamed, nested, deleted or added to, and it's the one bucket that
              shrinks as you do the work. Hidden when everyone is filed. */}
          {!isLoading && ungrouped.length > 0 && (
            <>
              <div className="my-1.5 border-t" />
              <button
                type="button"
                onClick={() => setSelectedId(ungroupedSelected ? null : UNGROUPED_ID)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                  ungroupedSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                }`}
              >
                <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm truncate">{t('ungrouped')}</span>
                <Badge variant="secondary" className="ml-auto text-xs tabular-nums">
                  {ungrouped.length}
                </Badge>
              </button>
            </>
          )}
        </div>

        {/* Members panel */}
        <div className="rounded-xl border bg-card overflow-hidden">
          {!selectedGroup && !ungroupedSelected ? (
            <div className="text-center py-16 px-4 text-sm text-muted-foreground">
              <Users className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
              {t('selectGroupHint')}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b bg-muted/30">
                {ungroupedSelected ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <span className="h-2.5 w-2.5 rounded-full shrink-0 border border-border/40"
                    style={{ background: selectedGroup!.color ?? 'transparent' }} />
                )}
                <span className="font-semibold text-sm">
                  {ungroupedSelected ? t('ungrouped') : selectedGroup!.name}
                </span>
                <Badge variant="secondary" className="text-xs tabular-nums">{members.length}</Badge>
                {/* Subgroups and bulk-add are group-only: "ungrouped" has no
                    children, and you file people OUT of it, not into it. */}
                {!ungroupedSelected && isDynamicGroup(selectedGroup) && (
                  <Badge variant="outline" className="gap-1 text-[10px] border-violet-500/40 text-violet-600 dark:text-violet-400">
                    <Zap className="h-2.5 w-2.5" />{t('dynamicBadge')}
                  </Badge>
                )}
                {!ungroupedSelected && (
                  <>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto cursor-pointer">
                      <input type="checkbox" checked={includeSubgroups}
                        onChange={(e) => setIncludeSubgroups(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-border" />
                      {t('includeSubgroups')}
                    </label>
                    {/* A dynamic group has no membership to add to — the rule is
                        the membership. Offer the rule instead of a member picker. */}
                    {isDynamicGroup(selectedGroup) ? (
                      <button type="button" onClick={() => setRuleGroup(selectedGroup)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium hover:bg-muted transition-colors">
                        <Zap className="h-3.5 w-3.5" />{t('viewRule')}
                      </button>
                    ) : (
                      <button type="button" onClick={() => setAddMembersOpen(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium hover:bg-muted transition-colors">
                        <Plus className="h-3.5 w-3.5" />{t('addMembers')}
                      </button>
                    )}
                  </>
                )}
                {ungroupedSelected && (
                  <span className="ml-auto text-xs text-muted-foreground">{t('ungroupedHint')}</span>
                )}
              </div>
              <div className="px-4 py-2 border-b">
                <SearchInput
                  value={memberSearch}
                  onValueChange={setMemberSearch}
                  placeholder={t('searchMembers')}
                  className="h-8 text-sm"
                />
              </div>
              <div className="max-h-[28rem] overflow-y-auto">
                {contactsLoading && (
                  <div className="p-3 space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
                  </div>
                )}
                {!contactsLoading && members.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-10">{t('noMembers')}</p>
                )}
                {!contactsLoading && members.map((c) => {
                  const isDirect = !ungroupedSelected && contactMatchesGroup(c, selectedGroup!, filterCtx)
                  // Derived membership can't be removed by hand — you change the
                  // rule, not the person.
                  const removable = isDirect && !isDynamicGroup(selectedGroup)
                  return (
                    <div key={c.id} className="flex items-center gap-3 px-4 py-2 border-b last:border-0 hover:bg-muted/40 transition-colors group">
                      {/* A real href, not a router.push on a button (UX-98):
                          middle-click, open-in-new-tab and hover preview all
                          work, and reviewing a group is exactly when you want
                          to open a few records side by side. */}
                      <Link href={`/contacts/${c.id}` as Route}
                        className="flex-1 flex items-center gap-3 text-left min-w-0">
                        <span className="h-8 w-8 rounded-full shrink-0 flex items-center justify-center bg-muted text-muted-foreground text-xs font-semibold">
                          {personInitials(c)}
                        </span>
                        <span className="text-sm font-medium truncate">{c.firstname} {c.lastname}</span>
                        {!isDirect && !ungroupedSelected && (
                          <Badge variant="outline" className="text-[10px] shrink-0">{t('viaSubgroup')}</Badge>
                        )}
                      </Link>
                      {/* Quick-assign: file someone into another group without
                          leaving the one you're reviewing. Same picker as the
                          contact detail header. Always available — it's the only
                          action that makes sense on an ungrouped contact. */}
                      <GroupPickerPopover
                        contactId={c.id}
                        groupIds={c.group_ids ?? []}
                        onChanged={invalidateContacts}
                        align="end"
                        triggerTitle={t('assignToGroup')}
                        triggerClassName="p-1.5 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground transition-all data-[popup-open]:opacity-100"
                      >
                        <FolderPlus className="h-4 w-4" />
                      </GroupPickerPopover>
                      {removable && (
                        <Tip label={t('removeMember')}>
                          <button type="button" onClick={() => removeMember(c.id)}
                            className="p-1.5 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-all"
                            aria-label={t('removeMember')}>
                            <X className="h-4 w-4" />
                          </button>
                        </Tip>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Create / edit dialog */}
      <GroupFormDialog
        open={!!formMode}
        onOpenChange={(v) => { if (!v) setFormMode(null) }}
        title={formMode?.kind === 'edit'
          ? t('editGroupTitle')
          : formMode?.parent
            ? t('newSubgroupTitle', { name: formMode.parent.name })
            : t('newGroupTitle')}
        isCreate={formMode?.kind !== 'edit'}
        initialName={formMode?.kind === 'edit' ? formMode.group.name : ''}
        initialColor={formMode?.kind === 'edit' ? formMode.group.color ?? null : null}
        onSubmit={handleFormSubmit}
      />

      {/* Add members dialog — manual groups only; a dynamic group's membership
          is its rule, so there is nothing to add someone to. */}
      {selectedGroup && !isDynamicGroup(selectedGroup) && (
        <AddMembersDialog
          open={addMembersOpen}
          onOpenChange={setAddMembersOpen}
          group={selectedGroup}
          contacts={contacts}
          onAdded={invalidateContacts}
        />
      )}

      {/* Dynamic rule: read it, freeze it, or hand it back to the contacts page */}
      <GroupRuleDialog
        open={!!ruleGroup}
        onOpenChange={(v) => { if (!v) setRuleGroup(null) }}
        group={ruleGroup}
        contacts={contacts}
        filterContext={filterCtx}
        onConvertToManual={handleConvertToManual}
        onEditInContacts={() => {
          if (ruleGroup) stashRuleForContactsPage(ruleGroup)
          router.push('/contacts' as Route)
        }}
      />

      {/* Delete confirm */}
      <Dialog open={!!confirmDelete} onOpenChange={(v) => { if (!v) setConfirmDelete(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('deleteGroupTitle')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('deleteGroupDesc', { name: confirmDelete?.name ?? '' })}
          </p>
          <DialogFooter>
            <button onClick={() => setConfirmDelete(null)}
              className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors">
              {t('cancel')}
            </button>
            <button onClick={handleDelete}
              className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-colors">
              {t('deleteGroup')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

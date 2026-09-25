'use client'

// The group check-list popover. Extracted from ContactGroupsChips so the same
// control serves both places a contact's groups get changed: the contact detail
// header, and the groups page's member rows (quick-assign without leaving the
// group you're working in). One component means one behavior — toggling,
// nesting indentation, and the empty state can't drift apart.
//
// Caller supplies the trigger, since the two sites look nothing alike (a dashed
// "+" chip vs an icon button that appears on row hover).

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { doc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Check } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { CONTACTS_COLLECTION } from '@linyup/shared'
import { useContactGroups, flattenGroupTree, isDynamicGroup } from './hooks'

export function GroupPickerPopover({
  contactId,
  groupIds,
  onChanged,
  align = 'start',
  triggerClassName,
  triggerTitle,
  children,
}: {
  contactId: string
  /** The contact's current `group_ids`. */
  groupIds: string[]
  /** Called after a successful toggle so the caller can refetch. */
  onChanged: () => void
  align?: 'start' | 'end'
  triggerClassName?: string
  triggerTitle?: string
  children: React.ReactNode
}) {
  const t = useTranslations('ContactGroups')
  const { currentTeamId } = useAuth()
  const { data: groups = [] } = useContactGroups(currentTeamId)
  const [busy, setBusy] = useState(false)

  const memberIds = new Set(groupIds)
  // Manual groups only. A dynamic group's membership IS its rule — ticking a box
  // here would write a group_ids entry that nothing ever reads, so the contact
  // would appear unchanged and the click would look broken.
  const flat = flattenGroupTree(groups).filter(({ group }) => !isDynamicGroup(group))

  const toggle = async (groupId: string) => {
    if (busy) return
    setBusy(true)
    try {
      await updateDoc(doc(db, CONTACTS_COLLECTION, contactId), {
        group_ids: memberIds.has(groupId) ? arrayRemove(groupId) : arrayUnion(groupId),
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger className={triggerClassName} title={triggerTitle}>
        {children}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-56 p-1.5">
        {flat.map(({ group, depth }) => (
          <button
            key={group.id}
            type="button"
            onClick={() => toggle(group.id)}
            disabled={busy}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            className="flex items-center gap-2 w-full pr-2 py-1.5 text-sm rounded hover:bg-accent transition-colors text-left disabled:opacity-50"
          >
            <span
              className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                memberIds.has(group.id) ? 'bg-primary border-primary' : 'border-input'
              }`}
            >
              {memberIds.has(group.id) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
            </span>
            {group.color && (
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: group.color }} />
            )}
            <span className="truncate">{group.name}</span>
          </button>
        ))}
        {flat.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-3 px-2">
            {t('noGroupsYet')}{' '}
            <Link href={'/plugins/contact-groups' as Route} className="text-primary hover:underline">
              {t('manageGroups')}
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

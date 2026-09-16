'use client'

// Compact group chips for the contact detail header. Shows the groups a contact
// is in; the "+" opens the shared picker (GroupPickerPopover), which is the same
// control the groups page uses for quick-assign.

import { useTranslations } from 'next-intl'
import { useAuth } from '@/contexts/AuthContext'
import { FolderTree, Plus, Zap } from 'lucide-react'
import type { Contact } from '@linyup/shared'
import { useContactGroups, useContactFilterContext, groupsForContact, isDynamicGroup } from './hooks'
import { GroupPickerPopover } from './GroupPickerPopover'

export function ContactGroupsChips({ contact, onChanged }: { contact: Contact; onChanged: () => void }) {
  const t = useTranslations('ContactGroups')
  const { currentTeamId } = useAuth()
  const { data: groups = [] } = useContactGroups(currentTeamId)

  // The reverse lookup, asked the cheap way: instead of "who is in this group?"
  // (which would need the whole contact list), test THIS contact against each
  // group's rule. Dozens of groups, one contact — no list, no index, no
  // materialization. Dynamic memberships appear here exactly like manual ones.
  const filterCtx = useContactFilterContext(groups)
  const memberGroups = groupsForContact(contact, groups, filterCtx)

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      <FolderTree className="h-3 w-3 text-muted-foreground shrink-0" />
      {memberGroups.map((g) => (
        <span key={g.id}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground"
        >
          {g.color && <span className="h-2 w-2 rounded-full shrink-0" style={{ background: g.color }} />}
          {g.name}
          {/* Derived, not filed — so it can't be removed from here. */}
          {isDynamicGroup(g) && <Zap className="h-2.5 w-2.5 text-violet-500 shrink-0" />}
        </span>
      ))}
      <GroupPickerPopover
        contactId={contact.id}
        groupIds={contact.group_ids ?? []}
        onChanged={onChanged}
        align="start"
        triggerClassName="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-medium border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
      >
        <Plus className="h-3 w-3" />
        {memberGroups.length === 0 && t('addToGroup')}
      </GroupPickerPopover>
    </div>
  )
}

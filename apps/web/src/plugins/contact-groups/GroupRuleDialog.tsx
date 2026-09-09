'use client'

// A dynamic group's rule, in plain language — plus the one conversion that is
// always safe: freeze today's matches into a manual group.
//
// There is deliberately no rule EDITOR here. The rule is a contacts filter, and
// the contacts page already is the editor for that; duplicating it would be a
// second place where "what matches" is decided. "Edit in contacts" hands the
// rule back to that page instead.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Zap, Pencil, Snowflake } from 'lucide-react'
import { activeFilterKeys, membersOfGroup } from '@linyup/shared'
import type {
  ContactGroup, ContactFilter, ContactFilterContext, Contact,
} from '@linyup/shared'

/** Hand a rule to the contacts page, which is the real filter editor. */
export const GROUP_RULE_HANDOFF_KEY = 'linyup:contact-group-rule-handoff'

export function stashRuleForContactsPage(group: ContactGroup) {
  if (typeof window === 'undefined' || !group.rule) return
  window.sessionStorage.setItem(
    GROUP_RULE_HANDOFF_KEY,
    JSON.stringify({ groupId: group.id, name: group.name, filter: group.rule }),
  )
}

export function GroupRuleDialog({
  open, onOpenChange, group, contacts, filterContext, onConvertToManual, onEditInContacts,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  group: ContactGroup | null
  contacts: Contact[]
  filterContext: ContactFilterContext
  onConvertToManual: (memberIds: string[]) => Promise<void>
  onEditInContacts: () => void
}) {
  const t = useTranslations('ContactGroups')
  const tc = useTranslations('Contacts')
  const [busy, setBusy] = useState(false)

  const members = useMemo(
    () => (open && group ? membersOfGroup(contacts, group, filterContext) : []),
    [open, group, contacts, filterContext],
  )

  // Dimension → the same label the contacts filter bar uses, so the rule reads
  // in the vocabulary the user built it with.
  const DIMENSION_LABEL: Record<string, string> = {
    search: tc('filterSearchLabel'),
    stages: tc('filterStage'),
    sources: tc('filterSource'),
    statuses: tc('filterAffiliation'),
    subscriptions: tc('filterSubscription'),
    groups: tc('filterGroups'),
    engagement: tc('filterEngagement'),
    tags: tc('filterTags'),
    hasAlerts: tc('filterAlertsLabel'),
    hasNotes: tc('filterNotesLabel'),
    missingEmail: tc('filterMissingEmail'),
    needsAttention: tc('filterNeedsAttention'),
    consent: tc('filterConsent'),
    pendingSignup: tc('filterPendingSignup'),
    sessionsMin: tc('filterActivity'),
    inactivity: tc('filterActivity'),
    rankFilter: tc('filterRank'),
    age: tc('filterAge'),
    customFields: tc('filterCustomFields'),
  }

  const keys = group?.rule ? activeFilterKeys(group.rule as ContactFilter) : []

  async function convert() {
    if (busy) return
    setBusy(true)
    try {
      await onConvertToManual(members.map((c) => c.id))
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-violet-500" />
            {t('ruleTitle', { name: group?.name ?? '' })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('ruleExplainer')}</p>

          <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('ruleCriteria')}
            </p>
            {keys.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('ruleMatchesEveryone')}</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {[...new Set(keys.map((k) => DIMENSION_LABEL[k] ?? k))].map((label) => (
                  <Badge key={label} variant="secondary" className="text-xs">{label}</Badge>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground pt-0.5">
              {t('ruleMatchCount', { count: members.length })}
            </p>
          </div>

          <button type="button"
            onClick={convert}
            disabled={busy}
            className="flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors hover:bg-muted/40 disabled:opacity-50">
            <Snowflake className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t('convertToManual')}</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                {t('convertToManualBody', { count: members.length })}
              </span>
            </span>
          </button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button onClick={onEditInContacts} className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" />{t('editInContacts')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

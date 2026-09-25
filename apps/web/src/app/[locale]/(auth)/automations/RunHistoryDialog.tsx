'use client'

/**
 * "Did my rule fire, and what happened?" — the studio-facing read of
 * `teams/{teamId}/automation_logs`.
 *
 * That collection has been written by every trigger path since the port —
 * `runRule`'s event tier, `runScheduledRules`' daily sweep, the `Run now`
 * callable, and `executeDelayedRule` — and until this file it had no reader in
 * the app at all. It is NOT dead data: `executeDelayedRule` queries it by
 * `idempotency_key` as its dedup guard, so a delayed task that already ran is a
 * no-op precisely because a row is here. Deleting or trimming it would re-send
 * mail. The problem was never that it was written; it was that the only person
 * who could not see it was the studio whose rule it was (UX-48).
 *
 * WHY IT MATTERS MORE NOW: a delayed rule fires HOURS OR DAYS after the thing
 * that triggered it, from a Cloud Task nobody watches. The rule card's
 * `last_run_at` says only "something happened once"; this says which runs
 * happened, in which tier, and how many people each one reached.
 *
 * "TO WHOM" — answered as a SAMPLE, and labeled as one. `runRule` stores up to
 * `RECIPIENT_ID_CAP` (50) contact ids per run plus the exact `recipients_total`,
 * so a run that reached 400 people renders 50 names UNDER a line that says which
 * 400 it is showing 50 of. Never present the capped list as the whole set: the
 * studio's question is "did it reach the right people", and a silently truncated
 * roster answers it wrongly with more confidence than a count did.
 *
 * IDS, NOT NAMES, are what the log holds (a manager-readable log is the wrong
 * home for a frozen copy of contact data), so names are resolved HERE at read
 * time — from the shared active-contacts roster the app already caches, with a
 * per-row fetch for the few ids that roster does not cover (someone archived
 * since the run). A recipient deleted since the run resolves to nothing and is
 * counted as such rather than dropped.
 *
 * ROWS WRITTEN BEFORE THIS EXISTED carry no `recipient_ids` at all, which is why
 * the field's absence is distinguished from an empty array: "not recorded" and
 * "reached nobody" are different sentences and the row says whichever is true.
 */

import { useTranslations, useMessages } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import type { Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useActiveContacts } from '@/hooks/useActiveContacts'
import { TEAMS_COLLECTION, AUTOMATION_LOGS_SUBCOLLECTION, CONTACTS_COLLECTION } from '@linyup/shared'
import type { Contact } from '@linyup/shared'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryErrorState } from '@/components/ui/query-error'
import { AlertTriangle, ChevronDown, ChevronRight, History } from 'lucide-react'

/** How many runs are fetched. A busy team fires several a day; a few weeks of
 *  history is what makes "did last Tuesday's reminder go out?" answerable, and
 *  more than that belongs in an export nobody has asked for yet. */
const HISTORY_LIMIT = 100

interface AutomationLogRow {
  id: string
  rule_id: string
  rule_name: string
  trigger_type: string
  trigger_tier: string
  contacts_matched: number
  actions_executed: number
  actions_failed: number
  /** UNDEFINED means the run predates recipient recording — not "reached nobody". */
  recipient_ids?: string[]
  recipients_total: number
  /** `RuleStats.whatsapp` — present only when the rule has a `send_whatsapp`
   *  action. Keys are outcomes ('sent', 'held', 'no_phone', 'no_consent', …);
   *  absent means the rule sends no WhatsApp at all, which reads differently
   *  from every key being zero. */
  whatsapp_outcomes?: Record<string, number>
  error?: string
  triggered_at?: Timestamp | null
  session_id?: string
}

function toRow(id: string, data: Record<string, unknown>): AutomationLogRow {
  return {
    id,
    rule_id: (data.rule_id as string) ?? '',
    rule_name: (data.rule_name as string) ?? '',
    trigger_type: (data.trigger_type as string) ?? '',
    trigger_tier: (data.trigger_tier as string) ?? '',
    contacts_matched: (data.contacts_matched as number) ?? 0,
    actions_executed: (data.actions_executed as number) ?? 0,
    actions_failed: (data.actions_failed as number) ?? 0,
    // No `?? []` here: the fallback would turn every pre-recording row into an
    // empty roster, i.e. claim the run reached nobody.
    recipient_ids: Array.isArray(data.recipient_ids)
      ? (data.recipient_ids as string[])
      : undefined,
    recipients_total: (data.recipients_total as number) ?? 0,
    whatsapp_outcomes:
      data.whatsapp_outcomes && typeof data.whatsapp_outcomes === 'object'
        ? (data.whatsapp_outcomes as Record<string, number>)
        : undefined,
    error: (data.error as string) || undefined,
    triggered_at: (data.triggered_at as Timestamp | undefined) ?? null,
    session_id: (data.session_id as string) || undefined,
  }
}

/**
 * Reads the log rows. Scoped to ONE rule when `ruleId` is given — the rule menu's
 * entry — and otherwise the whole team's recent runs. The scoped shape needs the
 * (rule_id, triggered_at desc) composite index in `firestore.index.json`;
 * filtering the unscoped page in memory instead would silently lose a quiet
 * rule's runs behind a noisy one's.
 */
function useAutomationLogs(teamId: string | null, ruleId: string | null) {
  return useQuery<AutomationLogRow[]>({
    queryKey: ['automation_logs', teamId, ruleId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const col = collection(db, TEAMS_COLLECTION, teamId, AUTOMATION_LOGS_SUBCOLLECTION)
      const q = ruleId
        ? query(
            col,
            where('rule_id', '==', ruleId),
            orderBy('triggered_at', 'desc'),
            limit(HISTORY_LIMIT)
          )
        : query(col, orderBy('triggered_at', 'desc'), limit(HISTORY_LIMIT))
      const snap = await getDocs(q)
      return snap.docs.map((d) => toRow(d.id, d.data()))
    },
  })
}

/** How a recipient is named. Email is the fallback for a contact saved without a
 *  name, not a second identifier offered alongside one. */
function contactLabel(c: Partial<Contact>): string {
  const name = [c.firstname, c.lastname].filter(Boolean).join(' ').trim()
  return name || c.email || ''
}

/**
 * Names for the ids the shared roster does not cover — a recipient ARCHIVED
 * since the run, which is a normal thing for a month-old log to contain.
 *
 * Fetched only for the row the studio expanded, so the lookup is bounded by the
 * cap (≤ 50 ids) and the claim "these ones are gone" is only ever made about ids
 * that were actually looked for. Each id is read on its own and swallows its own
 * failure: a single deleted or unreadable contact must not blank the other 49.
 */
function useMissingRecipientNames(rowId: string, ids: string[], enabled: boolean) {
  const key = ids.join(',')
  return useQuery<Record<string, string>>({
    queryKey: ['automation_logs', 'recipients', rowId, key],
    enabled: enabled && ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const found: Record<string, string> = {}
      await Promise.all(
        ids.map(async (id) => {
          try {
            const snap = await getDoc(doc(db, CONTACTS_COLLECTION, id))
            if (snap.exists()) found[id] = contactLabel(snap.data() as Partial<Contact>)
          } catch {
            // Deleted, or outside this manager's scope — left unresolved and
            // counted as such below.
          }
        })
      )
      return found
    },
  })
}

function formatWhen(ts: Timestamp | null | undefined, locale: string): string {
  if (!ts) return ''
  return ts.toDate().toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function RunHistoryDialog({
  open,
  onOpenChange,
  teamId,
  ruleId = null,
  ruleName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string
  /** null → every rule's runs. */
  ruleId?: string | null
  ruleName?: string
}) {
  const t = useTranslations('Automations')
  // Trigger labels live under `Automations.triggers.*`, but a PLUGIN trigger id
  // (`plugin:referrals:referral_created`) has no key there — and a missing key
  // renders the raw id to the user. Reading the message tree lets an unknown id
  // fall back to the stored string instead.
  const messages = useMessages() as unknown as {
    Automations?: { triggers?: Record<string, string> }
  }
  const triggerLabel = (type: string) => messages.Automations?.triggers?.[type] ?? type

  const { data: rows = [], isLoading, error, refetch } = useAutomationLogs(
    open ? teamId : null,
    ruleId
  )

  // ONE query for every name in the dialog — the same active-contacts roster the
  // contacts page and the sidebar search read, so on a warm cache this costs
  // nothing and never scales with the number of runs on screen. Ids it does not
  // cover are chased per row (see useMissingRecipientNames).
  const { data: roster = [] } = useActiveContacts(open ? teamId : null)
  const rosterNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of roster) if (c.id) map.set(c.id, contactLabel(c))
    return map
  }, [roster])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            {t('history.title')}
          </DialogTitle>
          <DialogDescription>
            {ruleName ? t('history.subtitleForRule', { name: ruleName }) : t('history.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 rounded-lg" />
              <Skeleton className="h-14 rounded-lg" />
              <Skeleton className="h-14 rounded-lg" />
            </div>
          ) : error ? (
            <QueryErrorState
              onRetry={() => void refetch()}
              detail={error instanceof Error ? error.message : null}
            />
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('history.empty')}</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {rows.map((row) => (
                <RunRow
                  key={row.id}
                  row={row}
                  showRuleName={!ruleId}
                  triggerLabel={triggerLabel}
                  rosterNames={rosterNames}
                />
              ))}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function RunRow({
  row,
  showRuleName,
  triggerLabel,
  rosterNames,
}: {
  row: AutomationLogRow
  showRuleName: boolean
  triggerLabel: (type: string) => string
  rosterNames: Map<string, string>
}) {
  const t = useTranslations('Automations')
  // Dates follow the BROWSER locale — the repo's convention for date formatting
  // (CLAUDE.md), not the message locale.
  const when = formatWhen(
    row.triggered_at,
    typeof navigator !== 'undefined' ? navigator.language : 'en'
  )

  const tierKey = ['event', 'delayed', 'scheduled', 'manual'].includes(row.trigger_tier)
    ? (`history.tier_${row.trigger_tier}` as Parameters<typeof t>[0])
    : null

  return (
    <div className="space-y-1 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {showRuleName ? row.rule_name || t('ruleCard.unnamed') : triggerLabel(row.trigger_type)}
        </p>
        <span className="shrink-0 text-xs text-muted-foreground">{when}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {tierKey && (
          <Badge variant="secondary" className="text-xs">
            {t(tierKey)}
          </Badge>
        )}
        {showRuleName && (
          <span className="text-xs text-muted-foreground">{triggerLabel(row.trigger_type)}</span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {t('history.counts', {
          matched: row.contacts_matched,
          executed: row.actions_executed,
        })}
        {row.actions_failed > 0 && (
          <span className="ml-1 font-medium text-destructive">
            {t('history.failedCount', { count: row.actions_failed })}
          </span>
        )}
      </p>

      <Recipients row={row} rosterNames={rosterNames} />

      <WhatsAppOutcomesLine outcomes={row.whatsapp_outcomes} />

      {row.error && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">{row.error}</span>
        </p>
      )}
    </div>
  )
}

/**
 * The WhatsApp half of a run, in the owner's own words — e.g. "WhatsApp: 12
 * sent, 3 waiting for 8:00, 5 not opted in". `RuleStats.whatsapp` (written only
 * by a rule carrying a `send_whatsapp` action) has one key per raw engine
 * outcome; several of those are the SAME sentence to an owner ("no consent"
 * and "no marketing consent" are both "not opted in"), so outcomes are grouped
 * here rather than listed one key at a time. Absent entirely on a rule with no
 * WhatsApp action — nothing renders, not a "0 sent" line nobody asked for.
 */
const WHATSAPP_OUTCOME_GROUPS: { labelKey: Parameters<ReturnType<typeof useTranslations>>[0]; sources: string[] }[] = [
  { labelKey: 'history.whatsappOutcome_sent', sources: ['sent'] },
  { labelKey: 'history.whatsappOutcome_held', sources: ['held'] },
  { labelKey: 'history.whatsappOutcome_noConsent', sources: ['no_consent', 'no_marketing_consent'] },
  { labelKey: 'history.whatsappOutcome_noPhone', sources: ['no_phone'] },
  {
    labelKey: 'history.whatsappOutcome_notReady',
    sources: ['template_not_approved', 'not_connected', 'disabled'],
  },
  { labelKey: 'history.whatsappOutcome_blocked', sources: ['suppressed', 'bad_number'] },
  {
    labelKey: 'history.whatsappOutcome_testSettings',
    sources: ['policy_silent', 'policy_allowlist', 'test_mode_no_recipient'],
  },
  { labelKey: 'history.whatsappOutcome_duplicate', sources: ['duplicate'] },
]

function WhatsAppOutcomesLine({ outcomes }: { outcomes?: Record<string, number> }) {
  const t = useTranslations('Automations')
  if (!outcomes) return null

  const parts = WHATSAPP_OUTCOME_GROUPS.map((g) => {
    const count = g.sources.reduce((sum, key) => sum + (outcomes[key] ?? 0), 0)
    return count > 0 ? t(g.labelKey, { count }) : null
  }).filter((p): p is string => p !== null)

  if (parts.length === 0) return null

  return (
    <p className="text-xs text-muted-foreground">
      {t('history.whatsappLine', { summary: parts.join(', ') })}
    </p>
  )
}

/**
 * "Who got it" for ONE run.
 *
 * Three states, and each says something different on purpose:
 *  · no `recipient_ids` field  → the run predates recording. Says exactly that,
 *    rather than showing an empty list that would read as "reached nobody".
 *  · `recipients_total === 0`  → nothing rendered; the counts line above already
 *    says no action ran.
 *  · otherwise                 → the total, collapsed, expandable into the names.
 *    When the stored sample is shorter than the total, the expanded panel LEADS
 *    with "showing the first 50 of 400" — a truncated list that does not say so
 *    is worse than the count it replaced.
 */
function Recipients({
  row,
  rosterNames,
}: {
  row: AutomationLogRow
  rosterNames: Map<string, string>
}) {
  const t = useTranslations('Automations')
  const [expanded, setExpanded] = useState(false)

  const ids = row.recipient_ids
  const missingIds = useMemo(
    () => (ids ?? []).filter((id) => !rosterNames.has(id)),
    [ids, rosterNames]
  )
  const { data: extraNames, isLoading: loadingExtra } = useMissingRecipientNames(
    row.id,
    missingIds,
    expanded
  )

  if (!ids) {
    return <p className="text-xs text-muted-foreground">{t('history.recipientsNotRecorded')}</p>
  }
  if (row.recipients_total === 0) return null

  const names: string[] = []
  let unresolved = 0
  for (const id of ids) {
    const name = rosterNames.get(id) ?? extraNames?.[id]
    if (name) names.push(name)
    else unresolved++
  }
  names.sort((a, b) => a.localeCompare(b))

  const shown = ids.length
  const truncated = row.recipients_total > shown

  return (
    <div className="space-y-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {t('history.recipientsCount', { count: row.recipients_total })}
      </button>

      {expanded && (
        <div className="space-y-1 rounded-md bg-muted/50 px-2 py-1.5">
          {truncated && (
            <p className="text-xs font-medium">
              {t('history.recipientsTruncated', { shown, total: row.recipients_total })}
            </p>
          )}
          {loadingExtra ? (
            <Skeleton className="h-4 w-full" />
          ) : (
            <>
              {names.length > 0 && (
                <p className="break-words text-xs text-muted-foreground">{names.join(', ')}</p>
              )}
              {unresolved > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('history.recipientsGone', { count: unresolved })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

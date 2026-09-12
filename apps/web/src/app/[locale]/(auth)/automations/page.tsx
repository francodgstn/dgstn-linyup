'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useInvalidateSetupChecklist } from '@/hooks/useSetupChecklist'
import { useTranslations } from 'next-intl'
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useRankingSystems } from '@/hooks/useRankingSystems'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { FloatingSlot } from '@/components/layout/FloatingDock'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePlan } from '@/hooks/usePlan'
import { usePlanName } from '@/hooks/usePlanName'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useSubscriptionTypes } from '@/hooks/useSubscriptionTypes'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import {
  Workflow,
  Plus,
  Pencil,
  Play,
  Trash2,
  MoreVertical,
  CirclePause,
  CirclePlay,
  Clock,
  UserPlus,
  TrendingUp,
  CheckCircle,
  XCircle,
  CalendarCheck,
  ShieldCheck,
  CreditCard,
  Mail,
  Bell,
  FileText,
  Settings2,
  Zap,
  Sparkles,
  BookOpen,
  Tag,
  Users,
  Webhook,
  History,
  Copy,
  Banknote,
  Undo2,
  ShieldAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import {  TEAMS_COLLECTION, ALERT_PRESETS_SUBCOLLECTION, SUBSCRIPTION_ROLLUP_STATUSES, CONTACT_SOURCES, AUTOMATION_RULES_SUBCOLLECTION, OUTREACH_TEMPLATES_SUBCOLLECTION, WEBHOOK_ENDPOINTS_SUBCOLLECTION, orderedLevels, rankLevelKey } from '@linyup/shared'
import type { SubscriptionType, CustomFieldDefinition, RankingSystem, MemberPayment } from '@linyup/shared'
import { Link, useRouter } from '@/i18n/navigation'
import { useSearchParams } from 'next/navigation'
import type { Route } from 'next'
import { LibraryDialog, installStarterBundle } from './LibraryDialog'
import { starterBundleItemsForPlan } from './automationLibrary'
import { WebhookEndpointsDialog, type WebhookEndpoint } from './WebhookEndpointsDialog'
import { PreviewRunDialog } from './PreviewRunDialog'
import { RunHistoryDialog } from './RunHistoryDialog'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useContactGroups, flattenGroupTree, isDynamicGroup } from '@/plugins/contact-groups/hooks'
import type { ContactGroup } from '@linyup/shared'
import { useConfirm } from '@/components/ui/confirm-dialog'

// ─── types ────────────────────────────────────────────────────────────────────

interface AutomationTrigger {
  type: string
  delayMinutes?: number
  webhook_endpoint_id?: string // inbound_webhook only
  subscriptionTypeId?: string // subscription_added/removed: scope to a specific type ('' = any)
  affiliationTypeKey?: string // affiliation_added/removed: scope to a specific type key ('' = any)
  paymentKind?: string // payment_*: scope to one MemberPayment.kind ('' = any)
}

interface AutomationCondition {
  type: string
  value?: string
  field?: string // field_equals condition
  group_id?: string // in_group condition
  delay_days?: number
}

interface AutomationAction {
  type: string
  templateId?: string
  presetId?: string
  field?: string
  value?: unknown
  subject?: string
  body?: string
  message?: string
  note?: string // add_note
  tag?: string // assign_tag / remove_tag
  url?: string // webhook
}

interface AutomationRule {
  id: string
  name: string
  active: boolean
  trigger: AutomationTrigger
  conditions: AutomationCondition[]
  actions: AutomationAction[]
  last_run_at?: { toDate(): Date } | null
  last_run_sent?: number
  system_key?: string // present on starter-kit rules — used to prevent duplicate seeding
  // legacy fields — normalised on read
  template_id?: string
  alert_preset_id?: string
}

interface OutreachTemplate {
  id: string
  name: string
  subject: string
  body: string
  language: string
  active: boolean
  system_key?: string // present on starter-kit templates — used to prevent duplicate seeding
}

/** teams/{teamId}/alert_presets — the reusable alert bodies a studio writes in
 *  Settings → Team. `create_alert` mints a contact alert FROM one of these, so
 *  the picker below is what makes the action selectable rather than decorative. */
interface AlertPreset {
  id: string
  name: string
  message: string
  show_in_app?: boolean
}

// Form shapes
interface FormCondition {
  type: string
  value: string
  condField?: string // field_equals — the field name
}
interface FormAction {
  type: string
  templateId: string // send_email
  presetId?: string // create_alert — which alert preset the alert is minted from
  field?: string // update_field — which contact field
  fieldValue?: string // update_field — the new value
  subject?: string // notify_team — email subject
  body?: string // notify_team — email body (markdown)
  message?: string // log_activity — log message
  note?: string // add_note — note content (markdown / placeholders)
  tag?: string // assign_tag / remove_tag
  url?: string // webhook
  group_id?: string // add_to_group / remove_from_group
}

// ─── constants ────────────────────────────────────────────────────────────────

// `group` drives the sectioned dropdown (SelectGroup + divider) — machine keys,
// translated for display via Automations.groups.* (see renderGroupedOptions).
const TRIGGER_GROUP_ORDER = ['contact', 'booking', 'attendance', 'subscription', 'payment', 'affiliation', 'general', 'plugins']
const CONDITION_GROUP_ORDER = ['acquisition', 'subscription', 'affiliation', 'attendance', 'other']

// supportsDelay says the DELAY IS HONOURED, not merely stored — which is what
// it did not say until UX-85. A trigger marked true is deferred for real:
// `session_ended` through onSessionWrite, every other event trigger through
// fireEventRules -> executeDelayedRule. Do not flip one to true without a
// matching arm in resolveEventDelayMinutes; automation/delayedRules.test.ts
// reads BOTH files and fails the build on a disagreement.
//
// Marked false, and why — each is a decision, not an omission:
//   schedule_daily, manual — not event triggers; there is nothing to defer from.
//   inbound_webhook — a delayed run persists its payload in the Cloud Tasks
//     queue, and that payload is the caller's raw POST body. The engine refuses
//     a delay for ANY trigger carrying a payload (resolveEventDelayMinutes), so
//     this must stay false or the field would lie again.
//
// The delay is capped at MAX_DELAY_MINUTES: Cloud Tasks will not schedule a task
// more than 30 days out. Beyond that the engine clamps and logs.
const MAX_DELAY_MINUTES = 30 * 24 * 60

// The triggers that read a member_payments row, and so the ones the paymentKind scope
// applies to. Typed against AutomationRule.trigger.type on the engine side by the
// delayedRules parity test, which reads this file.
const PAYMENT_TRIGGERS: string[] = ['payment_received', 'payment_refunded', 'payment_disputed']

// The triggers that carry a subscription_type_id in their delta, and so the ones the
// subscription-type scope applies to. Must agree with the matching branch in
// fireEventRules — a select the engine ignores is worse than no select at all, and
// that is exactly how subscription_cancel_requested shipped.
const SUBSCRIPTION_SCOPED_TRIGGERS: string[] = [
  'subscription_added',
  'subscription_removed',
  'subscription_cancel_requested',
]

// What a payment can have bought, in the order the select offers it.
//
// Written as a Record over the shared MemberPayment union, not as a free-hand array,
// so that adding a kind in @linyup/shared and forgetting this select FAILS THE BUILD.
// An array would have accepted the omission silently, and the symptom — a scope the
// studio cannot express — is invisible until somebody goes looking for it.
const PAYMENT_KIND_ORDER: Record<NonNullable<MemberPayment['kind']>, true> = {
  membership: true,
  course: true,
  product: true,
  drop_in: true,
  appointment: true,
  gift_card: true,
  policy_fee: true,
}
const PAYMENT_KINDS = Object.keys(PAYMENT_KIND_ORDER) as NonNullable<MemberPayment['kind']>[]

const TRIGGER_OPTIONS = [
  { value: 'schedule_daily', icon: Clock, supportsDelay: false, group: 'general' },
  { value: 'contact_created', icon: UserPlus, supportsDelay: true, group: 'contact' },
  // Fires on a FORWARD move only (onContactWrite ranks the stage and ignores a
  // backward correction), which is what makes "when someone joins" expressible:
  // pair it with an `acquisition_stage = joined` condition. `contact_created`
  // cannot answer that question — it fired when the lead booked a trial and
  // never re-evaluates.
  //
  // supportsDelay flipped to TRUE (2026-08-18, UX-85): `fireEventRules` now
  // defers any event rule carrying trigger.delayMinutes to the same Cloud Tasks
  // handler `session_ended` uses. "Welcome them three days after they join" is
  // the natural shape for this trigger and is what the delay was withheld from.
  { value: 'acquisition_stage_changed', icon: TrendingUp, supportsDelay: true, group: 'contact' },
  { value: 'booking_confirmed', icon: CheckCircle, supportsDelay: true, group: 'booking' },
  { value: 'booking_no_show', icon: XCircle, supportsDelay: true, group: 'booking' },
  { value: 'booking_cancelled', icon: XCircle, supportsDelay: true, group: 'booking' },
  { value: 'subscription_added', icon: CreditCard, supportsDelay: true, group: 'subscription' },
  { value: 'subscription_removed', icon: CreditCard, supportsDelay: true, group: 'subscription' },
  { value: 'subscription_changed', icon: CreditCard, supportsDelay: true, group: 'subscription' },
  // The two BILLING events (2026-08-23). Both carry a delay because the useful
  // rules are delayed ones: a win-back a few days after somebody cancels beats
  // one that arrives while they are still in the billing portal, and a card
  // reminder is kinder a day after the failure than a minute after it.
  {
    value: 'subscription_cancel_requested',
    icon: CreditCard,
    supportsDelay: true,
    group: 'subscription',
  },
  {
    value: 'subscription_payment_failed',
    icon: CreditCard,
    supportsDelay: true,
    group: 'subscription',
  },
  // Money events read off the payment ROW, as opposed to the two above, which are read
  // off the contact. Offered to every studio, including one with no Stripe account
  // connected: a trigger that never fires is inert, whereas a hidden one is a support
  // question from a studio halfway through onboarding.
  { value: 'payment_received', icon: Banknote, supportsDelay: true, group: 'payment' },
  { value: 'payment_refunded', icon: Undo2, supportsDelay: true, group: 'payment' },
  { value: 'payment_disputed', icon: ShieldAlert, supportsDelay: true, group: 'payment' },
  { value: 'affiliation_added', icon: ShieldCheck, supportsDelay: true, group: 'affiliation' },
  { value: 'affiliation_removed', icon: ShieldCheck, supportsDelay: true, group: 'affiliation' },
  { value: 'affiliation_changed', icon: ShieldCheck, supportsDelay: true, group: 'affiliation' },
  { value: 'session_ended', icon: CalendarCheck, supportsDelay: true, group: 'attendance' },
  { value: 'inbound_webhook', icon: Webhook, supportsDelay: false, group: 'general' },
  { value: 'manual', icon: Play, supportsDelay: false, group: 'general' },
]

const CONDITION_TYPE_OPTIONS = [
  { value: 'acquisition_stage', input: 'acquisition_stage_select', group: 'acquisition' },
  { value: 'days_since_created', input: 'number', group: 'acquisition' },
  { value: 'subscription', input: 'subscription_select', group: 'subscription' },
  { value: 'subscription_status', input: 'subscription_status_select', group: 'subscription' },
  { value: 'subscription_expires_in', input: 'number', group: 'subscription' },
  // `subscription_expires_in` IS offered again. Both reasons it was withheld are
  // gone: the engine now tests `subscription_expires_at`, which a one-time price
  // carrying `included_months` writes ("CHF 100, 2 months included"), and the
  // condition takes `value` like every other number condition, so this editor's
  // one number mapping builds it correctly.
  //
  // It is the win-back lever for a grant that ends by COMPARISON rather than by
  // an event — nothing fires when the date passes, so without a condition that
  // asks on a scan there would be no way to reach the member at all.
  { value: 'has_affiliation', input: 'none', group: 'affiliation' },
  { value: 'affiliation_type', input: 'affiliation_type_select', group: 'affiliation' },
  { value: 'sessions_attended_min', input: 'number', group: 'attendance' },
  { value: 'sessions_attended_max', input: 'number', group: 'attendance' },
  { value: 'sessions_attended_exactly', input: 'number', group: 'attendance' },
  { value: 'inactivity_days', input: 'number', group: 'attendance' },
  { value: 'inactivity_days_max', input: 'number', group: 'attendance' },
  { value: 'bio_link_booking_no_show', input: 'no_show_days', group: 'attendance' },
  { value: 'tag', input: 'text', group: 'other' },
  { value: 'field_equals', input: 'field_equals', group: 'other' },
  { value: 'birthday_today', input: 'none', group: 'other' },
  // Contact Groups plugin — filtered out below when it isn't installed.
  { value: 'in_group', input: 'group_select', group: 'other' },
]

// Render a flat option list as grouped <SelectGroup> sections with dividers, in the
// given group order (unknown groups — e.g. plugin-contributed — fall to the end).
type GroupableOption = { value: string; label: string; group?: string }
function renderGroupedOptions(
  options: ReadonlyArray<GroupableOption>,
  order: string[],
  groupLabel: (g: string) => string = (g) => g
) {
  const byGroup = new Map<string, GroupableOption[]>()
  for (const o of options) {
    const g = o.group ?? 'plugins'
    const arr = byGroup.get(g) ?? []
    arr.push(o)
    byGroup.set(g, arr)
  }
  const groups = [
    ...order.filter((g) => byGroup.has(g)),
    ...[...byGroup.keys()].filter((g) => !order.includes(g)),
  ]
  return groups.map((g, gi) => (
    <React.Fragment key={g}>
      {gi > 0 && <SelectSeparator />}
      <SelectGroup>
        <SelectLabel>{groupLabel(g)}</SelectLabel>
        {byGroup.get(g)!.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectGroup>
    </React.Fragment>
  ))
}

const ACQUISITION_STAGE_VALUES = ['trial_booked', 'trial_attended', 'joined'] as const

const ACTION_TYPE_VALUES = [
  'send_email',
  'add_note',
  'update_field',
  'archive_contact',
  'assign_tag',
  'remove_tag',
  'notify_team',
  'log_activity',
  'webhook',
  'add_to_group',
  'remove_from_group',
  'create_alert',
] as const

/** `actions.types.create_alert` still carries the pre-UX-51 "(coming soon)"
 *  suffix in the shipped locale files; the action is real now, so the label is
 *  read from its own key instead. (The old key is orphaned — delete it in a
 *  copy pass, not from a parallel lane.) */
function actionTypeLabelKey(v: string): string {
  return v === 'create_alert' ? 'actions.createAlertLabel' : `actions.types.${v}`
}

function defaultActionTypeLabels(t: ReturnType<typeof useTranslations>): Record<string, string> {
  return Object.fromEntries(
    ACTION_TYPE_VALUES.map((v) => [v, t(actionTypeLabelKey(v) as Parameters<typeof t>[0])])
  )
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function triggerTypeLabel(t: ReturnType<typeof useTranslations>, type: string): string {
  return TRIGGER_OPTIONS.some((o) => o.value === type)
    ? t(`triggers.${type}` as Parameters<typeof t>[0])
    : type
}

function conditionTypeLabel(t: ReturnType<typeof useTranslations>, type: string): string {
  return CONDITION_TYPE_OPTIONS.some((o) => o.value === type)
    ? t(`conditions.types.${type}` as Parameters<typeof t>[0])
    : type
}

function subscriptionStatusLabel(t: ReturnType<typeof useTranslations>, status: string): string {
  return t(`subscriptionStatus.${status}` as Parameters<typeof t>[0])
}

function acquisitionStageLabel(t: ReturnType<typeof useTranslations>, stage: string): string {
  return t(`acquisitionStage.${stage}` as Parameters<typeof t>[0])
}

const UPDATE_FIELD_LABEL_KEYS: Record<string, string> = {
  acquisition_stage: 'actions.updateField.acquisitionStage',
  source: 'actions.updateField.source',
  source_detail: 'actions.updateField.sourceDetail',
  notes: 'actions.updateField.notes',
  lead_acknowledged: 'actions.updateField.leadAcknowledged',
}

function updateFieldLabel(
  t: ReturnType<typeof useTranslations>,
  field: string,
  customLabel?: string
): string {
  if (customLabel) return customLabel
  const key = UPDATE_FIELD_LABEL_KEYS[field]
  if (key) return t(key as Parameters<typeof t>[0])
  // Custom fields are stored as dotted paths — show the definition id as fallback.
  return field.startsWith('custom_fields.') ? field.slice('custom_fields.'.length) : field
}

function conditionSummary(
  t: ReturnType<typeof useTranslations>,
  c: AutomationCondition,
  subName?: (id: string) => string
): string {
  const opt = CONDITION_TYPE_OPTIONS.find((o) => o.value === c.type)
  if (!opt) return c.type
  const label = conditionTypeLabel(t, c.type)
  if (c.type === 'bio_link_booking_no_show')
    return t('conditions.summaryNoShowDays', { days: c.delay_days ?? 1 })
  if (opt.input === 'none') return label
  if (opt.input === 'number') return t('conditions.summaryNumber', { label, value: c.value ?? '' })
  if (c.type === 'field_equals')
    return t('conditions.summaryFieldEquals', { field: c.field ?? '?', value: c.value ?? '' })
  if (c.type === 'subscription' && c.value && c.value !== 'any' && c.value !== 'none') {
    return t('conditions.summarySubscription', { name: subName?.(c.value) ?? c.value })
  }
  return t('conditions.summaryWithValue', { label, value: c.value ?? '' })
}

function actionSummary(
  t: ReturnType<typeof useTranslations>,
  a: AutomationAction,
  templates: OutreachTemplate[],
  pluginActionLabels?: Record<string, string>,
  alertPresets?: AlertPreset[]
): string {
  if (a.type === 'send_email') {
    const tmpl = templates.find((tm) => tm.id === (a.templateId ?? ''))
    return t('actions.summarySendEmail', { name: tmpl?.name ?? a.templateId ?? '—' })
  }
  if (a.type === 'create_alert') {
    const preset = alertPresets?.find((p) => p.id === (a.presetId ?? ''))
    return t('actions.summaryCreateAlertNamed', { name: preset?.name ?? a.presetId ?? '—' })
  }
  if (a.type === 'update_field')
    return t('actions.summaryUpdateField', {
      field: updateFieldLabel(t, a.field ?? '—'),
      value: String(a.value ?? '—'),
    })
  if (a.type === 'archive_contact') return t('actions.summaryArchiveContact')
  if (a.type === 'add_note') return t('actions.summaryAddNote', { note: a.note ?? '' })
  if (a.type === 'notify_team') return t('actions.summaryNotifyTeam', { subject: a.subject ?? '' })
  if (a.type === 'log_activity') return t('actions.summaryLogActivity', { message: a.message ?? '' })
  if (a.type === 'assign_tag') return t('actions.summaryAssignTag', { tag: a.tag ?? '—' })
  if (a.type === 'remove_tag') return t('actions.summaryRemoveTag', { tag: a.tag ?? '—' })
  if (a.type === 'webhook') return t('actions.summaryWebhook', { url: a.url ?? '—' })
  // Plugin-contributed actions — use the label from the manifest if available
  if (a.type.startsWith('plugin:')) {
    return pluginActionLabels?.[a.type] ?? a.type
  }
  return a.type
}

function timeAgo(t: ReturnType<typeof useTranslations>, ts: { toDate(): Date } | null | undefined): string {
  if (!ts) return ''
  const ms = Date.now() - ts.toDate().getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return t('timeAgo.minutes', { mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t('timeAgo.hours', { hrs })
  return t('timeAgo.days', { days: Math.floor(hrs / 24) })
}

/** Normalise legacy rule docs (template_id / alert_preset_id → actions) */
function normaliseRule(data: Record<string, unknown>, id: string): AutomationRule {
  const actions: AutomationAction[] = []
  if (Array.isArray(data.actions) && (data.actions as unknown[]).length > 0) {
    actions.push(...(data.actions as AutomationAction[]))
  } else {
    if (data.template_id)
      actions.push({ type: 'send_email', templateId: data.template_id as string })
    if (data.alert_preset_id)
      actions.push({ type: 'create_alert', presetId: data.alert_preset_id as string })
  }
  const trigger =
    data.trigger && typeof data.trigger === 'object'
      ? (data.trigger as AutomationTrigger)
      : { type: 'schedule_daily' }
  return {
    id,
    name: (data.name as string) || '',
    active: Boolean(data.active),
    trigger,
    conditions: (Array.isArray(data.conditions) ? data.conditions : []) as AutomationCondition[],
    actions,
    last_run_at: data.last_run_at as AutomationRule['last_run_at'],
    last_run_sent: data.last_run_sent as number | undefined,
    system_key: data.system_key as string | undefined,
    template_id: data.template_id as string | undefined,
  }
}

// ─── data hooks ───────────────────────────────────────────────────────────────

function useRules(teamId: string | null) {
  return useQuery<AutomationRule[]>({
    queryKey: ['automation_rules', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        query(collection(db, TEAMS_COLLECTION, teamId, AUTOMATION_RULES_SUBCOLLECTION), orderBy('name', 'asc'))
      )
      return snap.docs.map((d) => normaliseRule(d.data() as Record<string, unknown>, d.id))
    },
  })
}

function useTemplates(teamId: string | null) {
  return useQuery<OutreachTemplate[]>({
    queryKey: ['outreach_templates', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId, OUTREACH_TEMPLATES_SUBCOLLECTION),
          where('active', '==', true),
          orderBy('name', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as OutreachTemplate)
    },
  })
}

function useAlertPresets(teamId: string | null) {
  return useQuery<AlertPreset[]>({
    queryKey: ['alert_presets', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, teamId, ALERT_PRESETS_SUBCOLLECTION)
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as AlertPreset)
    },
  })
}

// ─── RuleCard ─────────────────────────────────────────────────────────────────

function TriggerIcon({ type, className }: { type: string; className?: string }) {
  const opt = TRIGGER_OPTIONS.find((o) => o.value === type)
  const Icon = opt?.icon ?? Zap
  return <Icon className={className ?? 'h-4 w-4'} />
}

function RuleCard({
  rule,
  teamId,
  templates,
  alertPresets,
  subscriptionTypes,
  onEdit,
  onDuplicate,
  onToggle,
  onRunNow,
  onDelete,
  autoRun,
}: {
  rule: AutomationRule
  teamId: string
  /**
   * Open this card's RUN confirmation on mount — the dashboard's quick action
   * arrives as `/automations?run={ruleId}`. It opens the SAME dialog the "Run
   * now" button opens, never the callable: a quick action must not be able to
   * fire an automation at real contacts without the preview in front of it.
   */
  autoRun?: boolean
  templates: OutreachTemplate[]
  alertPresets: AlertPreset[]
  subscriptionTypes: SubscriptionType[]
  onEdit: () => void
  onDuplicate: () => void
  onToggle: () => void
  onRunNow: () => Promise<void>
  onDelete: () => void
}) {
  const t = useTranslations('Automations')
  const tCommon = useTranslations('Common')
  // Both entries into PreviewRunDialog: 'preview' is read-only and available on
  // a PAUSED rule too (the moment before arming it is exactly when "who does
  // this hit?" matters); 'run' is the confirmation that used to not exist.
  const [previewMode, setPreviewMode] = useState<'preview' | 'run' | null>(
    autoRun ? 'run' : null
  )
  // The other half of the same question. Preview answers "who does this hit if it
  // ran now"; history answers "did it run, when, and how many did it reach" —
  // which for a DELAYED rule (fired from a Cloud Task hours or days later) is
  // otherwise unanswerable from this page. See RunHistoryDialog (UX-48).
  const [historyOpen, setHistoryOpen] = useState(false)
  // Same rules-shaped gate as the page-level button — see AutomationsPage.
  const canSeeHistory = useCapabilities().can('outreach.manage')
  const subName = (id: string) => subscriptionTypes.find((s) => s.id === id)?.name ?? id

  const trigger = rule.trigger ?? { type: 'schedule_daily' }
  // The same summaries the card's action line renders — the dialog answers
  // "what will be sent" from this rather than re-deriving the copy.
  const actionLabels = rule.actions.map((a) => actionSummary(t, a, templates, undefined, alertPresets))

  return (
    <div
      className={`rounded-xl border bg-card p-4 space-y-3 transition-opacity ${rule.active ? '' : 'opacity-60'}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <TriggerIcon
            type={trigger.type}
            className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5"
          />
          <h3 className="font-semibold text-sm leading-tight truncate">
            {rule.name || t('ruleCard.unnamed')}
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={rule.active ? 'default' : 'secondary'} className="text-xs">
            {rule.active ? t('common.active') : t('common.paused')}
          </Badge>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent transition-colors">
              <MoreVertical className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-3.5 w-3.5 mr-2" />
                {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy className="h-3.5 w-3.5 mr-2" />
                {tCommon('duplicate')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onToggle}>
                {rule.active ? (
                  <>
                    <CirclePause className="h-3.5 w-3.5 mr-2" />
                    {t('ruleCard.pauseAction')}
                  </>
                ) : (
                  <>
                    <CirclePlay className="h-3.5 w-3.5 mr-2" />
                    {t('ruleCard.activateAction')}
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPreviewMode('preview')}>
                <Users className="h-3.5 w-3.5 mr-2" />
                {t('preview.previewAction')}
              </DropdownMenuItem>
              {/* Opens the confirmation — the send itself is one dialog away,
                  and that dialog states how many people it reaches. */}
              <DropdownMenuItem onClick={() => setPreviewMode('run')}>
                <Play className="h-3.5 w-3.5 mr-2" />
                {t('ruleCard.runNow')}
              </DropdownMenuItem>
              {canSeeHistory && (
                <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                  <History className="h-3.5 w-3.5 mr-2" />
                  {t('history.ruleAction')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Trigger line */}
      <div className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{triggerTypeLabel(t, trigger.type)}</span>
        {trigger.delayMinutes && trigger.delayMinutes > 0 && (
          <span className="ml-1">
            ·{' '}
            {trigger.delayMinutes < 60
              ? t('ruleCard.delayMinutes', { mins: trigger.delayMinutes })
              : t('ruleCard.delayHours', { hrs: trigger.delayMinutes / 60 })}
          </span>
        )}
      </div>

      {/* Condition chips — an empty list is a real state ("no filter"), not an
          absence of information, so it gets a chip of its own rather than a gap. */}
      <div className="flex flex-wrap gap-1.5">
        {rule.conditions.length === 0 ? (
          <span className="inline-flex items-center rounded-full border border-dashed px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {t('ruleCard.noConditions')}
          </span>
        ) : (
          rule.conditions.map((c, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground bg-muted"
            >
              {conditionSummary(t, c, subName)}
            </span>
          ))
        )}
      </div>

      {/* Action line */}
      {rule.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rule.actions.map((a, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary"
            >
              {a.type === 'send_email' && <Mail className="h-3 w-3" />}
              {a.type === 'create_alert' && <Bell className="h-3 w-3" />}
              {a.type === 'update_field' && <Settings2 className="h-3 w-3" />}
              {a.type === 'notify_team' && <Bell className="h-3 w-3" />}
              {a.type === 'log_activity' && <FileText className="h-3 w-3" />}
              {a.type === 'assign_tag' && <Tag className="h-3 w-3" />}
              {a.type === 'remove_tag' && <Tag className="h-3 w-3" />}
              {a.type === 'webhook' && <Webhook className="h-3 w-3" />}
              {actionSummary(t, a, templates, undefined, alertPresets)}
            </span>
          ))}
        </div>
      )}

      {/* Footer */}
      {rule.last_run_at && (
        <p className="text-xs text-muted-foreground border-t pt-2 mt-1">
          {t('ruleCard.lastRun', { timeAgo: timeAgo(t, rule.last_run_at) })}
          {rule.last_run_sent != null && ` · ${t('ruleCard.sentCount', { count: rule.last_run_sent })}`}
        </p>
      )}

      <PreviewRunDialog
        open={previewMode !== null}
        onOpenChange={(o) => !o && setPreviewMode(null)}
        teamId={teamId}
        ruleId={rule.id}
        ruleName={rule.name || t('ruleCard.unnamed')}
        ruleActive={rule.active}
        mode={previewMode ?? 'preview'}
        actionLabels={actionLabels}
        onRun={onRunNow}
      />
      {canSeeHistory && (
        <RunHistoryDialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          teamId={teamId}
          ruleId={rule.id}
          ruleName={rule.name || t('ruleCard.unnamed')}
        />
      )}
    </div>
  )
}

// ─── Condition editor ─────────────────────────────────────────────────────────

function ConditionEditor({
  conditions,
  onChange,
  subscriptionTypes,
  contactGroups,
}: {
  conditions: FormCondition[]
  onChange: (c: FormCondition[]) => void
  subscriptionTypes: SubscriptionType[]
  contactGroups: ContactGroup[]
}) {
  const t = useTranslations('Automations')
  const groupLabel = (g: string) => t(`groups.${g}` as Parameters<typeof t>[0])
  // 'any' / 'none' plus the team's actual subscription types, so a rule can target
  // a specific one (e.g. "subscribed to Athlete plan").
  const subscriptionOptions = [
    { value: 'any', label: t('conditions.subscriptionScope.any'), group: 'general' },
    { value: 'none', label: t('conditions.subscriptionScope.none'), group: 'general' },
    ...subscriptionTypes.map((s) => ({ value: s.id, label: s.name, group: 'subscriptionTypes' })),
  ]
  const resolvedConditionOptions = CONDITION_TYPE_OPTIONS
    .filter((o) => o.value !== 'in_group' || contactGroups.length > 0)
    .map((o) => ({
      ...o,
      label: conditionTypeLabel(t, o.value),
    }))
  function add() {
    onChange([...conditions, { type: 'acquisition_stage', value: 'trial_booked' }])
  }
  function remove(i: number) {
    onChange(conditions.filter((_, idx) => idx !== i))
  }
  function update(i: number, patch: Partial<FormCondition>) {
    onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  return (
    // A HAIRLINE BETWEEN CONDITIONS. They stack as two-row blocks of selects and
    // inputs, and with nothing but 8px of air between them a reader could not
    // tell where one condition ended and the next began — the rows INSIDE a
    // condition looked exactly like the gap BETWEEN two. `divide-y` plus a
    // little padding draws the boundary the eye is already hunting for.
    <div className="divide-y">
      {conditions.map((cond, i) => {
        const opt = CONDITION_TYPE_OPTIONS.find((o) => o.value === cond.type)
        const isFieldEquals = cond.type === 'field_equals'
        return (
          <div key={i} className="flex gap-2 items-start py-2 first:pt-0 last:pb-0">
            <div className="flex-1 space-y-1">
              {/* Row 1: type selector + inline value (all types except field_equals) */}
              {/* lg:grid-cols-1 — at lg this row sits inside a one-third-width
                  column, where two side-by-side selects would be unreadable. */}
              <div
                className={`grid gap-2 ${isFieldEquals ? 'grid-cols-1' : 'grid-cols-2 lg:grid-cols-1'}`}
              >
                {/* Type select */}
                <Select
                  value={cond.type}
                  onValueChange={(v: string | null) => {
                    const next = v ?? cond.type
                    const defaultVal =
                      next === 'acquisition_stage'
                        ? 'trial_booked'
                        : next === 'subscription'
                          ? 'any'
                          : next === 'subscription_status'
                            ? 'active'
                            : next === 'bio_link_booking_no_show'
                              ? '1'
                              : next === 'birthday_today'
                                ? ''
                              : next === 'has_affiliation'
                                ? ''
                                : next === 'tag' || next === 'field_equals'
                                    || next === 'affiliation_type' || next === 'in_group'
                                  ? ''
                                  : '7'
                    update(i, { type: next, value: defaultVal, condField: undefined })
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {conditionTypeLabel(t, cond.type)}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {renderGroupedOptions(resolvedConditionOptions, CONDITION_GROUP_ORDER, groupLabel)}
                  </SelectContent>
                </Select>

                {/* Inline value input (all types except field_equals which gets its own row) */}
                {!isFieldEquals && (
                  <>
                    {opt?.input === 'acquisition_stage_select' && (
                      <Select
                        value={cond.value}
                        onValueChange={(v) => update(i, { value: v ?? '' })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ACQUISITION_STAGE_VALUES.map((s) => (
                            <SelectItem key={s} value={s} className="text-xs">
                              {acquisitionStageLabel(t, s)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {opt?.input === 'group_select' && (
                      <Select value={cond.value} onValueChange={(v) => update(i, { value: v ?? '' })}>
                        <SelectTrigger className="h-8 text-xs">
                          <span className="flex flex-1 text-left text-xs truncate">
                            {contactGroups.find((g) => g.id === cond.value)?.name ?? (
                              <span className="text-muted-foreground">{t('actions.selectGroupPlaceholder')}</span>
                            )}
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          {/* Dynamic groups belong here: READING a derived group
                              is the whole point of in_group. Only WRITES exclude them. */}
                          {flattenGroupTree(contactGroups).map(({ group, depth }) => (
                            <SelectItem
                              key={group.id}
                              value={group.id}
                              className="text-xs"
                              // The indent IS the hierarchy, so it must stay
                              // inline — `textValue` registers the trigger's text
                              // without moving it to a second line.
                              textValue={`${group.name}${isDynamicGroup(group) ? ' ⚡' : ''}`}
                            >
                              <span style={{ paddingLeft: `${depth * 12}px` }}>
                                {group.name}{isDynamicGroup(group) ? ' ⚡' : ''}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {opt?.input === 'affiliation_type_select' && (
                      <Input
                        className="h-8 text-xs"
                        placeholder={t('conditions.affiliationTypeKeyPlaceholder')}
                        value={cond.value}
                        onChange={(e) => update(i, { value: e.target.value })}
                      />
                    )}
                    {opt?.input === 'subscription_select' && (
                      <Select
                        value={cond.value}
                        onValueChange={(v) => update(i, { value: v ?? '' })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <span className="flex flex-1 text-left text-xs truncate">
                            {subscriptionOptions.find((sv) => sv.value === cond.value)?.label ??
                              cond.value}
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          {renderGroupedOptions(subscriptionOptions, ['general', 'subscriptionTypes'], groupLabel)}
                        </SelectContent>
                      </Select>
                    )}
                    {opt?.input === 'subscription_status_select' && (
                      <Select
                        value={cond.value}
                        onValueChange={(v) => update(i, { value: v ?? 'active' })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <span className="flex flex-1 text-left text-xs truncate">
                            {subscriptionStatusLabel(t, cond.value)}
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          {SUBSCRIPTION_ROLLUP_STATUSES.map((sv) => (
                            <SelectItem key={sv} value={sv} className="text-xs">
                              {subscriptionStatusLabel(t, sv)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {opt?.input === 'number' && (
                      <Input
                        type="number"
                        min={0}
                        className="h-8 text-xs"
                        value={cond.value}
                        onChange={(e) => update(i, { value: e.target.value })}
                      />
                    )}
                    {/* The no-show window, in days after the session. Stored as
                        `delay_days` (not `value`) — see the save mapping. */}
                    {opt?.input === 'no_show_days' && (
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          min={1}
                          className="h-8 text-xs"
                          value={cond.value}
                          onChange={(e) => update(i, { value: e.target.value })}
                        />
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {t('conditions.daysAfterSession')}
                        </span>
                      </div>
                    )}
                    {opt?.input === 'text' && (
                      <Input
                        className="h-8 text-xs"
                        placeholder={t('conditions.tagPlaceholder')}
                        value={cond.value}
                        onChange={(e) => update(i, { value: e.target.value })}
                      />
                    )}
                    {opt?.input === 'none' && <div />}
                  </>
                )}
              </div>

              {/* Row 2: field_equals — field name + value on separate row */}
              {isFieldEquals && (
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    className="h-8 text-xs"
                    placeholder={t('conditions.fieldEqualsFieldPlaceholder')}
                    value={cond.condField ?? ''}
                    onChange={(e) => update(i, { condField: e.target.value })}
                  />
                  <Input
                    className="h-8 text-xs"
                    placeholder={t('conditions.valuePlaceholder')}
                    value={cond.value}
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                </div>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => remove(i)}
            >
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 h-7 text-xs"
        onClick={add}
      >
        <Plus className="h-3 w-3 mr-1" />
        {t('conditions.addCondition')}
      </Button>
    </div>
  )
}

// ─── Action editor ────────────────────────────────────────────────────────────

// update_field catalog: built-in contact fields + (in ActionEditor) the team's
// custom fields. `kind` drives the value editor; keep in lockstep with the engine
// allowlist in packages/functions/src/utils/automationEngine.ts.
interface UpdateFieldOption {
  value: string
  /** Custom fields / ranks: the display label (built-ins translate via updateFieldLabel). */
  label?: string
  kind: 'enum' | 'text' | 'boolean' | 'number' | 'date'
  values?: readonly string[]
  /** For enum kinds whose raw values need friendly labels (e.g. rank levels). */
  valueLabels?: Record<string, string>
}

const STATIC_UPDATE_FIELD_OPTIONS: readonly UpdateFieldOption[] = [
  { value: 'acquisition_stage', kind: 'enum', values: ACQUISITION_STAGE_VALUES },
  { value: 'source', kind: 'enum', values: CONTACT_SOURCES },
  { value: 'source_detail', kind: 'text' },
  { value: 'notes', kind: 'text' },
  { value: 'lead_acknowledged', kind: 'boolean' },
]

/** Map a custom-field definition to an update_field option (dotted path). */
function customFieldOption(d: CustomFieldDefinition): UpdateFieldOption {
  return {
    value: `custom_fields.${d.id}`,
    label: d.label || d.id,
    kind:
      d.type === 'number' ? 'number'
      : d.type === 'checkbox' ? 'boolean'
      : d.type === 'date' ? 'date'
      : d.type === 'select' ? 'enum'
      : 'text',
    ...(d.type === 'select' ? { values: d.options ?? [] } : {}),
  }
}

/** Map a ranking system to an update_field option (dotted path `ranks.{id}`). */
function rankSystemOption(r: RankingSystem): UpdateFieldOption {
  // Ladder order, and the level's KEY (its id) as the value the engine writes.
  const levels = orderedLevels(r)
  return {
    value: `ranks.${r.id}`,
    label: r.name || r.id,
    kind: 'enum',
    values: levels.map((l) => String(rankLevelKey(l))),
    valueLabels: Object.fromEntries(levels.map((l) => [String(rankLevelKey(l)), l.label])),
  }
}

function ActionEditor({
  actions,
  templates,
  alertPresets,
  onChange,
  actionTypeLabels: labelOverrides,
  contactGroups,
  groupsEnabled,
}: {
  actions: FormAction[]
  templates: OutreachTemplate[]
  alertPresets: AlertPreset[]
  onChange: (a: FormAction[]) => void
  actionTypeLabels?: Record<string, string>
  contactGroups: ContactGroup[]
  groupsEnabled: boolean
}) {
  const t = useTranslations('Automations')
  const { team } = useAuth()
  const { rankingSystems } = useRankingSystems()
  const resolvedActionLabels = labelOverrides ?? defaultActionTypeLabels(t)
  function add() {
    onChange([...actions, { type: 'send_email', templateId: '' }])
  }
  function remove(i: number) {
    onChange(actions.filter((_, idx) => idx !== i))
  }
  function update(i: number, patch: Partial<FormAction>) {
    onChange(actions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)))
  }

  // Built-in fields + the EFFECTIVE ranking systems + custom fields (plugin
  // definitions).
  //
  // Effective, not `team.ranking_systems`: an org-managed tenant keeps its
  // systems on the organisation, so this list was empty and an HMD studio saw
  // no rank field to automate at all. The server-side engine validates against
  // the same rule (`isKnownRankingSystem` over `resolveRankingSystems`), so a
  // rule built here is one the engine will actually run.
  const updateFieldOptions = useMemo<UpdateFieldOption[]>(
    () => [
      ...STATIC_UPDATE_FIELD_OPTIONS,
      ...rankingSystems.map(rankSystemOption),
      ...(team?.custom_field_definitions ?? []).map(customFieldOption),
    ],
    [team, rankingSystems]
  )

  const selectedFieldMeta = (action: FormAction) =>
    updateFieldOptions.find((o) => o.value === action.field)

  return (
    <div className="space-y-3">
      {actions.map((action, i) => (
        <div key={i} className="flex gap-2 items-start">
          <div className="flex-1 space-y-2">
            {/* Row 1: action type + inline secondary for simple types.
                lg:grid-cols-1 for the same reason as the condition rows. */}
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
              <Select
                value={action.type}
                onValueChange={(v) =>
                  update(i, {
                    type: v ?? 'send_email',
                    templateId: '',
                    field: undefined,
                    fieldValue: undefined,
                    subject: undefined,
                    body: undefined,
                    message: undefined,
                    note: undefined,
                    tag: undefined,
                    url: undefined,
                    group_id: undefined,
                    presetId: undefined,
                  })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <span className="flex flex-1 text-left text-xs truncate">
                    {resolvedActionLabels[action.type] ?? action.type}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="send_email" className="text-xs">
                    {t('actions.types.send_email')}
                  </SelectItem>
                  <SelectItem value="add_note" className="text-xs">
                    {t('actions.types.add_note')}
                  </SelectItem>
                  <SelectItem value="update_field" className="text-xs">
                    {t('actions.types.update_field')}
                  </SelectItem>
                  <SelectItem value="assign_tag" className="text-xs">
                    {t('actions.types.assign_tag')}
                  </SelectItem>
                  <SelectItem value="remove_tag" className="text-xs">
                    {t('actions.types.remove_tag')}
                  </SelectItem>
                  <SelectItem value="notify_team" className="text-xs">
                    {t('actions.types.notify_team')}
                  </SelectItem>
                  <SelectItem value="log_activity" className="text-xs">
                    {t('actions.types.log_activity')}
                  </SelectItem>
                  {/* `archive_contact` was in the label map and in the engine (the
                      'lib_trial_cleanup' library rule uses it) but was missing
                      from this list — so a studio could READ a rule that archives
                      and never write one, and changing that rule's action type
                      was a one-way door. */}
                  <SelectItem value="archive_contact" className="text-xs">
                    {t('actions.types.archive_contact')}
                  </SelectItem>
                  <SelectItem value="webhook" className="text-xs">
                    {t('actions.types.webhook')}
                  </SelectItem>
                  {groupsEnabled && (
                    <>
                      <SelectItem value="add_to_group" className="text-xs">
                        {t('actions.types.add_to_group')}
                      </SelectItem>
                      <SelectItem value="remove_from_group" className="text-xs">
                        {t('actions.types.remove_from_group')}
                      </SelectItem>
                    </>
                  )}
                  <SelectItem value="create_alert" className="text-xs">
                    {t('actions.createAlertLabel')}
                  </SelectItem>
                </SelectContent>
              </Select>

              {/* Inline secondary for send_email */}
              {action.type === 'send_email' && (
                <Select
                  value={action.templateId}
                  onValueChange={(v) => update(i, { templateId: v ?? '' })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {templates.find((tm) => tm.id === action.templateId)?.name ?? (
                        <span className="text-muted-foreground">{t('actions.selectTemplatePlaceholder')}</span>
                      )}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {templates.length === 0 ? (
                      <SelectItem value="__none" disabled className="text-xs text-muted-foreground">
                        {t('actions.noTemplates')}
                      </SelectItem>
                    ) : (
                      templates.map((tm) => (
                        <SelectItem key={tm.id} value={tm.id} className="text-xs">
                          {tm.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}

              {/* Inline secondary for create_alert — the same shape as send_email's
                  template picker. Until UX-51 this was a "coming soon" note while
                  the ENGINE had executed the action all along (it resolves
                  teams/{id}/alert_presets/{presetId} and writes the contact
                  alert); the only thing missing was a way to name the preset,
                  and the save then dropped the action entirely. */}
              {action.type === 'create_alert' && (
                <Select
                  value={action.presetId ?? ''}
                  onValueChange={(v) => update(i, { presetId: v ?? '' })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {alertPresets.find((p) => p.id === action.presetId)?.name ?? (
                        <span className="text-muted-foreground">{t('actions.selectPresetPlaceholder')}</span>
                      )}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {alertPresets.length === 0 ? (
                      <SelectItem value="__none" disabled className="text-xs text-muted-foreground">
                        {t('actions.noAlertPresets')}
                      </SelectItem>
                    ) : (
                      alertPresets.map((p) => (
                        <SelectItem key={p.id} value={p.id} className="text-xs">
                          {p.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Row 2+: expanded controls for complex types */}

            {action.type === 'update_field' && (
              <div className="grid grid-cols-2 gap-2">
                <Select
                  value={action.field ?? ''}
                  onValueChange={(v) => {
                    const meta = updateFieldOptions.find((o) => o.value === v)
                    update(i, {
                      field: v ?? '',
                      // Sensible default per kind: first enum value / 'true' / empty text.
                      fieldValue:
                        meta?.kind === 'enum'
                          ? (meta.values?.[0] ?? '')
                          : meta?.kind === 'boolean'
                            ? 'true'
                            : '',
                    })
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {action.field ? (
                        updateFieldLabel(t, action.field, selectedFieldMeta(action)?.label)
                      ) : (
                        <span className="text-muted-foreground">{t('actions.fieldPlaceholder')}</span>
                      )}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {updateFieldOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="text-xs">
                        {updateFieldLabel(t, o.value, o.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {(() => {
                  const meta = selectedFieldMeta(action)
                  // Enum fields (stage / source / select custom fields) → picker.
                  if (!meta || meta.kind === 'enum') {
                    return (
                      <Select
                        value={action.fieldValue ?? ''}
                        onValueChange={(v) => update(i, { fieldValue: v ?? '' })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder={t('actions.valuePlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {(meta?.values ?? []).map((v) => (
                            <SelectItem key={v} value={v} className="text-xs">
                              {meta?.value === 'acquisition_stage'
                                ? acquisitionStageLabel(t, v)
                                : (meta?.valueLabels?.[v] ?? v)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )
                  }
                  if (meta.kind === 'boolean') {
                    return (
                      <Select
                        value={action.fieldValue ?? 'true'}
                        onValueChange={(v) => update(i, { fieldValue: v ?? 'true' })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true" className="text-xs">{t('actions.boolTrue')}</SelectItem>
                          <SelectItem value="false" className="text-xs">{t('actions.boolFalse')}</SelectItem>
                        </SelectContent>
                      </Select>
                    )
                  }
                  // text / number / date → typed input (value stored as string; the
                  // engine coerces per the field definition).
                  return (
                    <Input
                      type={meta.kind === 'number' ? 'number' : meta.kind === 'date' ? 'date' : 'text'}
                      value={action.fieldValue ?? ''}
                      onChange={(e) => update(i, { fieldValue: e.target.value })}
                      placeholder={t('actions.valuePlaceholder')}
                      className="h-8 text-xs"
                    />
                  )
                })()}
              </div>
            )}

            {action.type === 'notify_team' && (
              <div className="space-y-2">
                <Input
                  className="h-8 text-xs"
                  placeholder={t('actions.notifyTeam.subjectPlaceholder')}
                  value={action.subject ?? ''}
                  onChange={(e) => update(i, { subject: e.target.value })}
                />
                <Textarea
                  className="text-xs font-mono resize-none"
                  rows={3}
                  placeholder={t('actions.notifyTeam.bodyPlaceholder')}
                  value={action.body ?? ''}
                  onChange={(e) => update(i, { body: e.target.value })}
                />
              </div>
            )}

            {action.type === 'log_activity' && (
              <Input
                className="h-8 text-xs"
                placeholder={t('actions.logActivity.messagePlaceholder')}
                value={action.message ?? ''}
                onChange={(e) => update(i, { message: e.target.value })}
              />
            )}

            {action.type === 'add_note' && (
              <div className="space-y-1">
                <Textarea
                  className="text-xs resize-none"
                  rows={3}
                  placeholder={t('actions.addNote.placeholder')}
                  value={action.note ?? ''}
                  onChange={(e) => update(i, { note: e.target.value })}
                />
                <p className="text-[11px] text-muted-foreground">{t('actions.addNote.hint')}</p>
              </div>
            )}

            {(action.type === 'assign_tag' || action.type === 'remove_tag') && (
              <Input
                className="h-8 text-xs"
                placeholder={t('actions.tagPlaceholder')}
                value={action.tag ?? ''}
                onChange={(e) => update(i, { tag: e.target.value })}
              />
            )}

            {action.type === 'webhook' && (
              <Input
                className="h-8 text-xs"
                placeholder={t('actions.webhookUrlPlaceholder')}
                value={action.url ?? ''}
                onChange={(e) => update(i, { url: e.target.value })}
              />
            )}

            {(action.type === 'add_to_group' || action.type === 'remove_from_group') && (() => {
              // Writable groups only. A DYNAMIC group's membership is its rule —
              // writing group_ids for one would be a no-op the user can't see.
              const writable = flattenGroupTree(contactGroups).filter(({ group }) => !isDynamicGroup(group))
              return (
                <Select value={action.group_id ?? ''} onValueChange={(v) => update(i, { group_id: v ?? '' })}>
                  <SelectTrigger className="h-8 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {contactGroups.find((g) => g.id === action.group_id)?.name ?? (
                        <span className="text-muted-foreground">{t('actions.selectGroupPlaceholder')}</span>
                      )}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {writable.length === 0 ? (
                      <SelectItem value="__none" disabled className="text-xs text-muted-foreground">
                        {t('actions.noGroupsYet')}
                      </SelectItem>
                    ) : (
                      // Indented like every other group picker — the old flat list
                      // hid the hierarchy the rest of the app shows.
                      writable.map(({ group, depth }) => (
                        <SelectItem
                          key={group.id}
                          value={group.id}
                          className="text-xs"
                          textValue={group.name}
                        >
                          <span style={{ paddingLeft: `${depth * 12}px` }}>{group.name}</span>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )
            })()}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => remove(i)}
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={add}>
        <Plus className="h-3 w-3 mr-1" />
        {t('actions.addAction')}
      </Button>
    </div>
  )
}

// ─── RuleDialog ───────────────────────────────────────────────────────────────

function createRuleSchema(t: ReturnType<typeof useTranslations>) {
  return z.object({
    name: z.string().min(1, t('validation.nameRequired')),
    trigger_type: z.string().min(1, t('validation.triggerRequired')),
    delay_minutes: z.coerce.number().min(0).optional(),
    active: z.boolean(),
  })
}

type RuleFormValues = z.infer<ReturnType<typeof createRuleSchema>>

function RuleDialog({
  open,
  onOpenChange,
  teamId,
  editing,
  duplicating,
  templates,
  webhookEndpoints,
  onSaved,
  triggerOptions: triggerOptionsProp,
  actionTypeLabels: actionTypeLabelsProp,
  prefill,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  editing: AutomationRule | null
  /** The rule a NEW one is being copied from. `editing` stays null, so the save
   *  is an `addDoc` — a copy carries no `system_key` (that marks a starter-kit
   *  rule and is what stops it being seeded twice), no run history, and starts
   *  PAUSED: a rule that begins firing the moment it is saved is not a copy the
   *  studio has had a chance to read. */
  duplicating: AutomationRule | null
  templates: OutreachTemplate[]
  webhookEndpoints: WebhookEndpoint[]
  onSaved: () => void
  triggerOptions?: Array<{
    value: string
    label: string
    icon: React.ElementType
    supportsDelay: boolean
  }>
  actionTypeLabels?: Record<string, string>
  // Deep-link prefill for a NEW rule (e.g. from the subscription editor).
  prefill?: { triggerType?: string; subscriptionTypeId?: string }
}) {
  const t = useTranslations('Automations')
  const tCommon = useTranslations('Common')
  const groupLabel = (g: string) => t(`groups.${g}` as Parameters<typeof t>[0])
  const resolvedTriggerOptions =
    triggerOptionsProp ?? TRIGGER_OPTIONS.map((o) => ({ ...o, label: triggerTypeLabel(t, o.value) }))
  const { data: subscriptionTypes = [] } = useSubscriptionTypes(teamId)
  const { data: alertPresets = [] } = useAlertPresets(teamId)
  const { isInstalled } = useInstalledPlugins()
  const groupsEnabled = isInstalled('contact-groups')
  const { data: contactGroups = [] } = useContactGroups(groupsEnabled ? teamId : null)
  const [conditions, setConditions] = useState<FormCondition[]>([])
  const [actions, setActions] = useState<FormAction[]>([])
  const [webhookEndpointId, setWebhookEndpointId] = useState('')
  // Scope for the added/removed delta triggers ('' = any type).
  const [triggerSubTypeId, setTriggerSubTypeId] = useState('')
  const [triggerAffTypeKey, setTriggerAffTypeKey] = useState('')
  // Scope for the payment_* triggers ('' = any kind).
  const [triggerPaymentKind, setTriggerPaymentKind] = useState('')
  const [submitError, setSubmitError] = useState('')
  const ruleSchema = useMemo(() => createRuleSchema(t), [t])

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<RuleFormValues>({
    resolver: zodResolver(ruleSchema),
    defaultValues: { name: '', trigger_type: 'schedule_daily', delay_minutes: 0, active: true },
  })

  const triggerType = watch('trigger_type')
  const supportsDelay =
    resolvedTriggerOptions.find((opt) => opt.value === triggerType)?.supportsDelay ?? false

  // No conditions = no filter = every contact. Harmless for an event trigger, which
  // is already scoped to the contact that caused it; unacceptable for schedule_daily,
  // whose contact set is the whole team. onSubmit blocks that case.
  const needsDailyCondition = triggerType === 'schedule_daily' && conditions.length === 0
  const conditionsHint =
    conditions.length > 0
      ? t('sections.conditionsHint')
      : needsDailyCondition
        ? t('sections.conditionsHintDailyEmpty')
        : t('sections.conditionsHintEmpty')

  // Populate form when editing — or when copying, which fills the SAME form and
  // then saves through the create branch below.
  useEffect(() => {
    if (!open) return
    const seed = editing ?? duplicating
    if (seed) {
      reset({
        name: duplicating ? tCommon('copyName', { name: seed.name }) : seed.name,
        trigger_type: seed.trigger.type,
        delay_minutes: seed.trigger.delayMinutes ?? 0,
        // A copy is PAUSED until the studio arms it.
        active: duplicating ? false : seed.active,
      })
      setConditions(
        seed.conditions.map((c) => ({
          type: c.type,
          value:
            (c as { group_id?: string }).group_id
            ?? c.value
            ?? (c.delay_days != null ? String(c.delay_days) : ''),
          condField: (c as { field?: string }).field,
        }))
      )
      setActions(
        seed.actions.map((a) => ({
          type: a.type,
          templateId: a.templateId ?? '',
          presetId: a.presetId,
          field: a.field,
          fieldValue: a.value != null ? String(a.value) : undefined,
          subject: a.subject,
          body: a.body,
          message: a.message,
          note: (a as { note?: string }).note,
          tag: (a as { tag?: string }).tag,
          url: (a as { url?: string }).url,
          group_id: (a as { group_id?: string }).group_id,
        }))
      )
      setWebhookEndpointId(seed.trigger.webhook_endpoint_id ?? '')
      setTriggerSubTypeId(seed.trigger.subscriptionTypeId ?? '')
      setTriggerAffTypeKey(seed.trigger.affiliationTypeKey ?? '')
      setTriggerPaymentKind(seed.trigger.paymentKind ?? '')
    } else {
      reset({
        name: '',
        trigger_type: prefill?.triggerType ?? 'schedule_daily',
        delay_minutes: 0,
        active: true,
      })
      setConditions([])
      setActions([])
      setWebhookEndpointId('')
      setTriggerSubTypeId(prefill?.subscriptionTypeId ?? '')
      setTriggerAffTypeKey('')
      setTriggerPaymentKind('')
    }
    setSubmitError('')
  }, [open, editing, duplicating, reset, prefill, tCommon])

  const onSubmit = async (values: RuleFormValues) => {
    setSubmitError('')

    // Conditions are an AND-filter, so an empty list means "every contact". That is
    // the natural intent for an event trigger (the event already picks the contact),
    // but schedule_daily's contact set is the whole team — so it needs at least one.
    // The engine enforces this too; failing here gives the user an explanation
    // instead of a rule that saves happily and then silently never runs.
    if (values.trigger_type === 'schedule_daily' && conditions.length === 0) {
      setSubmitError(t('validation.conditionRequiredDaily'))
      return
    }

    // An in_group condition with no group picked would save happily and then
    // match nobody, forever — the same silent-no-op trap the action list guards
    // against. Say so instead.
    if (conditions.some((c) => c.type === 'in_group' && !c.value)) {
      setSubmitError(t('validation.groupRequired'))
      return
    }

    // An action whose TARGET is missing is the same defect in the other half of
    // the rule, and until UX-51 each was handled by quietly dropping or storing
    // something inert: create_alert was filtered out of the payload entirely,
    // add_to_group/remove_from_group with no group were filtered out, and
    // send_email with no template saved a rule the engine then refuses to run
    // ("template not found"). Nothing may leave this dialog unsaid.
    if (actions.some((a) => a.type === 'send_email' && !a.templateId)) {
      setSubmitError(t('validation.templateRequired'))
      return
    }
    if (actions.some((a) => a.type === 'create_alert' && !a.presetId)) {
      setSubmitError(t('validation.alertPresetRequired'))
      return
    }
    if (
      actions.some(
        (a) => (a.type === 'add_to_group' || a.type === 'remove_from_group') && !a.group_id
      )
    ) {
      setSubmitError(t('validation.groupRequiredAction'))
      return
    }

    try {
      const ruleData = {
        name: values.name.trim(),
        active: values.active,
        trigger: {
          type: values.trigger_type,
          // Clamped to the Cloud Tasks ceiling here as well as in the engine,
          // so the number the studio sees stored is the number that will run.
          ...(supportsDelay && values.delay_minutes && values.delay_minutes > 0
            ? { delayMinutes: Math.min(Math.floor(values.delay_minutes), MAX_DELAY_MINUTES) }
            : {}),
          ...(values.trigger_type === 'inbound_webhook' && webhookEndpointId
            ? { webhook_endpoint_id: webhookEndpointId }
            : {}),
          ...(SUBSCRIPTION_SCOPED_TRIGGERS.includes(values.trigger_type) && triggerSubTypeId
            ? { subscriptionTypeId: triggerSubTypeId }
            : {}),
          ...((values.trigger_type === 'affiliation_added' ||
            values.trigger_type === 'affiliation_removed') &&
          triggerAffTypeKey.trim()
            ? { affiliationTypeKey: triggerAffTypeKey.trim() }
            : {}),
          ...(PAYMENT_TRIGGERS.includes(values.trigger_type) && triggerPaymentKind
            ? { paymentKind: triggerPaymentKind }
            : {}),
        },
        conditions: conditions.map((c) => {
          const opt = CONDITION_TYPE_OPTIONS.find((o) => o.value === c.type)
          if (opt?.input === 'number') return { type: c.type, value: Number(c.value) }
          // The no-show window is `delay_days`, not `value`, and it was NOT
          // round-tripping: the editor loaded it and the save wrote a bare
          // `{ type }`, so opening a 5-day library rule and pressing Save reset
          // it to the engine's 1-day default. It is an editable number now.
          if (c.type === 'bio_link_booking_no_show')
            return { type: c.type, delay_days: Math.max(1, Number(c.value) || 1) }
          if (opt?.input === 'none') return { type: c.type }
          if (c.type === 'field_equals')
            return { type: 'field_equals', field: c.condField ?? '', value: c.value }
          if (c.type === 'in_group') return { type: 'in_group', group_id: c.value }
          return { type: c.type, value: c.value }
        }),
        actions: actions
          .map((a) => {
            if (a.type === 'send_email') return { type: 'send_email', templateId: a.templateId }
            if (a.type === 'create_alert')
              return { type: 'create_alert', presetId: a.presetId ?? '' }
            if (a.type === 'add_note') return { type: 'add_note', note: a.note ?? '' }
            if (a.type === 'update_field')
              return { type: 'update_field', field: a.field ?? '', value: a.fieldValue ?? '' }
            if (a.type === 'notify_team')
              return { type: 'notify_team', subject: a.subject ?? '', body: a.body ?? '' }
            if (a.type === 'log_activity') return { type: 'log_activity', message: a.message ?? '' }
            if (a.type === 'assign_tag') return { type: 'assign_tag', tag: a.tag ?? '' }
            if (a.type === 'remove_tag') return { type: 'remove_tag', tag: a.tag ?? '' }
            if (a.type === 'webhook') return { type: 'webhook', url: a.url ?? '' }
            if (a.type === 'add_to_group') return { type: 'add_to_group', group_id: a.group_id ?? '' }
            if (a.type === 'remove_from_group')
              return { type: 'remove_from_group', group_id: a.group_id ?? '' }
            return { type: a.type }
          }),
        updated_at: serverTimestamp(),
      }

      const rulesRef = collection(db, TEAMS_COLLECTION, teamId, AUTOMATION_RULES_SUBCOLLECTION)
      if (editing) {
        await updateDoc(doc(rulesRef, editing.id), ruleData)
      } else {
        await addDoc(rulesRef, { ...ruleData, created_at: serverTimestamp() })
      }

      onSaved()
      onOpenChange(false)
    } catch (err) {
      setSubmitError((err as Error).message || t('dialogs.rule.saveFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px] lg:max-w-[1100px]">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('dialogs.rule.editTitle')
              : duplicating
                ? tCommon('duplicate')
                : t('common.newAutomation')}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col gap-5">
          <DialogBody className="space-y-5">
          {/* Name + active */}
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <Label htmlFor="rl-name" className="text-xs font-medium">
                {t('dialogs.rule.nameLabel')}
              </Label>
              <Input
                id="rl-name"
                {...register('name')}
                placeholder={t('dialogs.rule.namePlaceholder')}
                className="mt-1"
              />
              {errors.name && (
                <p className="text-xs text-destructive mt-1">{errors.name.message}</p>
              )}
            </div>
            <div className="flex items-center gap-2 pb-0.5">
              <Switch
                id="rl-active"
                checked={watch('active')}
                onCheckedChange={(v) => setValue('active', v)}
              />
              <Label htmlFor="rl-active" className="text-xs">
                {t('common.active')}
              </Label>
            </div>
          </div>

          <Separator />

          {/*
            Trigger → conditions → actions reads as one left-to-right sentence on lg,
            where the extra width is there to spend. Below lg it falls back to the
            stacked order, which is the same sequence read top-to-bottom.
            The mobile <Separator />s are grid children that vanish at lg, letting
            divide-x draw the column rules instead.
          */}
          <div className="grid gap-5 lg:grid-cols-3 lg:gap-0 lg:divide-x">
            {/* Trigger */}
            <div className="space-y-2 lg:pr-5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t('sections.trigger')}
              </p>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
              <div>
                <Label className="text-xs">{t('dialogs.rule.whenLabel')}</Label>
                <Select
                  value={triggerType}
                  onValueChange={(v) => setValue('trigger_type', v ?? '')}
                >
                  <SelectTrigger className="mt-1 h-8 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {resolvedTriggerOptions.find((opt) => opt.value === triggerType)?.label ??
                        triggerType}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {renderGroupedOptions(resolvedTriggerOptions, TRIGGER_GROUP_ORDER, groupLabel)}
                  </SelectContent>
                </Select>
              </div>

              {supportsDelay && (
                <div>
                  <Label className="text-xs">{t('dialogs.rule.delayLabel')}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={MAX_DELAY_MINUTES}
                    className="mt-1 h-8 text-xs"
                    {...register('delay_minutes')}
                    placeholder="0"
                  />
                </div>
              )}
            </div>

            {/* Inbound webhook — endpoint selector */}
            {triggerType === 'inbound_webhook' && (
              <div>
                <Label className="text-xs">{t('dialogs.rule.webhookEndpointLabel')}</Label>
                {webhookEndpoints.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('dialogs.rule.noWebhookEndpoints')}
                  </p>
                ) : (
                  <Select
                    value={webhookEndpointId}
                    onValueChange={(v) => setWebhookEndpointId(v ?? '')}
                  >
                    <SelectTrigger className="mt-1 h-8 text-xs">
                      <span className="flex flex-1 text-left text-xs truncate">
                        {webhookEndpoints.find((ep) => ep.id === webhookEndpointId)?.name ?? (
                          <span className="text-muted-foreground">{t('dialogs.rule.selectEndpointPlaceholder')}</span>
                        )}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {webhookEndpoints.map((ep) => (
                        <SelectItem key={ep.id} value={ep.id} className="text-xs">
                          {ep.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* Delta trigger scope — which subscription type the event was about */}
            {SUBSCRIPTION_SCOPED_TRIGGERS.includes(triggerType) && (
              <div>
                <Label className="text-xs">{t('dialogs.rule.subscriptionTypeLabel')}</Label>
                <Select value={triggerSubTypeId} onValueChange={(v) => setTriggerSubTypeId(v ?? '')}>
                  <SelectTrigger className="mt-1 h-8 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {triggerSubTypeId
                        ? (subscriptionTypes.find((s) => s.id === triggerSubTypeId)?.name ??
                          triggerSubTypeId)
                        : t('conditions.subscriptionScope.any')}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="" className="text-xs">{t('conditions.subscriptionScope.any')}</SelectItem>
                    {subscriptionTypes.map((s) => (
                      <SelectItem key={s.id} value={s.id} className="text-xs">
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Delta trigger scope — what the payment bought */}
            {PAYMENT_TRIGGERS.includes(triggerType) && (
              <div>
                <Label className="text-xs">{t('dialogs.rule.paymentKindLabel')}</Label>
                <Select
                  value={triggerPaymentKind}
                  onValueChange={(v) => setTriggerPaymentKind(v ?? '')}
                >
                  <SelectTrigger className="mt-1 h-8 text-xs">
                    <span className="flex flex-1 text-left text-xs truncate">
                      {triggerPaymentKind
                        ? t(`paymentKinds.${triggerPaymentKind}` as Parameters<typeof t>[0])
                        : t('paymentKinds.any')}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="" className="text-xs">{t('paymentKinds.any')}</SelectItem>
                    {PAYMENT_KINDS.map((k) => (
                      <SelectItem key={k} value={k} className="text-xs">
                        {t(`paymentKinds.${k}` as Parameters<typeof t>[0])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Delta trigger scope — which affiliation type was added/removed */}
            {(triggerType === 'affiliation_added' || triggerType === 'affiliation_removed') && (
              <div>
                <Label className="text-xs">{t('dialogs.rule.affiliationTypeKeyLabel')}</Label>
                <Input
                  className="mt-1 h-8 text-xs"
                  placeholder={t('dialogs.rule.affiliationTypeKeyPlaceholder')}
                  value={triggerAffTypeKey}
                  onChange={(e) => setTriggerAffTypeKey(e.target.value)}
                />
              </div>
            )}
            </div>

            <Separator className="lg:hidden" />

            {/* Conditions */}
            <div className="space-y-2 lg:px-5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t('sections.conditions')}{' '}
                <span
                  className={`normal-case font-normal ${needsDailyCondition ? 'text-destructive' : ''}`}
                >
                  {conditionsHint}
                </span>
              </p>
              <ConditionEditor
                conditions={conditions}
                onChange={setConditions}
                subscriptionTypes={subscriptionTypes}
                contactGroups={contactGroups}
              />
            </div>

            <Separator className="lg:hidden" />

            {/* Actions */}
            <div className="space-y-2 lg:pl-5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t('sections.actions')}
              </p>
              <ActionEditor
                actions={actions}
                templates={templates}
                alertPresets={alertPresets}
                onChange={setActions}
                actionTypeLabels={actionTypeLabelsProp}
                contactGroups={contactGroups}
                groupsEnabled={groupsEnabled}
              />
            </div>
          </div>

          {submitError && <p className="text-xs text-destructive">{submitError}</p>}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t('common.saving') : t('dialogs.rule.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── page ────────────────────────────────────────────────────────────────────

export default function AutomationsPage() {
  // Styled confirmation, replacing a browser `confirm()` (see confirm-dialog).
  const { confirm, confirmDialog } = useConfirm()
  const tCommon = useTranslations('Common')
  const t = useTranslations('Automations')
  // The dashboard's quick action for one rule: `/automations?run={ruleId}`.
  // Read once — the card it names opens its RUN confirmation on mount, which is
  // the same dialog its own button opens. Nothing here runs anything.
  const quickActionRunId = useSearchParams().get('run')
  const planName = usePlanName()
  const { currentTeamId, user } = useAuth()
  const { plan, isAtLeast } = usePlan()
  // `automation_logs` is manager/owner-read in firestore.rules, so the history
  // entry points are offered only to someone the rules would actually serve —
  // an ungated button here would hand a coach a permission error instead of a
  // dialog.
  const canSeeHistory = useCapabilities().can('outreach.manage')
  // Automations are available on every tier; Studio/Org get the full suite while
  // Free/Coach are limited to the triggers/actions of their active modules and
  // installed add-ons (the builder only offers those). Show a note below Studio.
  const fullAutomations = isAtLeast('studio')
  const qc = useQueryClient()
  const invalidateSetupChecklist = useInvalidateSetupChecklist()

  // Plugin-contributed triggers and actions
  const { plugins: installedPlugins } = useInstalledPlugins()

  const allTriggerOptions = [
    ...TRIGGER_OPTIONS.map((o) => ({ ...o, label: triggerTypeLabel(t, o.value) })),
    ...installedPlugins.flatMap((p) =>
      (p.manifest.automationTriggers ?? []).map((tr) => ({
        value: tr.id,
        label: tr.labelKey
          .replace('Plugins.', '')
          .replace(/([A-Z])/g, ' $1')
          .trim(),
        icon: Zap,
        supportsDelay: tr.supportsDelay,
        isPlugin: true,
      }))
    ),
  ]

  const pluginActionLabels: Record<string, string> = Object.fromEntries(
    installedPlugins.flatMap((p) =>
      (p.manifest.automationActions ?? []).map((ac) => [
        ac.id,
        ac.labelKey
          .replace('Plugins.', '')
          .replace(/([A-Z])/g, ' $1')
          .trim(),
      ])
    )
  )

  const allActionTypeLabels: Record<string, string> = {
    ...defaultActionTypeLabels(t),
    ...pluginActionLabels,
  }

  const { data: rules = [], isLoading: rulesLoading } = useRules(currentTeamId)
  const { data: subscriptionTypes = [] } = useSubscriptionTypes(currentTeamId)
  const { data: templates = [] } = useTemplates(currentTeamId)
  const { data: alertPresets = [] } = useAlertPresets(currentTeamId)
  const { data: webhookEndpoints = [] } = useQuery<WebhookEndpoint[]>({
    queryKey: ['webhook_endpoints', currentTeamId],
    enabled: !!currentTeamId,
    queryFn: async () => {
      if (!currentTeamId) return []
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, currentTeamId, WEBHOOK_ENDPOINTS_SUBCOLLECTION)
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as WebhookEndpoint)
    },
  })

  // Rules vs the system-emails inventory — segmented views so the System emails
  // panel isn't pushed below a long rule list.
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null)
  const [duplicatingRule, setDuplicatingRule] = useState<AutomationRule | null>(null)
  const [prefill, setPrefill] = useState<
    { triggerType?: string; subscriptionTypeId?: string } | undefined
  >(undefined)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [webhooksOpen, setWebhooksOpen] = useState(false)
  // Team-wide run history (UX-48) — the per-rule entry lives in each card's menu.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [quickStarting, setQuickStarting] = useState(false)
  // How many starter-kit rules this plan may actually install (UX-86).
  const starterCount = starterBundleItemsForPlan(plan).length

  // Deep-link entry: ?editRule=<id> opens that rule; ?newTrigger=<type>&subType=<id>
  // opens a NEW rule prefilled (e.g. from the subscription editor). Params are cleared
  // after handling so closing the dialog doesn't reopen it.
  const router = useRouter()
  const searchParams = useSearchParams()
  useEffect(() => {
    const editRule = searchParams.get('editRule')
    const newTrigger = searchParams.get('newTrigger')
    const subType = searchParams.get('subType')
    if (editRule) {
      const r = rules.find((x) => x.id === editRule)
      if (!r) return // rules not loaded yet — re-run when they are
      setPrefill(undefined)
      setDuplicatingRule(null)
      setEditingRule(r)
      setRuleDialogOpen(true)
      router.replace('/automations' as Route)
    } else if (newTrigger) {
      setEditingRule(null)
      setDuplicatingRule(null)
      setPrefill({ triggerType: newTrigger, subscriptionTypeId: subType ?? undefined })
      setRuleDialogOpen(true)
      router.replace('/automations' as Route)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, rules])

  // The setup checklist's "set up an automation" step counts the same
  // subcollection, through its own cached query.
  const invalidateRules = () => {
    void invalidateSetupChecklist()
    return qc.invalidateQueries({ queryKey: ['automation_rules', currentTeamId] })
  }
  const invalidateTemplates = () =>
    qc.invalidateQueries({ queryKey: ['outreach_templates', currentTeamId] })
  const invalidateAll = () => {
    invalidateRules()
    invalidateTemplates()
    qc.invalidateQueries({ queryKey: ['outreach_templates_for_library', currentTeamId] })
  }

  async function handleQuickStart() {
    if (!currentTeamId) return
    setQuickStarting(true)
    try {
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, currentTeamId, OUTREACH_TEMPLATES_SUBCOLLECTION)
      )
      const allTmpl = snap.docs.map((d) => ({ ...d.data(), id: d.id }))
      const installedRuleKeys = new Set(rules.flatMap((r) => (r.system_key ? [r.system_key] : [])))
      await installStarterBundle(currentTeamId, allTmpl, installedRuleKeys, { plan })
      invalidateAll()
    } catch (err) {
      console.error('[QuickStart] failed:', err)
    } finally {
      setQuickStarting(false)
    }
  }

  async function handleToggle(rule: AutomationRule) {
    if (!currentTeamId) return
    await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId, AUTOMATION_RULES_SUBCOLLECTION, rule.id), {
      active: !rule.active,
    })
    invalidateRules()
  }

  async function handleDelete(rule: AutomationRule) {
    if (!currentTeamId) return
    const ok = await confirm({
      title: t('deleteConfirmTitle'),
      description: t('deleteConfirm', { name: rule.name }),
      confirmLabel: tCommon('delete'),
    })
    if (!ok) return
    await deleteDoc(doc(db, TEAMS_COLLECTION, currentTeamId, AUTOMATION_RULES_SUBCOLLECTION, rule.id))
    invalidateRules()
  }

  // Called by PreviewRunDialog's confirm, never straight off the menu: the run
  // is forced (it re-sends to people the dedup window would have skipped), so it
  // gets a dialog that says so and names the number first.
  async function handleRunNow(rule: AutomationRule) {
    if (!currentTeamId) return
    const fn = httpsCallable<
      { teamId: string; ruleId: string },
      { success: boolean; stats: { matched: number; executed: number; failed: number } }
    >(functions, 'triggerAutomationRule')
    try {
      const res = await fn({ teamId: currentTeamId as string, ruleId: rule.id })
      const stats = res.data?.stats
      toast.success(t('preview.sentToast', { count: stats?.executed ?? 0 }))
      if (stats?.failed) toast.error(t('preview.failedCount', { count: stats.failed }))
    } catch (err) {
      console.error('[Automations] run now failed:', err)
      toast.error(t('preview.runFailed'))
      invalidateRules()
      // Rethrown so the confirmation stays OPEN on failure — closing it would
      // leave the studio unsure whether anything went out.
      throw err
    }
    invalidateRules()
  }

  const activeRules = rules.filter((r) => r.active)
  const pausedRules = rules.filter((r) => !r.active)

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Workflow className="h-6 w-6" />
              {t('page.title')}
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              {t('page.subtitle')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
            {/* Templates moved out of Settings → Emails into their own section
                when that page was split; this button says "Manage templates",
                so it must follow them or it lands on a page without them. */}
            <Link
              href={'/settings/email-templates' as Route}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <Mail className="h-4 w-4 mr-1.5" />
              {t('page.templatesButton')}
            </Link>
            {canSeeHistory && (
              <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
                <History className="h-4 w-4 mr-1.5" />
                {t('history.pageButton')}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setLibraryOpen(true)}>
              <BookOpen className="h-4 w-4 mr-1.5" />
              {t('page.libraryButton')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setWebhooksOpen(true)}>
              <Webhook className="h-4 w-4 mr-1.5" />
              {t('page.webhooksButton')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditingRule(null)
                setRuleDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4 mr-1.5" />
              {t('common.newAutomation')}
            </Button>
          </div>
        </div>

        {/* Limited-plan note: Free/Coach get automations scoped to their active
            modules and add-ons; Studio unlocks the full suite. */}
        {!fullAutomations && (
          <div className="rounded-lg border border-primary/30 bg-primary/[0.04] px-4 py-3 text-sm">
            <p className="font-medium">{t('page.limitedPlanTitle')}</p>
            <p className="text-muted-foreground">
              {t('page.limitedPlanBody', { plan: planName('studio') })}
            </p>
          </div>
        )}


        {/* Loading */}
        {rulesLoading && (
          <div className="grid gap-6 sm:grid-cols-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!rulesLoading && rules.length === 0 && (
          <div className="flex flex-col items-center gap-5 py-16 text-center">
            <div className="rounded-full bg-muted p-4">
              <Workflow className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <p className="font-semibold">{t('page.emptyTitle')}</p>
              <p className="text-muted-foreground text-sm mt-1 max-w-xs">
                {starterCount > 0 ? t('page.emptyBody') : t('page.emptyBodyNoStarter')}
              </p>
            </div>
            <div className="flex gap-2 flex-wrap justify-center">
              {/* Offered only when it would install something. On a plan below
                  the starter kit's items the button used to promise eight rules
                  and quietly install none (UX-86). */}
              {starterCount > 0 && (
              <Button variant="outline" onClick={handleQuickStart} disabled={quickStarting}>
                <Sparkles className="h-4 w-4 mr-2" />
                {quickStarting ? t('page.installing') : t('page.quickStart', { count: starterCount })}
              </Button>
              )}
              <Button onClick={() => setLibraryOpen(true)}>
                <BookOpen className="h-4 w-4 mr-2" />
                {t('page.browseLibrary')}
              </Button>
            </div>
          </div>
        )}

        {/* Active rules */}
        {activeRules.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {t('common.active')}
            </h2>
            <div className="grid gap-6 sm:grid-cols-2">
              {activeRules.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  autoRun={rule.id === quickActionRunId}
                  teamId={currentTeamId ?? ''}
                  templates={templates}
                  alertPresets={alertPresets}
                  subscriptionTypes={subscriptionTypes}
                  onEdit={() => {
                    setDuplicatingRule(null)
                    setEditingRule(rule)
                    setRuleDialogOpen(true)
                  }}
                  onDuplicate={() => {
                    setEditingRule(null)
                    setDuplicatingRule(rule)
                    setRuleDialogOpen(true)
                  }}
                  onToggle={() => handleToggle(rule)}
                  onRunNow={() => handleRunNow(rule)}
                  onDelete={() => handleDelete(rule)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Paused rules */}
        {pausedRules.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {t('common.paused')}
            </h2>
            <div className="grid gap-6 sm:grid-cols-2">
              {pausedRules.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  autoRun={rule.id === quickActionRunId}
                  teamId={currentTeamId ?? ''}
                  templates={templates}
                  alertPresets={alertPresets}
                  subscriptionTypes={subscriptionTypes}
                  onEdit={() => {
                    setDuplicatingRule(null)
                    setEditingRule(rule)
                    setRuleDialogOpen(true)
                  }}
                  onDuplicate={() => {
                    setEditingRule(null)
                    setDuplicatingRule(rule)
                    setRuleDialogOpen(true)
                  }}
                  onToggle={() => handleToggle(rule)}
                  onRunNow={() => handleRunNow(rule)}
                  onDelete={() => handleDelete(rule)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Mobile FAB */}
        <FloatingSlot lane="page-primary" className="md:hidden">
          <button
            className="flex items-center justify-center w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
            onClick={() => {
              setEditingRule(null)
              setRuleDialogOpen(true)
            }}
          >
            <Plus className="h-6 w-6" />
          </button>
        </FloatingSlot>
      </div>

      {currentTeamId && (
        <>
          <RuleDialog
            key={editingRule?.id ?? (duplicatingRule ? `copy-${duplicatingRule.id}` : 'new')}
            open={ruleDialogOpen}
            onOpenChange={(v) => {
              setRuleDialogOpen(v)
              if (!v) {
                setPrefill(undefined)
                setDuplicatingRule(null)
              }
            }}
            teamId={currentTeamId}
            editing={editingRule}
            duplicating={duplicatingRule}
            templates={templates}
            webhookEndpoints={webhookEndpoints}
            onSaved={invalidateRules}
            triggerOptions={allTriggerOptions}
            actionTypeLabels={allActionTypeLabels}
            prefill={prefill}
          />
          <LibraryDialog
            open={libraryOpen}
            onOpenChange={setLibraryOpen}
            teamId={currentTeamId}
            rules={rules}
            onInstalled={invalidateAll}
          />
          <WebhookEndpointsDialog
            open={webhooksOpen}
            onOpenChange={setWebhooksOpen}
            teamId={currentTeamId}
          />
          {canSeeHistory && (
            <RunHistoryDialog
              open={historyOpen}
              onOpenChange={setHistoryOpen}
              teamId={currentTeamId}
            />
          )}
        </>
      )}
      {confirmDialog}
    </>
  )
}

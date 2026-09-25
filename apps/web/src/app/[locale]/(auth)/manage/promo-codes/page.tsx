'use client'

// Promo codes admin (Wave 3 Phase 3) — create, list, edit, disable, and the two
// manager corrections.
//
// TWO THINGS ON THIS PAGE ARE LOAD-BEARING RATHER THAN DECORATIVE:
//
// 1. RESERVED IS SHOWN SEPARATELY FROM USED. `usage_count` counts PAID
//    redemptions, while the cap is enforced against paid + in-checkout. A single
//    number would let a studio read "3 of 20" while the code refuses every
//    customer at 20 reserved — and this phase ships no notification, so this
//    page is the only signal there is. Both figures come from `promoUsesLeft`,
//    the same expression the reserve transaction uses, so the page cannot drift
//    from the gate.
//
// 2. THE TOTAL LIMIT IS REQUIRED. "No limit" stays expressible but must be
//    ticked deliberately, with its warning: the default path makes the studio
//    type a number, because an uncapped code that leaks is unbounded liability
//    with nothing behind it to raise the alarm.
//
// The plan gate is Studio and is mirrored server-side by
// requirePlan(teamId, 'studio') on createPromoCode ONLY — a downgraded team
// keeps its live codes redeemable, and simply cannot create new ones.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { toast } from 'sonner'
import { Lock, Percent, Plus, Tag, Ticket, Undo2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { usePlan } from '@/hooks/usePlan'
import { usePlanName } from '@/hooks/usePlanName'
import { useUpgradeModal } from '@/contexts/UpgradeModalContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { QuickLinks } from '@/components/layout/QuickLinks'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { formatCurrency } from '@/lib/format'
import {
  getPromoCodeLimits,
  isValidPromoCodeFormat,
  looksLikeGiftCardCode,
  normalizeRedemptionCode,
  promoUsesLeft,
  MIN_CHARGE_MAJOR,
  PROMO_MAX_SCOPE_IDS,
  type PromoAudience,
  type PromoCode,
  type PromoScopeKind,
} from '@linyup/shared'
import {
  useClearPromoRedemption,
  useCreatePromoCode,
  useReleasePromoReservations,
  useSetPromoCodeStatus,
  useTeamPromoCodes,
  useUpdatePromoCode,
  type PromoCodeInput,
} from '@/hooks/usePromoCodes'
import { useActivities } from '@/hooks/useActivities'
import { useCourses } from '@/plugins/online-courses/hooks'
import { useProducts } from '@/plugins/products/hooks'

const MIN_PLAN = 'studio' as const
/**
 * The scopes a studio may AIM A CODE AT, which is deliberately narrower than
 * `PromoScopeKind`.
 *
 * A scope belongs here only once a rail actually accepts a code for it. The
 * type and `PROMO_TARGETS` both carry `course_block` (a scheduled course), but
 * `createCourseBlockCheckout` has no `promoCode` parameter, so the resolver is
 * never given a promo context on that rail. Listing it would let a studio print
 * a code that silently discounts nothing, which is the worst kind of campaign
 * bug: it looks like it worked until somebody counts the redemptions.
 *
 * ADD IT HERE IN THE SAME CHANGE THAT WIRES THE RAIL, not before.
 * `promoCodeScopes.test.ts` fails if the two drift apart in either direction.
 */
const SCOPES: PromoScopeKind[] = ['drop_in', 'appointment', 'course', 'product']

interface Draft {
  code: string
  effect: 'percent_off' | 'fixed_price'
  percentText: string
  amountText: string
  from: string
  until: string
  unlimited: boolean
  maxUsesText: string
  perContactUnlimited: boolean
  perContactText: string
  restrictToContactId: string
  audience: PromoAudience
  appliesTo: PromoScopeKind[]
  /** The finer half of the scope. Empty ⇒ every item of the chosen kinds — the
   *  same meaning `promoAppliesTo` gives a null/absent allow-list, so the form
   *  and the resolver agree without a second rule. */
  activityIds: string[]
  courseIds: string[]
  productIds: string[]
  label: string
}

function emptyDraft(): Draft {
  return {
    code: '',
    effect: 'percent_off',
    percentText: '',
    amountText: '',
    from: '',
    until: '',
    // Deliberately FALSE: the default path makes the studio type a number.
    unlimited: false,
    maxUsesText: '',
    perContactUnlimited: false,
    perContactText: '1',
    restrictToContactId: '',
    audience: 'all',
    appliesTo: ['drop_in'],
    activityIds: [],
    courseIds: [],
    productIds: [],
    label: '',
  }
}

function toDateInput(ms: number | undefined | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function draftFrom(p: PromoCode): Draft {
  return {
    code: p.code,
    effect: p.effect,
    percentText: typeof p.percent === 'number' ? String(p.percent) : '',
    amountText: typeof p.amount === 'number' ? String(p.amount) : '',
    from: toDateInput(p.valid_from?.toMillis?.()),
    until: toDateInput(p.valid_until?.toMillis?.()),
    unlimited: p.max_uses === null,
    maxUsesText: p.max_uses === null ? '' : String(p.max_uses),
    perContactUnlimited: p.max_uses_per_contact === null,
    perContactText:
      p.max_uses_per_contact === null || p.max_uses_per_contact === undefined
        ? '1'
        : String(p.max_uses_per_contact),
    restrictToContactId: p.restrict_to_contact_id ?? '',
    audience: p.audience ?? 'all',
    appliesTo: p.applies_to ?? [],
    activityIds: p.activity_ids ?? [],
    courseIds: p.course_ids ?? [],
    productIds: p.product_ids ?? [],
    label: p.label ?? '',
  }
}

/** The end of a chosen day, so "valid until 30 September" includes the 30th.
 *  A window whose last day expires at midnight is the classic off-by-one that
 *  makes a flyer wrong by one day. */
function endOfDayMs(value: string): number | null {
  if (!value) return null
  const d = new Date(`${value}T23:59:59.999`)
  return Number.isFinite(d.getTime()) ? d.getTime() : null
}
function startOfDayMs(value: string): number | null {
  if (!value) return null
  const d = new Date(`${value}T00:00:00.000`)
  return Number.isFinite(d.getTime()) ? d.getTime() : null
}

export default function PromoCodesPage() {
  const t = useTranslations('PromoCodes')
  const { currentTeamId, team } = useAuth()
  const { isAtLeast } = usePlan()
  const planName = usePlanName()
  const { openUpgradeModal } = useUpgradeModal()
  const currency = team?.default_currency ?? 'CHF'

  const allowed = isAtLeast(MIN_PLAN)
  const { data: codes = [], isLoading } = useTeamPromoCodes(allowed ? currentTeamId : null)
  // The catalogs behind the entity allow-lists. Fetched only when the page is
  // unlocked; each is a list a manager already knows from its own admin page, so
  // the picker never invents a second name for anything.
  const { data: activities = [] } = useActivities(allowed ? currentTeamId : null)
  const { data: courses = [] } = useCourses(allowed ? currentTeamId : null)
  const { data: products = [] } = useProducts(allowed ? currentTeamId : null)
  const limits = getPromoCodeLimits(team?.plan ?? null)
  const activeCount = codes.filter((c) => c.status === 'active').length
  const atCap = activeCount >= limits.maxActiveCodes

  const createMutation = useCreatePromoCode()
  const updateMutation = useUpdatePromoCode()
  const statusMutation = useSetPromoCodeStatus()
  const releaseMutation = useReleasePromoReservations()
  const clearMutation = useClearPromoRedemption()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PromoCode | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [formError, setFormError] = useState<string | null>(null)
  const [disableTarget, setDisableTarget] = useState<PromoCode | null>(null)
  const [releaseTarget, setReleaseTarget] = useState<PromoCode | null>(null)
  const [clearTarget, setClearTarget] = useState<PromoCode | null>(null)
  const [clearEmail, setClearEmail] = useState('')

  // ONE instant for the whole render, so two rows can never disagree about which
  // reservations are still live.
  const nowMs = Date.now()

  // `activity_ids` narrows BOTH activity rails (promoAppliesTo reads it for
  // drop_in and appointment alike), which is why one picker serves two chips.
  const showActivities =
    draft.appliesTo.includes('drop_in') || draft.appliesTo.includes('appointment')
  const showCourses = draft.appliesTo.includes('course')
  const showProducts = draft.appliesTo.includes('product')

  function openCreate() {
    setEditing(null)
    setDraft(emptyDraft())
    setFormError(null)
    setDialogOpen(true)
  }

  function openEdit(p: PromoCode) {
    setEditing(p)
    setDraft(draftFrom(p))
    setFormError(null)
    setDialogOpen(true)
  }

  /**
   * PROMO-SPECIFIC VALIDATORS, not the benefit editor's.
   *
   * `benefitPercentInvalid` / `benefitAmountInvalid` both short-circuit to VALID
   * when `subscriptionTypeIds.length === 0`, and a promo form has no
   * subscription types — borrowing them would validate NOTHING, so `150` in the
   * percent field would pass the client and come back as a raw
   * `invalid-argument` with no key to render.
   */
  function buildInput(): (PromoCodeInput & { teamId: string }) | null {
    if (!currentTeamId) return null
    const code = normalizeRedemptionCode(draft.code)
    if (looksLikeGiftCardCode(code)) {
      setFormError(t('looksLikeGiftCard'))
      return null
    }
    if (!isValidPromoCodeFormat(code)) {
      setFormError(t('codeFormatInvalid'))
      return null
    }

    let percent: number | undefined
    let amount: number | undefined
    if (draft.effect === 'percent_off') {
      const n = Number(draft.percentText)
      if (!Number.isInteger(n) || n < 1 || n > 99) {
        setFormError(t('percentInvalid'))
        return null
      }
      percent = n
    } else {
      const n = Number(draft.amountText.replace(',', '.'))
      if (!Number.isFinite(n) || n < MIN_CHARGE_MAJOR) {
        setFormError(t('amountInvalid'))
        return null
      }
      amount = Math.round(n * 100) / 100
    }

    const validFromMs = startOfDayMs(draft.from)
    const validUntilMs = endOfDayMs(draft.until)
    if (validFromMs != null && validUntilMs != null && validUntilMs <= validFromMs) {
      setFormError(t('windowInvalid'))
      return null
    }

    let maxUses: number | null = null
    if (!draft.unlimited) {
      const n = Number(draft.maxUsesText)
      if (!Number.isInteger(n) || n < 1) {
        setFormError(t('maxUsesRequired'))
        return null
      }
      maxUses = n
    }

    let maxUsesPerContact: number | null = null
    if (!draft.perContactUnlimited) {
      const n = Number(draft.perContactText)
      if (!Number.isInteger(n) || n < 1) {
        setFormError(t('perContactInvalid'))
        return null
      }
      maxUsesPerContact = n
    }

    if (draft.appliesTo.length === 0) {
      setFormError(t('scopeRequired'))
      return null
    }

    // The server TRUNCATES an over-long allow-list silently (resolveScope's
    // slice), so refusing here is the difference between "we saved what you
    // ticked" and "we saved some of it".
    if (
      draft.activityIds.length > PROMO_MAX_SCOPE_IDS ||
      draft.courseIds.length > PROMO_MAX_SCOPE_IDS ||
      draft.productIds.length > PROMO_MAX_SCOPE_IDS
    ) {
      setFormError(t('entitiesTooMany', { max: PROMO_MAX_SCOPE_IDS }))
      return null
    }

    setFormError(null)
    return {
      teamId: currentTeamId,
      code,
      effect: draft.effect,
      ...(percent !== undefined ? { percent } : {}),
      ...(amount !== undefined ? { amount } : {}),
      validFromMs,
      validUntilMs,
      // Always PRESENT — `null` is an explicit "no limit", never an omission.
      maxUses,
      maxUsesPerContact,
      restrictToContactId: draft.restrictToContactId.trim() || null,
      audience: draft.audience,
      appliesTo: draft.appliesTo,
      // Sent WHATEVER the scope checkboxes now say, including lists whose kind is
      // currently unticked. Those ids are inert (promoAppliesTo checks the kind
      // first) and keeping them means un-ticking "Courses" to look at something
      // else does not silently destroy a narrowing the manager built — the same
      // carry-the-stored-value-through rule the plan gate follows.
      activityIds: draft.activityIds,
      courseIds: draft.courseIds,
      productIds: draft.productIds,
      label: draft.label.trim() || null,
    }
  }

  async function submit() {
    const input = buildInput()
    if (!input) return
    try {
      if (editing) await updateMutation.mutateAsync(input)
      else await createMutation.mutateAsync(input)
      setDialogOpen(false)
      toast.success(t('saved'))
    } catch (err) {
      const reason = (err as { details?: { reason?: string } })?.details?.reason
      const map: Record<string, string> = {
        code_taken: t('codeTaken'),
        code_format_invalid: t('codeFormatInvalid'),
        looks_like_gift_card: t('looksLikeGiftCard'),
        percent_invalid: t('percentInvalid'),
        below_minimum: t('amountInvalid'),
        not_priced: t('amountInvalid'),
        window_invalid: t('windowInvalid'),
        max_uses_required: t('maxUsesRequired'),
        per_contact_invalid: t('perContactInvalid'),
        scope_required: t('scopeRequired'),
        contact_invalid: t('contactInvalid'),
        cap_reached: t('capReached'),
        plan_required: t('requiresPlan', { plan: planName(MIN_PLAN) }),
        plan_inactive: t('requiresPlan', { plan: planName(MIN_PLAN) }),
      }
      setFormError((reason && map[reason]) || t('errorSave'))
    }
  }

  // ── Locked state: visible, not hidden. Hiding the lever teaches nobody the
  // feature exists, which is why the nav item uses minPlan rather than
  // requiresPlan too. ──
  if (!allowed) {
    return (
      <div className="max-w-4xl space-y-6">
        <Header t={t} />
        <div className="rounded-lg border border-dashed py-16 text-center">
          <Lock className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {t('requiresPlan', { plan: planName(MIN_PLAN) })}
          </p>
          <Button className="mt-4" size="sm" onClick={() => openUpgradeModal({ minPlan: MIN_PLAN })}>
            {planName(MIN_PLAN)}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Header t={t} showQuickLinks />
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" onClick={openCreate} disabled={atCap}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('create')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('quota', { count: activeCount, max: limits.maxActiveCodes })}
          </span>
          {atCap && <span className="text-xs text-amber-600">{t('capReached')}</span>}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : codes.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <Ticket className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {codes.map((p) => (
            <PromoRow
              key={p.code}
              promo={p}
              nowMs={nowMs}
              currency={currency}
              t={t}
              onEdit={() => openEdit(p)}
              onDisable={() => setDisableTarget(p)}
              onEnable={() =>
                statusMutation
                  .mutateAsync({ teamId: currentTeamId!, code: p.code, status: 'active' })
                  .then(() => toast.success(t('saved')))
                  .catch(() => toast.error(t('errorSave')))
              }
              onRelease={() => setReleaseTarget(p)}
              onClear={() => {
                setClearTarget(p)
                setClearEmail('')
              }}
            />
          ))}
          <p className="text-xs text-muted-foreground">{t('noDelete')}</p>
        </div>
      )}

      {/* ── Create / edit ─────────────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? t('edit') : t('create')}</DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="promo-code">{t('codeLabel')}</Label>
              <Input
                id="promo-code"
                value={draft.code}
                // The code IS the document id, so it cannot change on an edit
                // without orphaning every reservation and redemption under it.
                disabled={!!editing}
                onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
                placeholder="SUMMER26"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">{t('codeHint')}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="promo-effect">{t('effectLabel')}</Label>
                <Select
                  value={draft.effect}
                  onValueChange={(v) =>
                    setDraft({ ...draft, effect: v as Draft['effect'] })
                  }
                >
                  <SelectTrigger id="promo-effect" className="h-9 w-full">
                    <span className="flex flex-1 text-left text-sm truncate">
                      {draft.effect === 'percent_off'
                        ? t('effectPercent')
                        : t('effectFixed')}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percent_off">{t('effectPercent')}</SelectItem>
                    <SelectItem value="fixed_price">{t('effectFixed')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {draft.effect === 'percent_off' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="promo-percent">{t('percentLabel')}</Label>
                  <Input
                    id="promo-percent"
                    inputMode="numeric"
                    value={draft.percentText}
                    onChange={(e) => setDraft({ ...draft, percentText: e.target.value })}
                    placeholder="25"
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="promo-amount">{t('amountLabel')}</Label>
                  <Input
                    id="promo-amount"
                    inputMode="decimal"
                    value={draft.amountText}
                    onChange={(e) => setDraft({ ...draft, amountText: e.target.value })}
                    placeholder="19.00"
                  />
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="promo-from">{t('windowFrom')}</Label>
                <Input
                  id="promo-from"
                  type="date"
                  value={draft.from}
                  onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="promo-until">{t('windowUntil')}</Label>
                <Input
                  id="promo-until"
                  type="date"
                  value={draft.until}
                  onChange={(e) => setDraft({ ...draft, until: e.target.value })}
                />
              </div>
            </div>

            {/* Total cap — REQUIRED. "No limit" is a deliberate tick, never the
                path of least resistance. */}
            <div className="space-y-1.5">
              <Label htmlFor="promo-max">{t('maxUsesLabel')}</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="promo-max"
                  inputMode="numeric"
                  value={draft.maxUsesText}
                  disabled={draft.unlimited}
                  onChange={(e) => setDraft({ ...draft, maxUsesText: e.target.value })}
                  placeholder="50"
                  className="max-w-[8rem]"
                />
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={draft.unlimited}
                    onCheckedChange={(v) => setDraft({ ...draft, unlimited: v })}
                  />
                  {t('maxUsesUnlimited')}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">{t('maxUsesHint')}</p>
              {draft.unlimited && (
                <p className="text-xs text-amber-600">{t('maxUsesUnlimitedWarning')}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="promo-per-contact">{t('perContactLabel')}</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="promo-per-contact"
                  inputMode="numeric"
                  value={draft.perContactText}
                  disabled={draft.perContactUnlimited}
                  onChange={(e) => setDraft({ ...draft, perContactText: e.target.value })}
                  className="max-w-[8rem]"
                />
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={draft.perContactUnlimited}
                    onCheckedChange={(v) => setDraft({ ...draft, perContactUnlimited: v })}
                  />
                  {t('maxUsesUnlimited')}
                </label>
              </div>
              {/* Honest, not overclaiming: a second mailbox defeats it, and the
                  copy says what it actually binds to rather than promising
                  "once per person". */}
              <p className="text-xs text-muted-foreground">{t('perContactHint')}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="promo-audience">{t('audienceLabel')}</Label>
              <Select
                value={draft.audience}
                onValueChange={(v) =>
                  setDraft({ ...draft, audience: v as PromoAudience })
                }
              >
                <SelectTrigger id="promo-audience" className="h-9 w-full">
                  <span className="flex flex-1 text-left text-sm truncate">
                    {draft.audience === 'all'
                      ? t('audienceAll')
                      : t('audienceNewContacts')}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('audienceAll')}</SelectItem>
                  <SelectItem value="new_contacts">{t('audienceNewContacts')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('audienceHint')}</p>
            </div>

            <div className="space-y-1.5">
              <Label>{t('scopeLabel')}</Label>
              <div className="flex flex-wrap gap-2">
                {SCOPES.map((kind) => {
                  const on = draft.appliesTo.includes(kind)
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          appliesTo: on
                            ? draft.appliesTo.filter((k) => k !== kind)
                            : [...draft.appliesTo, kind],
                        })
                      }
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                        on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground'
                      }`}
                    >
                      {t(scopeKey(kind))}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* ── The finer half of the scope: WHICH items ──────────────────
                `applies_to` says which RAILS; these say which entities on them.
                Both halves exist in the document and both are honored by
                `promoAppliesTo`, so a code that applies to exactly one course is
                expressible — it simply had no control until now.

                Each list is shown only while its rail is selected, and an empty
                list means "everything of that kind" (the same meaning a null
                allow-list has on disk — one meaning, one representation). */}
            {(showActivities || showCourses || showProducts) && (
              <div className="space-y-2">
                <Label>{t('entitiesLabel')}</Label>
                <p className="text-xs text-muted-foreground">{t('entitiesHint')}</p>
                {showActivities && (
                  <EntityPicker
                    title={t('entityActivities')}
                    emptyLabel={t('entitiesEmpty')}
                    items={activities.map((a) => ({ id: a.id, name: a.name }))}
                    selected={draft.activityIds}
                    onChange={(activityIds) => setDraft({ ...draft, activityIds })}
                  />
                )}
                {showCourses && (
                  <EntityPicker
                    title={t('entityCourses')}
                    emptyLabel={t('entitiesEmpty')}
                    items={courses.map((c) => ({ id: c.id, name: c.title }))}
                    selected={draft.courseIds}
                    onChange={(courseIds) => setDraft({ ...draft, courseIds })}
                  />
                )}
                {showProducts && (
                  <EntityPicker
                    title={t('entityProducts')}
                    emptyLabel={t('entitiesEmpty')}
                    items={products.map((p) => ({ id: p.id, name: p.name }))}
                    selected={draft.productIds}
                    onChange={(productIds) => setDraft({ ...draft, productIds })}
                  />
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="promo-restrict">{t('restrictToContactLabel')}</Label>
              <Input
                id="promo-restrict"
                value={draft.restrictToContactId}
                onChange={(e) => setDraft({ ...draft, restrictToContactId: e.target.value })}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">{t('restrictToContactHint')}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="promo-label">{t('labelLabel')}</Label>
              <Input
                id="promo-label"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('labelHint')}</p>
            </div>

            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={submit}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Disable ──────────────────────────────────────────────────────── */}
      <AlertDialog open={!!disableTarget} onOpenChange={(o) => !o && setDisableTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{disableTarget?.code}</AlertDialogTitle>
            <AlertDialogDescription>{t('disableConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                statusMutation
                  .mutateAsync({
                    teamId: currentTeamId!,
                    code: disableTarget!.code,
                    status: 'disabled',
                  })
                  .then(() => toast.success(t('saved')))
                  .catch(() => toast.error(t('errorSave')))
                  .finally(() => setDisableTarget(null))
              }
            >
              {t('disable')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Free up reservations ─────────────────────────────────────────── */}
      <AlertDialog open={!!releaseTarget} onOpenChange={(o) => !o && setReleaseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{releaseTarget?.code}</AlertDialogTitle>
            <AlertDialogDescription>{t('releaseReservationsConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                releaseMutation
                  .mutateAsync({ teamId: currentTeamId!, code: releaseTarget!.code })
                  .then((r) => toast.success(t('releasedToast', { count: r.released })))
                  .catch(() => toast.error(t('errorSave')))
                  .finally(() => setReleaseTarget(null))
              }
            >
              {t('releaseReservations')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Let someone use it again ─────────────────────────────────────── */}
      <Dialog open={!!clearTarget} onOpenChange={(o) => !o && setClearTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('clearRedemption')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('clearRedemptionConfirm')}</p>
          <div className="space-y-1.5">
            <Label htmlFor="promo-clear-email">{t('clearRedemptionEmailLabel')}</Label>
            <Input
              id="promo-clear-email"
              type="email"
              value={clearEmail}
              onChange={(e) => setClearEmail(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClearTarget(null)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={!clearEmail.trim() || clearMutation.isPending}
              onClick={() =>
                clearMutation
                  .mutateAsync({
                    teamId: currentTeamId!,
                    code: clearTarget!.code,
                    email: clearEmail.trim(),
                  })
                  .then(() => toast.success(t('clearedToast')))
                  .catch(() => toast.error(t('errorSave')))
                  .finally(() => setClearTarget(null))
              }
            >
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * ONE checkbox list for an entity allow-list, in the shape `BenefitEditor`'s
 * subscription-type list already uses (bordered box, plain checkboxes, an empty
 * state) rather than a new select widget: a manager who has linked a benefit to
 * subscription types has met this control before.
 *
 * NOTHING TICKED MEANS EVERYTHING, which is why there is no "all" option to
 * choose — an explicit "all" would be a second way to say what an empty list
 * already says, and the two would drift.
 */
function EntityPicker({
  title,
  emptyLabel,
  items,
  selected,
  onChange,
}: {
  title: string
  emptyLabel: string
  items: Array<{ id: string; name?: string | null }>
  selected: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <div className="space-y-1.5 rounded-md border p-3">
      <p className="text-xs font-medium">{title}</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="max-h-40 space-y-1.5 overflow-y-auto">
          {items.map((item) => (
            <label key={item.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary"
                checked={selected.includes(item.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, item.id]
                      : selected.filter((id) => id !== item.id)
                  )
                }
              />
              {item.name || item.id}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function scopeKey(
  kind: PromoScopeKind
): 'scopeDropIn' | 'scopeAppointment' | 'scopeCourse' | 'scopeCourseBlock' | 'scopeProduct' {
  switch (kind) {
    case 'drop_in':
      return 'scopeDropIn'
    case 'appointment':
      return 'scopeAppointment'
    case 'course':
      return 'scopeCourse'
    // A scheduled COURSE, and its own label: the studio has to be able to aim a
    // campaign at a term of lessons without also discounting the video plugin.
    case 'course_block':
      return 'scopeCourseBlock'
    case 'product':
      return 'scopeProduct'
  }
}

function Header({
  t,
  showQuickLinks,
}: {
  t: ReturnType<typeof useTranslations>
  showQuickLinks?: boolean
}) {
  const tNav = useTranslations('Nav')
  return (
    <div className="flex items-start gap-2">
      <Ticket className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
      <div>
        <div className="flex items-center gap-1.5">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          {showQuickLinks && (
            <QuickLinks links={[{ href: '/manage/pricing' as Route, label: tNav('pricing') }]} />
          )}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('subtitle')}</p>
        {/* Quick link (UX-71): a code created here changes nothing visible on
            this page beyond its own row. Pricing's Discounts section is the one
            admin surface that shows the live, in-window codes next to the prices
            they cut — i.e. the page that confirms the code is actually running.
            Not shown in the locked branch below: there are no codes to check. */}
      </div>
    </div>
  )
}

function PromoRow({
  promo,
  nowMs,
  currency,
  t,
  onEdit,
  onDisable,
  onEnable,
  onRelease,
  onClear,
}: {
  promo: PromoCode
  nowMs: number
  currency: string
  t: ReturnType<typeof useTranslations>
  onEdit: () => void
  onDisable: () => void
  onEnable: () => void
  onRelease: () => void
  onClear: () => void
}) {
  // THE SAME EXPRESSION THE RESERVE TRANSACTION USES. The identity arguments are
  // inert here (this row asks about the code, not about a person), but reading
  // `liveTotal` through the shared helper is what stops the page and the gate
  // from ever disagreeing about which reservations are still live.
  const { liveTotal } = promoUsesLeft(promo, nowMs, '', 0)
  const used = promo.usage_count ?? 0
  const active = promo.status === 'active'
  // Counted across all three lists: they narrow different rails, and the row
  // only needs to say THAT the code is narrowed, not which axis narrowed it.
  const narrowedCount =
    (promo.activity_ids?.length ?? 0) +
    (promo.course_ids?.length ?? 0) +
    (promo.product_ids?.length ?? 0)

  const discount =
    promo.effect === 'percent_off'
      ? t('percentOff', { percent: promo.percent ?? 0 })
      : t('fixedPriceAt', { price: formatCurrency(promo.amount ?? 0, currency) })

  const from = promo.valid_from?.toDate?.()
  const until = promo.valid_until?.toDate?.()
  const window =
    !from && !until
      ? t('windowAlways')
      : `${from ? from.toLocaleDateString() : '…'} – ${until ? until.toLocaleDateString() : '…'}`

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{promo.code}</span>
            <Badge variant={active ? 'default' : 'secondary'}>
              {active ? t('statusActive') : t('statusDisabled')}
            </Badge>
            {promo.audience === 'new_contacts' && (
              <Badge variant="outline">{t('audienceNewContacts')}</Badge>
            )}
            {promo.restrict_to_contact_id && (
              <Badge variant="outline">{t('restrictToContactLabel')}</Badge>
            )}
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-sm">
            <Percent className="h-3.5 w-3.5 text-muted-foreground" />
            {discount}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{window}</p>
          {promo.label && <p className="mt-0.5 text-xs text-muted-foreground">{promo.label}</p>}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(promo.applies_to ?? []).map((k) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                <Tag className="h-3 w-3" />
                {t(scopeKey(k))}
              </span>
            ))}
          </div>
          {/* A narrowed code and a rail-wide one look identical from the chips
              alone, and "why does my code not work on that class" is the support
              question that follows. */}
          {narrowedCount > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('entityNarrowed', { count: narrowedCount })}
            </p>
          )}
        </div>

        {/* USED and RESERVED, side by side and never merged: a code showing
            "3 of 20" while refusing every customer at 20 reserved is the exact
            report this page exists to make impossible. */}
        <div className="text-right">
          <p className="text-sm font-medium">
            {promo.max_uses === null
              ? t('usedUnlimited', { used })
              : t('usedOf', { used, max: promo.max_uses })}
          </p>
          {liveTotal > 0 && (
            <>
              <p className="text-sm text-amber-600">{t('reserved', { count: liveTotal })}</p>
              <p className="max-w-[16rem] text-xs text-muted-foreground">{t('reservedHint')}</p>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          {t('edit')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onRelease} disabled={liveTotal === 0}>
          <Undo2 className="mr-1.5 h-3.5 w-3.5" />
          {t('releaseReservations')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t('clearRedemption')}
        </Button>
        <Button variant="ghost" size="sm" onClick={active ? onDisable : onEnable}>
          {active ? t('disable') : t('enable')}
        </Button>
      </div>
    </div>
  )
}

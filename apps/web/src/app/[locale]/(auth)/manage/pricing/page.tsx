'use client'

// Unified Pricing admin page — read-only. Three sections, one shared resolver
// (@/lib/pricingSurface, itself a thin wrapper over @linyup/shared's
// resolvePaymentOptions) so nothing here can ever disagree with what a real
// booking/checkout would charge:
//   1. Health — cross-entity pricing inconsistencies, each with a fix link.
//      FIRST, because it is the only section that says something is WRONG; the
//      others describe what is. Problems reported last are read last.
//   2. Price preview — pick a persona (guest / member / a subscription type)
//      and see exactly what every class, appointment, course and product
//      would cost them right now.
//   3. What you sell — one card per subscription type: its prices + what it
//      unlocks (reverse lookup over activities/courses).
//   4. Discounts — a modifier of the prices above it, so it reads after them.
// No editing here — every fix link routes to the surface that owns the data.

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Link } from '@/i18n/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { setDoc } from 'firebase/firestore'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { useActivities } from '@/hooks/useActivities'
import { bookingSettingsRef, useBookingSettings } from '@/hooks/useBookingSettings'
import { useSubscriptionTypes } from '@/hooks/useSubscriptionTypes'
import { useProducts } from '@/plugins/products/hooks'
import { useCourses } from '@/plugins/online-courses/hooks'
import { PageHeader } from '@/components/layout/PageHeader'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useTeamPromoCodes } from '@/hooks/usePromoCodes'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { CheckCircle2, AlertTriangle, AlertCircle, BadgePercent, Info } from 'lucide-react'
import { formatCurrency } from '@/lib/format'
import type {
  Activity,
  Course,
  DropInPrice,
  Product,
  PromoCode,
  SubscriptionPrice,
  SubscriptionType,
} from '@linyup/shared'
import { dropInModeOf, isSellableCourse, promoWindowOpen, resolveUsageLimit, studioDropInOf } from '@linyup/shared'
import {
  buildPersonas,
  personaSnapshot,
  resolveClassCell,
  resolveAppointmentCells,
  resolveCourseCell,
  productPriceRange,
  grantsForType,
  computePricingHealth,
  classDoors,
  type ClassDoors,
  type PricingPersona,
  type PriceCell,
  type PricingWarning,
  type PricingWarningCode,
} from '@/lib/pricingSurface'

// ─── small shared helpers ──────────────────────────────────────────────────────

function truncatedList(names: string[], max: number, moreLabel: (count: number) => string): string {
  if (names.length <= max) return names.join(', ')
  const shown = names.slice(0, max)
  return `${shown.join(', ')} ${moreLabel(names.length - max)}`
}

// ─── who is asking ─────────────────────────────────────────────────────────────
//
// A SELECT, not the chip row this replaces. The list is guest + member + one per
// ACTIVE subscription type, so it grows with the studio's plans — a seeded swim
// school already reaches eight. Past a handful the chips wrapped or scrolled
// sideways, which buries the later plans and makes the current choice hard to
// find among equals.
//
// A select trades the at-a-glance overview for a stable, one-line control that
// does not reflow as plans are added, and it names the current persona in the
// trigger rather than relying on which pill is tinted. The overview was worth
// less than it looks here: these are alternatives to step through one at a time,
// not a set to compare side by side — the comparison is the TABLE below.

function PersonaPicker({
  personas,
  selectedId,
  onSelect,
  t,
}: {
  personas: PricingPersona[]
  selectedId: string
  onSelect: (id: string) => void
  t: ReturnType<typeof useTranslations<'OfferPricing'>>
}) {
  const labelFor = (p: PricingPersona) =>
    p.kind === 'guest' ? t('personaGuest') : p.kind === 'member' ? t('personaMember') : p.label
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* The chips carried no label — the tinted pill WAS the answer. A select
          needs one, or the trigger reads as a filter over the table. */}
      <span className="text-sm text-muted-foreground">{t('personaPickerLabel')}</span>
      <Select value={selectedId} onValueChange={(v) => v && onSelect(v)}>
        <SelectTrigger className="h-9 w-full sm:w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {personas.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {labelFor(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// ─── price cell rendering ───────────────────────────────────────────────────────

const FREE_BADGE_CLASS =
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
const CREDIT_BADGE_CLASS =
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'

function PriceCellView({
  cell,
  currency,
  typeNameById,
  t,
}: {
  cell: PriceCell
  currency: string
  typeNameById: Map<string, string>
  t: ReturnType<typeof useTranslations<'OfferPricing'>>
}) {
  if (cell.kind === 'free') {
    let label: string
    switch (cell.reason) {
      case 'open':
        label = t('freeOpen')
        break
      case 'members':
        label = t('freeMembers')
        break
      case 'registered':
        label = t('freeRegistered')
        break
      case 'included':
      case 'subscription':
        label = t('freeIncluded', { name: (cell.viaTypeId && typeNameById.get(cell.viaTypeId)) || '' })
        break
      default:
        label = t('freeUnpriced')
    }
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge className={`${FREE_BADGE_CLASS} border-transparent`}>{label}</Badge>
        {typeof cell.remaining === 'number' && (
          <span className="text-xs text-muted-foreground">
            {t('remainingThisPeriod', { count: cell.remaining })}
          </span>
        )}
      </span>
    )
  }

  if (cell.kind === 'credit') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge className={`${CREDIT_BADGE_CLASS} border-transparent`}>{t('creditBadge')}</Badge>
        <span className="text-xs text-muted-foreground">
          {t('creditRemaining', { count: cell.remaining })}
        </span>
      </span>
    )
  }

  if (cell.kind === 'pay') {
    return (
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        {typeof cell.baseAmount === 'number' && (
          <span className="text-xs text-muted-foreground line-through">
            {formatCurrency(cell.baseAmount, currency)}
          </span>
        )}
        <span className="text-sm font-medium">{formatCurrency(cell.amount, currency)}</span>
        {typeof cell.baseAmount === 'number' && (
          <span className="text-xs text-muted-foreground">{t('memberRateHint')}</span>
        )}
        {cell.source === 'drop_in' && (
          <span className="text-xs text-muted-foreground">{t('dropInHint')}</span>
        )}
      </span>
    )
  }

  // blocked
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className="text-sm text-muted-foreground">
        {cell.denial === 'limit_reached' ? t('limitReached') : t('noAccess')}
      </span>
      {cell.trial && (
        <span className="text-xs text-muted-foreground italic">
          {trialDoorLabel(cell.trial, currency, t)}
        </span>
      )}
    </span>
  )
}

function trialDoorLabel(
  trial: NonNullable<ClassDoors['trial']>,
  currency: string,
  t: ReturnType<typeof useTranslations<'OfferPricing'>>
): string {
  return trial.priceAmount === null
    ? t('doorTrialFree')
    : t('doorTrialPriced', { amount: formatCurrency(trial.priceAmount, currency) })
}

/**
 * What the class offers a newcomer, under its name and whoever is asking. The
 * persona cell answers "what would THIS person pay"; this line keeps the
 * drop-in price and the trial in view when that answer is "nothing" or "no
 * access", so the preview never reads as if the class had no way in.
 */
function ClassDoorsLine({
  doors,
  currency,
  t,
}: {
  doors: ClassDoors
  currency: string
  t: ReturnType<typeof useTranslations<'OfferPricing'>>
}) {
  const parts: string[] = []
  if (doors.dropInAmount !== null) {
    parts.push(t('doorDropIn', { amount: formatCurrency(doors.dropInAmount, currency) }))
  }
  if (doors.trial) parts.push(trialDoorLabel(doors.trial, currency, t))
  if (parts.length === 0) return null
  return <p className="text-xs text-muted-foreground">{parts.join(' · ')}</p>
}

// ─── The studio's default drop-in ─────────────────────────────────────────────

/**
 * ONE price for the door, set once. A studio whose classes all cost the same
 * at the door used to type it into every class and keep the copies in step by
 * hand; now every class follows this unless it names its own price or
 * switches drop-in off (`DropInMode`, @linyup/shared). It is stored with the
 * booking settings — the one document the callables, the public pages and the
 * mobile app already read — and edited HERE because it is a price, not a
 * booking rule; the write merges the one field and leaves the rest of that
 * object to Settings → Booking.
 */
function DropInDefaultCard({
  teamId,
  classes,
  stored,
  currency,
}: {
  teamId: string | null
  classes: Activity[]
  stored: DropInPrice | null
  currency: string
}) {
  const t = useTranslations('OfferPricing')
  const qc = useQueryClient()
  const storedPrice = stored?.priceAmount ?? null
  const [enabled, setEnabled] = useState(storedPrice !== null)
  const [price, setPrice] = useState(storedPrice !== null ? String(storedPrice) : '')
  const [saving, setSaving] = useState(false)
  // Re-seed when the store changes under us — a refetch, or a save elsewhere.
  useEffect(() => {
    setEnabled(storedPrice !== null)
    setPrice(storedPrice !== null ? String(storedPrice) : '')
  }, [storedPrice])

  const parsed = parseFloat(price.replace(',', '.'))
  const invalid = enabled && !(price.trim() !== '' && parsed >= 0.5)
  const dirty = enabled !== (storedPrice !== null) || (enabled && parsed !== storedPrice)
  // How the classes relate to this price — read off each document's own
  // answer, not the resolved price, so "follow the default" counts even while
  // the default is off.
  const counts = classes.reduce(
    (acc, a) => {
      acc[dropInModeOf(a.dropIn)] += 1
      return acc
    },
    { studio: 0, custom: 0, off: 0 }
  )

  async function save() {
    if (!teamId || invalid || !dirty) return
    setSaving(true)
    try {
      // The ONE field, replaced whole — `mergeFields` so an old price cannot
      // survive under a switched-off default the way a deep merge would keep it.
      await setDoc(
        bookingSettingsRef(teamId),
        { bookingSettings: { dropIn: enabled ? { enabled: true, priceAmount: parsed } : { enabled: false } } },
        { mergeFields: ['bookingSettings.dropIn'] }
      )
      await qc.invalidateQueries({ queryKey: ['booking-settings', teamId] })
      toast.success(t('dropInDefaultSaved'))
    } catch (err) {
      console.error('[drop-in default save] failed:', err)
      toast.error(err instanceof Error ? err.message : t('dropInDefaultSaved'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dropInDefaultTitle')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('dropInDefaultSubtitle')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
          <label className="flex cursor-pointer items-center gap-3">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <span className="text-sm font-medium">{t('dropInDefaultToggle')}</span>
          </label>
          {enabled && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{currency}</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="h-8 w-28 text-sm"
                aria-label={t('dropInDefaultToggle')}
              />
            </div>
          )}
        </div>
        {invalid && <p className="text-xs text-destructive">{t('dropInDefaultValidation')}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{t('dropInDefaultSummary', counts)}</p>
          <Button size="sm" disabled={!dirty || invalid || saving} onClick={() => void save()}>
            {t('dropInDefaultSave')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Price preview section ──────────────────────────────────────────────────────

function PricingPreviewSection({
  classes,
  appointments,
  courses,
  products,
  personas,
  subscriptionTypes,
  currency,
  studioDropIn,
}: {
  classes: Activity[]
  appointments: Activity[]
  courses: Course[]
  products: Product[]
  personas: PricingPersona[]
  subscriptionTypes: SubscriptionType[]
  currency: string
  studioDropIn: DropInPrice | null
}) {
  const t = useTranslations('OfferPricing')
  const [selectedId, setSelectedId] = useState(personas[0]?.id ?? 'guest')
  const [packEmpty, setPackEmpty] = useState(false)
  const [allowanceUsedUp, setAllowanceUsedUp] = useState(false)

  const selected = personas.find((p) => p.id === selectedId) ?? personas[0]
  const snapshot = useMemo(
    () => personaSnapshot(selected, packEmpty, allowanceUsedUp),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected?.id, packEmpty, allowanceUsedUp]
  )

  const typeNameById = useMemo(() => {
    const m = new Map<string, string>()
    subscriptionTypes.forEach((st) => m.set(st.id, st.name))
    return m
  }, [subscriptionTypes])

  const handleSelect = (id: string) => {
    setSelectedId(id)
    setPackEmpty(false)
    setAllowanceUsedUp(false)
  }

  const nothingToPrice =
    classes.length === 0 && appointments.length === 0 && courses.length === 0 && products.length === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sectionPreviewTitle')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('sectionPreviewSubtitle')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <PersonaPicker personas={personas} selectedId={selected?.id ?? 'guest'} onSelect={handleSelect} t={t} />

        {selected?.creditOnly && (
          <div className="flex items-center justify-between rounded-lg border border-dashed p-2.5">
            <span className="text-sm text-muted-foreground">{t('packEmptyLabel')}</span>
            <Switch checked={packEmpty} onCheckedChange={setPackEmpty} />
          </div>
        )}

        {selected?.limit && (
          <div className="flex items-center justify-between rounded-lg border border-dashed p-2.5">
            <span className="text-sm text-muted-foreground">{t('allowanceUsedUpLabel')}</span>
            <Switch checked={allowanceUsedUp} onCheckedChange={setAllowanceUsedUp} />
          </div>
        )}

        {nothingToPrice ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{t('emptyPreview')}</p>
        ) : (
          <div className="space-y-5">
            {classes.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('groupClasses')}
                </p>
                <div className="divide-y rounded-lg border">
                  {classes.map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <Link href={'/offer/activities' as Route} className="text-sm font-medium hover:underline">
                          {a.name}
                        </Link>
                        <ClassDoorsLine doors={classDoors(a, studioDropIn)} currency={currency} t={t} />
                      </div>
                      <PriceCellView
                        cell={resolveClassCell(snapshot, a, studioDropIn)}
                        currency={currency}
                        typeNameById={typeNameById}
                        t={t}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {appointments.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('groupAppointments')}
                </p>
                <div className="divide-y rounded-lg border">
                  {appointments.map((a) => (
                    <div key={a.id} className="px-3 py-2.5 space-y-1.5">
                      <Link href={'/offer/activities' as Route} className="text-sm font-medium hover:underline">
                        {a.name}
                      </Link>
                      <div className="space-y-1 pl-1">
                        {resolveAppointmentCells(snapshot, a).map((row) => (
                          <div key={row.minutes} className="flex items-center justify-between gap-3">
                            <span className="text-xs text-muted-foreground">
                              {t('durationMinutes', { minutes: row.minutes })}
                            </span>
                            <PriceCellView
                              cell={row.cell}
                              currency={currency}
                              typeNameById={typeNameById}
                              t={t}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {courses.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('groupCourses')}
                </p>
                <div className="divide-y rounded-lg border">
                  {courses.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <Link
                          href={`/manage/online-courses/${c.id}` as Route}
                          className="text-sm font-medium hover:underline truncate"
                        >
                          {c.title}
                        </Link>
                        {c.status === 'draft' && (
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {t('draftBadge')}
                          </Badge>
                        )}
                      </span>
                      <PriceCellView
                        cell={resolveCourseCell(snapshot, c)}
                        currency={currency}
                        typeNameById={typeNameById}
                        t={t}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {products.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('groupProducts')}
                </p>
                <div className="divide-y rounded-lg border">
                  {products.map((p) => {
                    const { min, max } = productPriceRange(p)
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <span className="text-sm font-medium truncate">{p.name}</span>
                        <span className="text-sm font-medium">
                          {min < max
                            ? t('priceFrom', { amount: formatCurrency(min, currency) })
                            : formatCurrency(min, currency)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── What you sell section ──────────────────────────────────────────────────────

function priceLine(
  price: SubscriptionPrice,
  currency: string,
  t: ReturnType<typeof useTranslations<'OfferPricing'>>,
  tc: ReturnType<typeof useTranslations<'Contacts'>>
): string {
  const amount = formatCurrency(price.amount, currency)
  if (price.credits) {
    return t('priceLineCredits', { credits: price.credits, amount })
  }
  return t('priceLineRecurring', { amount, recurrence: tc(`recurrence_${price.recurrence}`) })
}

function benefitLine(
  b: ReturnType<typeof grantsForType>['benefits'][number],
  currency: string,
  t: ReturnType<typeof useTranslations<'OfferPricing'>>
): string {
  switch (b.effect) {
    case 'included':
      return t('benefitIncluded', { name: b.targetName })
    case 'percent_off':
      return t('benefitPercentOff', { name: b.targetName, percent: b.percent ?? 0 })
    case 'fixed_price':
      return t('benefitFixedPrice', { name: b.targetName, amount: formatCurrency(b.amount ?? 0, currency) })
    case 'spend_credits':
      return t('benefitCredit', { name: b.targetName })
  }
}

function SubscriptionTypeSellCard({
  type,
  currency,
  activities,
  courses,
}: {
  type: SubscriptionType
  currency: string
  activities: Activity[]
  courses: Course[]
}) {
  const t = useTranslations('OfferPricing')
  const tc = useTranslations('Contacts')
  const activePrices = (type.prices ?? []).filter((p) => p.active !== false)
  const grants = useMemo(() => grantsForType(type.id, activities, courses), [type.id, activities, courses])
  const limit = resolveUsageLimit(type)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{type.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {activePrices.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noPrices')}</p>
        ) : (
          <div className="space-y-1">
            {activePrices.map((p) => (
              <p key={p.id} className="text-sm">
                {priceLine(p, currency, t, tc)}
              </p>
            ))}
          </div>
        )}

        {limit && (
          <p className="text-xs text-muted-foreground">
            {t('sellUsageLimit', {
              count: limit.count,
              period: t(`limitPeriod_${limit.per}` as Parameters<typeof t>[0]),
            })}
          </p>
        )}

        {(grants.coveredClassNames.length > 0 || grants.benefits.length > 0) && (
          <div className="space-y-1 pt-1.5 border-t">
            {grants.coveredClassNames.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('coversLabel', {
                  names: truncatedList(grants.coveredClassNames, 4, (count) => t('moreCount', { count })),
                })}
              </p>
            )}
            {grants.benefits.map((b, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                {benefitLine(b, currency, t)}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function WhatYouSellSection({
  subscriptionTypes,
  activities,
  courses,
  products,
  sellableCoursesCount,
  currency,
}: {
  subscriptionTypes: SubscriptionType[]
  activities: Activity[]
  courses: Course[]
  products: Product[]
  sellableCoursesCount: number
  currency: string
}) {
  const t = useTranslations('OfferPricing')
  const activeTypes = subscriptionTypes.filter((st) => st.active !== false)

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-4">
        <div>
          <CardTitle>{t('sectionSellTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('sectionSellSubtitle')}</p>
        </div>
        <Link href={'/offer/plans' as Route} className="text-xs font-medium text-primary hover:underline shrink-0">
          {t('editPlans')}
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        {activeTypes.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{t('noSubscriptionTypes')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activeTypes.map((st) => (
              <SubscriptionTypeSellCard
                key={st.id}
                type={st}
                currency={currency}
                activities={activities}
                courses={courses}
              />
            ))}
          </div>
        )}

        {(products.length > 0 || sellableCoursesCount > 0) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 pt-2 border-t text-xs">
            {products.length > 0 && (
              <Link href={'/manage/products' as Route} className="font-medium text-primary hover:underline">
                {t('shopProductsLine', { count: products.length })}
              </Link>
            )}
            {sellableCoursesCount > 0 && (
              <Link href={'/manage/online-courses' as Route} className="font-medium text-primary hover:underline">
                {t('coursesForSaleLine', { count: sellableCoursesCount })}
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Health section ──────────────────────────────────────────────────────────────

const HEALTH_MESSAGE_KEY: Record<PricingWarningCode, string> = {
  gated_empty_allowlist: 'healthGatedEmptyAllowlist',
  benefit_unknown_type: 'healthBenefitUnknownType',
  purchase_course_unpriced: 'healthPurchaseCourseUnpriced',
  benefit_bad_percent: 'healthBenefitBadPercent',
  gated_no_newcomer_path: 'healthGatedNoNewcomerPath',
  credits_unusable: 'healthCreditsUnusable',
  appointment_no_way_in: 'healthAppointmentNoWayIn',
}

function severityIcon(severity: PricingWarning['severity']) {
  if (severity === 'error') return <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
  if (severity === 'warning') return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
  return <Info className="h-4 w-4 text-muted-foreground shrink-0" />
}

/** Where a warning's "Fix" goes. The catalogue takes a selection in the URL, so
 *  an activity or plan warning now lands ON the subject with the edge editor
 *  open beside it — where every one of these warnings is actually repaired —
 *  rather than on a list page with the fix somewhere on it. */
function fixHref(w: PricingWarning): Route {
  if (w.subjectKind === 'activity') return `/manage/offer?sel=activity:${w.subjectId}` as Route
  if (w.subjectKind === 'course') return `/manage/online-courses/${w.subjectId}` as Route
  return `/manage/offer?sel=plan:${w.subjectId}` as Route
}

function HealthSection({ warnings }: { warnings: PricingWarning[] }) {
  const t = useTranslations('OfferPricing')

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sectionHealthTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {warnings.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
            {t('healthAllGood')}
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                {severityIcon(w.severity)}
                <p className="flex-1 text-sm">
                  {t(HEALTH_MESSAGE_KEY[w.code] as Parameters<typeof t>[0], { name: w.subjectName })}
                </p>
                <Link href={fixHref(w)} className="text-xs font-medium text-primary hover:underline shrink-0">
                  {t('fixLink')}
                </Link>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Discounts section ───────────────────────────────────────────────────────────
//
// WHERE A STUDIO ACTUALLY LOOKS FOR A DISCOUNT (UX-43). Promo codes are a
// plugin, and a plugin's feature is invisible until it is installed — so the only
// route to "run a discount campaign" was to already know it existed and go
// browsing the marketplace. That is a fine shape for a curiosity and the wrong
// one for a money feature.
//
// This is the same placement pattern gift cards use on the Payments page (a
// section of the surface that owns the subject, not a page of its own) with the
// discovery half the pattern was missing: when the plugin is NOT installed the
// section still renders, one line, deep-linking to the plugin's own marketplace
// card (`/settings/plugins?plugin=…` — the exact link the sidebar's plugin
// suggestions use). It never repeats the marketplace's job of explaining plan
// access or price; the card does that, once.
//
// Deliberately READ-ONLY, like the rest of this page: no editing here, the
// manage link routes to the surface that owns the data.

function promoSummary(
  p: PromoCode,
  currency: string,
  t: ReturnType<typeof useTranslations<'OfferPricing'>>
): string {
  if (p.effect === 'percent_off') return t('discountPercentOff', { percent: p.percent ?? 0 })
  return t('discountFixedPrice', { price: formatCurrency(p.amount ?? 0, currency) })
}

function DiscountsSection({ teamId, currency }: { teamId: string | null; currency: string }) {
  const t = useTranslations('OfferPricing')
  const { isInstalled } = useInstalledPlugins()
  const installed = isInstalled('promo-codes')
  // Only fetched once installed — an uninstalled studio has no codes and the
  // read would be pure waste on every visit to this page.
  const { data: codes = [], isLoading } = useTeamPromoCodes(installed ? teamId : null)

  const nowMs = Date.now()
  // "Running right now" is the only count worth stating: a disabled or expired
  // code is not a campaign, and a studio reading "4 discounts" over three dead
  // ones learns the opposite of the truth.
  const live = codes.filter((c) => c.status === 'active' && promoWindowOpen(c, nowMs))

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sectionDiscountsTitle')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('sectionDiscountsSubtitle')}</p>
      </CardHeader>
      <CardContent>
        {!installed ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
            <BadgePercent className="h-4 w-4 shrink-0" />
            <span className="flex-1 min-w-[12rem]">{t('discountsNotInstalled')}</span>
            <Link
              href={'/settings/plugins?plugin=promo-codes' as Route}
              className="text-xs font-medium text-primary hover:underline shrink-0"
            >
              {t('discountsSetUpLink')}
            </Link>
          </div>
        ) : isLoading ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : (
          <div className="space-y-3">
            {live.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('discountsNoneRunning')}</p>
            ) : (
              <div className="divide-y rounded-lg border">
                {live.slice(0, 5).map((c) => (
                  <div key={c.code} className="flex items-center gap-2.5 px-3 py-2.5">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">
                      {c.code}
                    </code>
                    <span className="flex-1 truncate text-sm text-muted-foreground">
                      {c.label || promoSummary(c, currency, t)}
                    </span>
                    <Badge variant="secondary" className="shrink-0 text-[11px]">
                      {promoSummary(c, currency, t)}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              {live.length > 5 && (
                <p className="text-xs text-muted-foreground">
                  {t('moreCount', { count: live.length - 5 })}
                </p>
              )}
              <Link
                href={'/manage/promo-codes' as Route}
                className="ml-auto text-xs font-medium text-primary hover:underline"
              >
                {t('discountsManageLink')}
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── page ────────────────────────────────────────────────────────────────────────

export default function PricingPage() {
  const t = useTranslations('OfferPricing')
  const tNav = useTranslations('Nav')
  const { currentTeamId, team } = useAuth()
  const currency = team?.default_currency ?? 'CHF'

  const { data: activities = [], isLoading: activitiesLoading } = useActivities(currentTeamId)
  const { data: bookingSettings, isLoading: settingsLoading } = useBookingSettings(currentTeamId)
  const { data: subscriptionTypes = [], isLoading: typesLoading } = useSubscriptionTypes(currentTeamId)
  const { data: products = [], isLoading: productsLoading } = useProducts(currentTeamId)
  const { data: allCourses = [], isLoading: coursesLoading } = useCourses(currentTeamId)

  const classes = useMemo(() => activities.filter((a) => a.type !== 'appointment'), [activities])
  const appointments = useMemo(() => activities.filter((a) => a.type === 'appointment'), [activities])
  const visibleCourses = useMemo(
    () => allCourses.filter((c) => !c.archived_at && (c.status === 'published' || c.status === 'draft')),
    [allCourses]
  )
  const activeProducts = useMemo(() => products.filter((p) => p.active !== false), [products])
  const sellableCoursesCount = useMemo(
    () => visibleCourses.filter((c) => isSellableCourse(c)).length,
    [visibleCourses]
  )

  const personas = useMemo(() => buildPersonas(subscriptionTypes), [subscriptionTypes])
  const studioDropIn = useMemo(() => studioDropInOf(bookingSettings), [bookingSettings])
  const warnings = useMemo(
    () => computePricingHealth(activities, subscriptionTypes, visibleCourses, studioDropIn),
    [activities, subscriptionTypes, visibleCourses, studioDropIn]
  )

  const loading =
    activitiesLoading || typesLoading || productsLoading || coursesLoading || settingsLoading

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        quickLinks={[
          { href: '/offer/activities' as Route, label: tNav('activities') },
          { href: '/offer/plans' as Route, label: tNav('subscriptions') },
        ]}
      />

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      ) : (
        <>
          {/* HEALTH FIRST (2026-08-25). It is the only section that can tell a
              studio something is WRONG; the other three describe what is. A
              page whose problems are reported last is a page whose problems get
              read last. */}
          <HealthSection warnings={warnings} />
          {/* The door price BEFORE the preview that quotes it — set once here,
              read by every class below that follows it. */}
          <DropInDefaultCard
            teamId={currentTeamId}
            classes={classes}
            stored={studioDropIn}
            currency={currency}
          />
          <PricingPreviewSection
            classes={classes}
            appointments={appointments}
            courses={visibleCourses}
            products={activeProducts}
            personas={personas}
            subscriptionTypes={subscriptionTypes}
            currency={currency}
            studioDropIn={studioDropIn}
          />
          <WhatYouSellSection
            subscriptionTypes={subscriptionTypes}
            activities={activities}
            courses={visibleCourses}
            products={activeProducts}
            sellableCoursesCount={sellableCoursesCount}
            currency={currency}
          />
          {/* Between what you sell and whether it hangs together: a discount is
              a modifier of the prices above it, so it reads in that order. */}
          <DiscountsSection teamId={currentTeamId} currency={currency} />
        </>
      )}
    </div>
  )
}

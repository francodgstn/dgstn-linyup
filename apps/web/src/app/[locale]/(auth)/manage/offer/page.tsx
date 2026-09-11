'use client'

// ─── THE CATALOGUE ───────────────────────────────────────────────────────────
//
// Activities and plans are a many-to-many, and the thing a studio is actually
// editing is the EDGE between them — "Premium includes Yoga Basics". That edge
// had no home: it was authored from inside the activity dialog and again from
// inside the plan dialog, and displayed nowhere you could scan. A coach
// answering "what does Premium get?" switched routes and opened a modal.
//
// So: one rail, one pane, and the edge visible from whichever side you are
// thinking in. The pane owns the RELATIONSHIP and the name; everything else
// stays with the entity's own editor, which is a ~700-line form per kind and a
// different project to move.
//
// ── WHY PLANS SIT ABOVE THE ACTIVITIES ──────────────────────────────────────
// A studio has a handful of plans and can have thirty classes. Plans-below
// would mean scrolling past every class to reach the short list you came for;
// this way scrolling only ever happens INSIDE the long list you are already
// browsing.
//
// ── THE RAIL IS TABBED, AND PRODUCTS ARE ONE OF THE TABS ────────────────────
// It was four stacked groups, which meant scrolling past every plan to reach a
// class, and past every class to reach a course. Tabs are the right shape for
// lists that are alternatives to each other rather than parts of one list.
//
// Classes and appointments stay as SUB-HEADINGS inside the Activities tab: they
// differ in a way the pane has to show (an appointment has no access gate,
// because the price is the gate), and that asymmetry is worth seeing, but they
// are the same kind of thing and splitting them into two tabs would say
// otherwise.
//
// PRODUCTS ARE HERE NOW, and the file used to say flatly that they were not.
// The old reasoning was sound about the EDGE — a product carries no access rule
// and no benefit, so no plan can open it and the edge editor has nothing to
// draw. It was wrong about the PAGE: a studio opening "the catalogue" expects
// everything it sells to be in it, and being told nothing is worse than being
// told "this one is sold on its own" (Franco, 2026-08-31). So a product selects
// like anything else, the pane shows its facts, and where the edge editor would
// be it says plainly that a plan cannot open a product. Gift cards stay out:
// a gift card is a TENDER, not a thing that is sold.
//
// ── NO MATRIX ───────────────────────────────────────────────────────────────
// Not because a cell could not hold "20% off", but because there is no per-pair
// value to put in one: `memberBenefit` is ONE rule per activity shared by every
// plan on it. The per-pair matrix existed and was cut in 2026-07 after it
// produced real coach confusion.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import type { Route } from 'next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { collection, deleteDoc, doc, getDocs, updateDoc, writeBatch } from 'firebase/firestore'
import {
  AlertTriangle,
  Archive,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  Copy,
  DoorOpen,
  ExternalLink,
  GraduationCap,
  GripVertical,
  IdCard,
  Package,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  type LucideIcon,
  Users,
  Zap,
} from 'lucide-react'

import {
  ACTIVITIES_COLLECTION,
  activityPlanFacets,
  COURSES_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  courseGatedPlanIds,
  courseRatedPlanIds,
  gatedPlanIds,
  isAppointmentActivity,
  resolveAppointmentDurations,
  anyRatedPlanIds,
  ratedPlanIds,
  resolveActivityAccessRule,
  classAccessTierOf,
  resolveClassGate,
  type Activity,
  type Course,
  type Product,
  type SubscriptionType,
  resolveActivityDropIn,
  studioDropInOf,
} from '@linyup/shared'
import { db } from '@/lib/firebase'
import { refreshQueries } from '@/lib/queryRefresh'
import { deleteProduct } from '@/plugins/products/hooks'
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
import { ActivityScheduleSheet } from '@/components/activities/ActivityScheduleSheet'
import { useAuth } from '@/contexts/AuthContext'
import { useActivities } from '@/hooks/useActivities'
import { useBookingSettings } from '@/hooks/useBookingSettings'
import { useCapabilities } from '@/hooks/useCapabilities'
import { Link, useRouter } from '@/i18n/navigation'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tip'
import { AiDraftDialog } from '@/components/offer/AiDraftDialog'
import { useExperimentalFeatures } from '@/hooks/useExperimentalFeatures'
import {
  PaneDirtyProvider,
  usePaneDirtyState,
} from '@/components/offer/paneDirty'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { computePricingHealth, type PricingWarning } from '@/lib/pricingSurface'
import { useGatewayCurrency } from '@/components/connect/BillingCurrencyCard'
import { ActivityPlanLinks, type Offering } from '@/components/offer/ActivityPlanLinks'
import { useCourses } from '@/plugins/online-courses/hooks'
import { useProducts } from '@/plugins/products/hooks'
import { activityMoneyChipLabels } from '@/lib/activityTerms'
import { reorderWithinSection } from '@/lib/reorder'
import { SortableItem, SortableList, type SortableRenderProps } from '@/components/ui/sortable'
import { formatCurrency } from '@/lib/format'
import { OfferFacts, type OfferChip, type OfferFactsProps } from '@/components/offer/OfferFacts'
import { ActivityDialog } from '@/components/activities/ActivityDialog'
import { ActivityPricingForm } from '@/components/activities/ActivityPricingForm'
import { PlanPricingForm } from '@/components/subscriptions/PlanPricingForm'
import { PlanTemplatesDialog } from '@/components/subscriptions/PlanTemplatesDialog'
import { SubTypeDialog } from '@/components/subscriptions/SubscriptionTypeDialog'
import { SubscriptionAutomationsSection } from '@/components/subscriptions/SubscriptionAutomationsSection'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { SectionHeading } from '@/components/layout/SectionHeading'

const DEFAULT_ACCENT = '#6366f1'

/** The two health codes that mean "nobody can book this". The banner counts
 *  exactly these and adds no second definition of covered — a members-tier class
 *  in no plan is healthy, and stays uncounted. */
const DEAD_END_CODES = new Set<PricingWarning['code']>([
  'gated_empty_allowlist',
  'appointment_no_way_in',
])

type Selection = { kind: 'activity' | 'course' | 'plan' | 'product'; id: string } | null

/**
 * HOW A THING IS EDITED FROM THIS PAGE: open a dialog here, or go to the page
 * that owns the form. One type for both, so a row and the pane it opens cannot
 * end up offering different things — see `paneActionsFor`.
 */
type PaneActionRun = { run: () => void } | { href: Route }

/**
 * ONE ROW OF ICONS, and the last two are always the same two.
 *
 * The pane used to carry a single Edit button. The kinds it hosts do not offer
 * the same things, though — an activity can show its upcoming sessions and be
 * duplicated, a course can be neither — so a naive per-kind row would put Edit
 * in a different place on every tab, which is the one thing a studio switching
 * between them cannot afford (Franco, 2026-09-01).
 *
 * So the row is RIGHT-ALIGNED and ordered `[kind-specific…] [duplicate] [edit]
 * [destructive]`. Whatever precedes them, EDIT IS ALWAYS SECOND FROM THE RIGHT
 * AND THE DESTRUCTIVE ONE IS ALWAYS LAST — the same pixels on every kind.
 *
 * `danger` marks the destructive one, which is the only one that opens a
 * confirmation. Which destruction it is follows the kind's OWN page rather than
 * a rule invented here: an activity and a course ARCHIVE, a plan and a product
 * DELETE. The catalogue is a second door onto those records, not a second
 * policy about them.
 */
/** Archive or delete — whichever the kind's own page does. */
type DestroyMode = 'archive' | 'delete'

type Confirming = {
  kind: NonNullable<Selection>['kind']
  id: string
  name: string
  mode: DestroyMode
} | null

type PaneAction = PaneActionRun & {
  key: string
  icon: LucideIcon
  label: string
  danger?: boolean
}

/**
 * ONE BUTTON, and it asks what you are making.
 *
 * It used to relabel itself per tab — "New activity" on one, "New product" on
 * the next — which made a control that never moves look like four different
 * ones, and meant creating a plan while reading the Courses tab took a detour
 * through the tab strip (Franco, 2026-09-02).
 *
 * The menu offers only what this team HAS: a studio without the courses plugin
 * is not shown a course it cannot make. Activities and plans open the dialog
 * this page already mounts; courses and products link to their own page, which
 * owns the per-plan cap and the first-step form — see `?new=1` there.
 */
function CreateAction({
  tabs,
  onOpen,
  onDraftWithAi,
}: {
  tabs: { key: TabKey }[]
  onOpen: (kind: 'activity' | 'plan') => void
  /** Absent unless the `offer-drafting` experiment is on for this team. */
  onDraftWithAi?: () => void
}) {
  const t = useTranslations('OfferCatalogue')
  const has = (k: TabKey) => tabs.some((x) => x.key === k)
  return (
    <DropdownMenu>
      {/* The trigger IS the button — `render={<Button/>}` did not wire the
          click, and every other menu in the app styles the trigger directly. */}
      <DropdownMenuTrigger className={buttonVariants()}>
        <Plus className="mr-1.5 h-4 w-4" />
        {t('createNew')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {has('activities') && (
          <DropdownMenuItem onClick={() => onOpen('activity')}>
            <Zap className="mr-2 h-4 w-4" />
            {t('newActivity')}
          </DropdownMenuItem>
        )}
        {has('plans') && (
          <DropdownMenuItem onClick={() => onOpen('plan')}>
            <IdCard className="mr-2 h-4 w-4" />
            {t('newPlan')}
          </DropdownMenuItem>
        )}
        {has('courses') && (
          <DropdownMenuItem
            render={<Link href={'/manage/online-courses?new=1' as Route} />}
          >
            <GraduationCap className="mr-2 h-4 w-4" />
            {t('newCourse')}
          </DropdownMenuItem>
        )}
        {has('products') && (
          <DropdownMenuItem render={<Link href={'/manage/products?new=1' as Route} />}>
            <Package className="mr-2 h-4 w-4" />
            {t('newProduct')}
          </DropdownMenuItem>
        )}
        {/* LAST, and separated. It is another way to create, so it belongs in
            this menu — but it makes SEVERAL records from a sentence where every
            row above makes one from a form, and that difference is worth a
            rule. */}
        {onDraftWithAi && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDraftWithAi}>
              <Sparkles className="mr-2 h-4 w-4" />
              {t('aiDraft')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The rail's tabs. `activities` holds classes AND appointments — see the header. */
type TabKey = 'activities' | 'plans' | 'courses' | 'products'

/** Which tab a selection belongs to, so a deep link opens the tab holding it. */
const TAB_FOR_KIND: Record<NonNullable<Selection>['kind'], TabKey> = {
  activity: 'activities',
  plan: 'plans',
  course: 'courses',
  product: 'products',
}

/** Selection rides in the URL so the pane is deep-linkable — which is what lets
 *  the pricing surface's warnings point AT the thing to fix instead of at a list
 *  page with the fix somewhere on it. */
function parseSelection(raw: string | null): Selection {
  if (!raw) return null
  const [kind, ...rest] = raw.split(':')
  const id = rest.join(':')
  if (!id) return null
  if (kind === 'activity' || kind === 'course' || kind === 'plan' || kind === 'product')
    return { kind, id }
  return null
}

function useSubscriptionTypes(teamId: string | null) {
  return useQuery<SubscriptionType[]>({
    queryKey: ['subscription-types', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        collection(db, TEAMS_COLLECTION, teamId, SUBSCRIPTION_TYPES_SUBCOLLECTION)
      )
      return snap.docs
        .map((d) => ({ ...d.data(), id: d.id }) as SubscriptionType)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
    },
  })
}

export default function CataloguePage() {
  const t = useTranslations('OfferCatalogue')
  // The facts block reuses the list pages' OWN copy rather than restating it:
  // three namespaces, because three pages own these words and a fourth set of
  // strings saying the same things is how they start saying different ones.
  const tAct = useTranslations('Activities')
  // The quick links borrow the SIDEBAR's labels, so a shortcut and the row it
  // leads to can never end up calling the same page two things.
  const tNav = useTranslations('Nav')
  const tCommon = useTranslations('Common')
  const tSet = useTranslations('TeamSettings')
  const tTpl = useTranslations('PlanTemplates')
  const tc = useTranslations('Contacts')
  const { currentTeamId, team, user } = useAuth()
  const canEdit = useCapabilities().can('team.settings')
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const router = useRouter()
  const params = useSearchParams()
  const qc = useQueryClient()

  const selection = parseSelection(params.get('sel'))
  /**
   * `?tab=` — which list to open on, when no `?sel=` names a row.
   *
   * The retired activities and plans pages redirect here through it, so a
   * bookmark of either lands on the list it used to show rather than on
   * whichever tab this page would have picked. Ignored when it names a tab the
   * team has not installed; `activeTab` already guards that.
   */
  const tabParam = params.get('tab')
  const requestedTab: TabKey | null =
    tabParam === 'activities' || tabParam === 'plans' || tabParam === 'courses' ||
    tabParam === 'products'
      ? tabParam
      : null
  const [onlyDeadEnds, setOnlyDeadEnds] = useState(false)
  /** Plans rail: show only one SOURCE, or all of them. A studio that accepts
   *  two or three partners has their plans interleaved with its own by `order`,
   *  and "which of these do I actually sell?" is the question it then asks the
   *  list most often. Null = no filter, which is what the rail opens on. */
  const [planSource, setPlanSource] = useState<'internal' | 'aggregator' | null>(null)

  /**
   * THE DECK'S HEIGHT, MEASURED.
   *
   * The header block is sticky and the rail hangs off its bottom edge, so the
   * rail's `top` is the deck's height — which is not a constant: the related
   * links wrap at some widths, the dead-end banner comes and goes, and a coach
   * gets two tabs where a studio gets four. A hard-coded offset is right on one
   * screen and wrong on the rest (Franco, 2026-09-02).
   */
  const deckRef = useRef<HTMLDivElement>(null)
  const [deckH, setDeckH] = useState(0)
  /** Whether anything has scrolled under the deck yet — the shadow's only job
   *  is to say "there is more above", so at the top there is nothing to say. */
  const [deckScrolled, setDeckScrolled] = useState(false)
  useEffect(() => {
    const el = deckRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setDeckH(el.offsetHeight))
    ro.observe(el)
    setDeckH(el.offsetHeight)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    // Cheap in the same way the sidebar's is: React bails out when the boolean
    // is unchanged, so this costs a render on the two frames that cross the
    // boundary, not on every scroll event.
    const onScroll = () => setDeckScrolled(window.scrollY > 0)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  // NULL until the studio picks a tab, so a deep link (`?sel=plan:x`, which the
  // pricing warnings and both editors produce) opens on the tab that HOLDS the
  // selection rather than on Activities with the pane showing something the rail
  // beside it does not list. Once a tab is picked it wins — selecting within it
  // must not be able to move the reader somewhere else.
  const [pickedTab, setPickedTab] = useState<TabKey | null>(null)
  // ── THE EDITORS, MOUNTED HERE ────────────────────────────────────────────
  // The catalogue is where a studio reasons about what it sells, so it is where
  // the things it sells should be editable — it used to be able to do nothing
  // but link away to the list page that owned the form (Franco, 2026-08-31).
  // Both dialogs are the SAME components those pages mount, lifted out of them
  // for the purpose; nothing about either form changed in the move.
  //
  // Courses and products keep their links: a course's editor is a whole PAGE
  // (media, lessons, ordering), not a dialog, and a product's is still a fixture
  // of its own page. Linking to a form that exists is better than half-lifting
  // one that does not.
  const [editingActivity, setEditingActivity] = useState<Activity | null>(null)
  const [editingPlan, setEditingPlan] = useState<SubscriptionType | null>(null)
  // A duplicate is a CREATE seeded from a record, which is why it is separate
  // state and not a flag on the edit target — both dialogs already know it.
  const [duplicatingActivity, setDuplicatingActivity] = useState<Activity | null>(null)
  const [duplicatingPlan, setDuplicatingPlan] = useState<SubscriptionType | null>(null)
  /** Which kind is being CREATED, if any. Separate from the edit and duplicate
   *  targets because all three drive the same dialog and only one can be true. */
  const [creating, setCreating] = useState<'activity' | 'plan' | null>(null)
  const [schedulePreview, setSchedulePreview] = useState<Activity | null>(null)
  const [confirming, setConfirming] = useState<Confirming>(null)
  // AN EXPERIMENT, off unless the owner switched it on — see
  // EXPERIMENTAL_FEATURES. `isEnabled` reads false while the team doc is still
  // loading, which is the safe direction for an opt-in.
  const { isEnabled } = useExperimentalFeatures()
  const aiDrafting = isEnabled('offer-drafting')
  const [aiOpen, setAiOpen] = useState(false)

  const { data: activities = [], isLoading: loadingActivities } = useActivities(currentTeamId)
  // The studio's default drop-in, for every class that follows it — the rail
  // chip, the tier and the form all price such a class through it.
  const { data: bookingSettings } = useBookingSettings(currentTeamId)
  const studioDropIn = studioDropInOf(bookingSettings)
  const { data: plans = [], isLoading: loadingPlans } = useSubscriptionTypes(currentTeamId)
  const { data: gatewayCurrency } = useGatewayCurrency(currentTeamId)
  // Courses only exist for a studio that installed the plugin, so the group is
  // absent rather than empty when it is not — an empty "Courses" heading would
  // advertise a feature this studio has not got.
  const { isInstalled } = useInstalledPlugins()
  const coursesInstalled = isInstalled('online-courses')
  const { data: courses = [], isLoading: loadingCourses } = useCourses(
    coursesInstalled ? currentTeamId : null
  )
  // Same gate, same reason: a "Products" tab on a studio without the plugin
  // advertises a feature it has not got.
  const productsInstalled = isInstalled('products')
  const { data: products = [], isLoading: loadingProducts } = useProducts(
    productsInstalled ? currentTeamId : null
  )
  const loading =
    loadingActivities ||
    loadingPlans ||
    (coursesInstalled && loadingCourses) ||
    (productsInstalled && loadingProducts)
  // Same derivation as the Subscriptions panel — the stored team currency, else
  // whatever the payment gateway is configured in, else CHF. Two surfaces
  // showing a rate in different currencies would be worse than either being
  // wrong.
  const currency = (team?.default_currency ?? gatewayCurrency ?? 'CHF').toUpperCase()

  // Courses are passed empty on purpose: the banner counts only the two ACTIVITY
  // codes above, and neither is ever raised for a course — so fetching them
  // would buy a round-trip and change nothing that is displayed.
  const warnings = useMemo(
    () => computePricingHealth(activities, plans, []).filter((w) => DEAD_END_CODES.has(w.code)),
    [activities, plans]
  )
  const deadEndIds = useMemo(() => new Set(warnings.map((w) => w.subjectId)), [warnings])

  // ── everything a plan can open or discount, flattened to rows ──
  // Products and gift cards are deliberately absent: a product carries no
  // access rule and no benefit, and a gift card is a tender. Neither has an
  // edge for a plan to sit on. See `PlanLinkTarget` in @linyup/shared.
  // ONE ROW PER SESSION LENGTH, on an appointment. Its member rule is per
  // length, so a single row for the whole appointment could only ever write one
  // of them — and would answer "does this plan include it?" with one tick for
  // three different prices. The rows share a document and an id; `key` is what
  // tells them apart (see `Offering.key`), and the length rides on the target.
  const toActivityOfferings = (a: Activity): Offering[] => {
    const base = {
      id: a.id,
      collection: ACTIVITIES_COLLECTION,
      color: a.color ?? '',
    }
    if (!isAppointmentActivity(a)) {
      return [{ ...base, name: a.name, target: { kind: 'activity', doc: a } }]
    }
    return resolveAppointmentDurations(a).map((d) => ({
      ...base,
      key: `${a.id}:${d.minutes}`,
      name: t('lengthRow', { name: a.name, minutes: d.minutes }),
      badge: t('appointmentBadge'),
      target: { kind: 'activity', doc: a, minutes: d.minutes },
    }))
  }
  const toCourseOffering = (c: Course): Offering => ({
    id: c.id,
    name: c.title,
    collection: COURSES_COLLECTION,
    badge: t('courseBadge'),
    target: { kind: 'course', doc: c },
  })
  const allOfferings: Offering[] = [
    ...activities.flatMap(toActivityOfferings),
    ...courses.map(toCourseOffering),
  ]

  const classes = activities.filter((a) => !isAppointmentActivity(a))
  const appointments = activities.filter(isAppointmentActivity)
  const visible = (list: Activity[]) =>
    onlyDeadEnds ? list.filter((a) => deadEndIds.has(a.id)) : list
  const visibleCourses = onlyDeadEnds ? courses.filter((c) => deadEndIds.has(c.id)) : courses
  // `source` is absent on every plan written before the field existed, and those
  // are the studio's own — so the default reading is 'internal', never "neither".
  const visiblePlans = planSource
    ? plans.filter((st) => (st.source ?? 'internal') === planSource)
    : plans

  // The SAME icons name these things in the sidebar, so they are what a studio
  // already recognises them by. The strip's layout lives with the strip.
  const tabs: { key: TabKey; label: string; icon: React.ElementType; count: number }[] = [
    { key: 'activities', label: t('tabActivities'), icon: Zap, count: activities.length },
    { key: 'plans', label: t('railPlans'), icon: IdCard, count: plans.length },
    ...(coursesInstalled
      ? [
          {
            key: 'courses' as const,
            label: t('railCourses'),
            icon: GraduationCap,
            count: courses.length,
          },
        ]
      : []),
    ...(productsInstalled
      ? [
          {
            key: 'products' as const,
            label: t('tabProducts'),
            icon: Package,
            count: products.length,
          },
        ]
      : []),
  ]
  const fallbackTab: TabKey = selection ? TAB_FOR_KIND[selection.kind] : 'activities'
  // A tab can vanish under a stored choice: uninstall the products plugin with
  // that tab open and `pickedTab` names a tab that is not rendered, which would
  // show an empty rail with nothing selected in the strip.
  const activeTab = tabs.some((x) => x.key === (pickedTab ?? requestedTab ?? fallbackTab))
    ? (pickedTab ?? requestedTab ?? fallbackTab)
    : 'activities'

  /** How many dead ends each tab holds — shown on the strip while the filter is
   *  on, because a tab that filters to nothing otherwise reads as "no problems
   *  here" exactly when the studio is hunting for problems. */
  const deadEndsPerTab: Partial<Record<TabKey, number>> = {
    activities: activities.filter((a) => deadEndIds.has(a.id)).length,
    courses: courses.filter((c) => deadEndIds.has(c.id)).length,
  }

  // ── THE FACTS, per kind ──────────────────────────────────────────────────
  // What each list page shows on a row, for the one thing that is selected.
  // Derived HERE because this page already holds the documents; the one part
  // that is real logic — an activity's money chips — comes from the SHARED
  // `activityMoneyChipLabels` the activities list itself reads, so the two
  // surfaces cannot disagree about what something costs.
  // NO KIND BADGE IN THE CHIPS. The pane's header already carries it beside the
  // name, and in the rail the row sits under a heading that says it — so it was
  // printed twice on one screen and told the reader nothing either time.
  /** The tier a class's gate actually amounts to — see the chip below. */
  const classTierOf = (a: Activity): 'open' | 'members' | 'subscription' =>
    classAccessTierOf(
      resolveClassGate(resolveActivityAccessRule(a), resolveActivityDropIn(a, studioDropIn).enabled)
    )

  const activityChips = (a: Activity): OfferChip[] => {
    const appointment = isAppointmentActivity(a)
    const rule = resolveActivityAccessRule(a)
    return [
      // THE FORM'S OWN WORDS for who can book. The editor now asks TWO
      // questions — open to anyone / members only, then whether a plan is
      // required — and `accessRule.type` is the display projection of that
      // pair, so `access_open` / `access_members` / `access_subscription`
      // ("Plan required") still name exactly what was chosen. It used to be a shorter private vocabulary ("Members",
      // "Subscription") that appeared nowhere the studio had chosen from, and
      // said NOTHING AT ALL for an open class — the commonest answer of the
      // three rendered as an absent chip, which reads as "not configured"
      // rather than "anyone can book" (Franco, 2026-08-31).
      //
      // CLASS-ONLY. An appointment has no access rule — the price is the gate —
      // so `resolveActivityAccessRule` falls back to 'open' for one, and
      // printing "Open to everyone" over a paid appointment would be a claim
      // about a field it does not have.
      ...(appointment
        ? []
        : [
            {
              // DERIVED, not read off `accessRule.type`. That field is the
              // display projection of the two facts below it, and the form keeps
              // it in step — but seeded or hand-written data can carry a stale
              // one, and a chip saying "Plan required" over a class that plainly
              // does not require a plan is worse than no chip. Asking the gate
              // is asking the same thing the booking path will answer.
              label: tAct(`access_${classTierOf(a)}` as const),
              tone: 'accent' as const,
            },
          ]),
      // Tags follow the access fact rather than leading. Who may book outranks
      // a freeform label, and the rail's leading icon (`activityAccessIcon`)
      // labels whatever the line STARTS with — with tags first it would have sat
      // against "intermediate" and appeared to mean that.
      ...(a.tags ?? []).map((tag) => ({ label: tag })),
      // The newcomer's trial door, where it opens something: it is independent
      // of the tier above, but on an OPEN class it grants nothing extra
      // (everyone already books free), so the editor ignores it there and so
      // does this. A PRICED trial is money and comes through the money chips
      // below as "Trial {amount}" instead — one trial fact per row, not two.
      ...(!appointment &&
      classTierOf(a) !== 'open' &&
      a.trialEnabled === true &&
      a.trialPriceAmount == null
        ? [{ label: tAct('freeTrialBadge') }]
        : []),
      // "Drop-in {amount}" is one of these — the drop-in fact, with its price.
      ...activityMoneyChipLabels(
        // With the drop-in RESOLVED — a class that follows the studio default
        // stores no price of its own, and the chip has to say what the door
        // costs, not what the document happens to contain.
        { ...a, dropIn: resolveActivityDropIn(a, studioDropIn) },
        currency,
        plans,
        tAct as unknown as (key: string, values?: Record<string, string | number>) => string,
        formatCurrency
      ).map((label) => ({ label })),
    ]
  }

  /**
   * THE RAIL'S LEADING GLYPH — the same fact the first chip states, so a studio
   * scanning twenty rows sees who may book without reading any of them.
   *
   * The vocabulary is the catalogue's own, which is why `IdCard` means PLAN
   * REQUIRED and not "members": this page already spends that glyph on the
   * Plans rail tab, and one icon meaning both on one screen is worse than no
   * icon. `Users` is what the org nav already calls Members. The pricing form's
   * two tiles use the same door and the same people.
   *
   * Undefined for an APPOINTMENT, which has no access rule at all — its price
   * is its gate, so `activityChips` prints no access chip and there is nothing
   * here to label.
   */
  const activityAccessIcon = (a: Activity): LucideIcon | undefined => {
    if (isAppointmentActivity(a)) return undefined
    const tier = classTierOf(a)
    return tier === 'open' ? DoorOpen : tier === 'members' ? Users : IdCard
  }

  const planChips = (st: SubscriptionType): OfferChip[] => [
    // A CHIP MARKS THE EXCEPTION, NOT THE RULE. Almost every plan is the
    // studio's own, so "Internal" was a label on nearly every row — carrying no
    // information while costing a scan. Only a plan that comes from somewhere
    // else (a partner fitness app) is worth naming (Franco, 2026-09-01).
    ...(st.source === 'aggregator' ? [{ label: tSet('subTypeSourceAggregator') }] : []),
    // INACTIVE AND PRIVATE ARE WARNINGS, not neutral facts: a plan the studio
    // is reading the coverage of, that nobody can currently buy, is the single
    // most useful thing this pane can tell them.
    ...(st.active === false ? [{ label: tSet('subTypeInactive'), tone: 'warn' as const }] : []),
    ...(st.public ? [{ label: tSet('subTypePublicBadge') }] : []),
    ...(st.prices ?? [])
      .filter((price) => price.active !== false)
      .map((price) => ({
        label:
          `${formatCurrency(price.amount, currency)} · ${tc(`recurrence_${price.recurrence}`)}` +
          (price.credits ? ` · ${tSet('subTypeCreditsBadge', { count: price.credits })}` : ''),
      })),
  ]

  const courseChips = (c: Course): OfferChip[] => [
    ...(c.status !== 'published'
      ? [{ label: t(c.status === 'draft' ? 'courseDraft' : 'courseArchived'), tone: 'warn' as const }]
      : []),
    {
      label:
        c.accessRule.type === 'purchase' && typeof c.accessRule.priceAmount === 'number'
          ? formatCurrency(c.accessRule.priceAmount, currency)
          : t(`courseAccess_${c.accessRule.type}` as Parameters<typeof t>[0]),
      tone: 'accent' as const,
    },
  ]

  const productChips = (pr: Product): OfferChip[] => [
    { label: formatCurrency(pr.priceAmount, currency), tone: 'accent' as const },
    ...(pr.active === false ? [{ label: t('productInactive'), tone: 'warn' as const }] : []),
    ...(pr.variants?.length
      ? [{ label: t('productVariants', { count: pr.variants.length }) }]
      : []),
  ]

  function select(next: Selection) {
    const sel = next ? `${next.kind}:${next.id}` : null
    router.replace((sel ? `/manage/offer?sel=${sel}` : '/manage/offer') as Route, {
      scroll: false,
    })
  }

  /** Click a row: select it, or clear it if it was already the selection. Was
   *  written out per row four times over; one helper is one behaviour. */
  function toggle(kind: NonNullable<Selection>['kind'], id: string) {
    select(selection?.kind === kind && selection.id === id ? null : { kind, id })
  }

  /**
   * The row's second line — the chips, flattened.
   *
   * THE SAME DERIVATION THE PANE USES, joined rather than re-decided: a row that
   * summarised the thing differently from the pane it opens would make the
   * reader check which one to believe. Truncation is the layout's job (the row
   * is `truncate`), not this function's — cutting the string here would put an
   * ellipsis in the middle of the accessible name too.
   */
  const detailLine = (chips: OfferChip[]) =>
    // A BULLET BETWEEN CHIPS, not the middot the chips use INSIDE themselves. A
    // plan's price chip is already "CHF 89.00 · Monthly", so joining chips with
    // the same mark turned two prices into six anonymous fragments — the line is
    // there to be read at a glance, and that is the one thing it could not be.
    chips.map((c) => c.label).join(' • ') || undefined

  /**
   * HOW A THING IS EDITED FROM HERE — the one answer, shared by a row's pencil
   * and by the pane's Edit button, so the two can never lead somewhere
   * different.
   *
   * An activity or a plan opens its form RIGHT HERE. A course or a product
   * still navigates: a course's editor is a page, and a product's is a fixture
   * of its own page — linking to a form that exists beats half-lifting one that
   * does not.
   *
   * A reader who cannot edit gets neither: a shortcut into a form that refuses
   * them is worse than no shortcut.
   */
  const paneActionsFor = (kind: NonNullable<Selection>['kind'], id: string): PaneAction[] => {
    if (!canEdit) return []
    const edit = (run: PaneActionRun): PaneAction => ({
      key: 'edit',
      icon: Pencil,
      label: t('editAll'),
      ...run,
    })
    const duplicate = (run: PaneActionRun): PaneAction => ({
      key: 'duplicate',
      icon: Copy,
      label: tCommon('duplicate'),
      ...run,
    })
    const destroy = (name: string, mode: DestroyMode): PaneAction => ({
      key: 'destroy',
      icon: mode === 'archive' ? Archive : Trash2,
      label: mode === 'archive' ? t('archiveAction') : t('deleteAction'),
      danger: true,
      run: () => setConfirming({ kind, id, name, mode }),
    })

    if (kind === 'activity') {
      const a = activities.find((x) => x.id === id)
      if (!a) return []
      return [
        // Viewing precedes changing, and "is this actually on the calendar?" is
        // the question the pane cannot answer about itself.
        {
          key: 'schedule',
          icon: CalendarDays,
          label: tAct('viewSchedule'),
          run: () => setSchedulePreview(a),
        },
        duplicate({ run: () => setDuplicatingActivity(a) }),
        edit({ run: () => setEditingActivity(a) }),
        destroy(a.name, 'archive'),
      ]
    }
    if (kind === 'plan') {
      const pl = plans.find((x) => x.id === id)
      if (!pl) return []
      return [
        duplicate({ run: () => setDuplicatingPlan(pl) }),
        edit({ run: () => setEditingPlan(pl) }),
        destroy(pl.name, 'delete'),
      ]
    }
    if (kind === 'course') {
      const c = courses.find((x) => x.id === id)
      if (!c) return []
      // No duplicate: the course page does not offer one either, and a course
      // copied without its modules and lessons would be an empty shell.
      return [
        edit({ href: `/manage/online-courses/${id}` as Route }),
        destroy(c.title, 'archive'),
      ]
    }
    const pr = products.find((x) => x.id === id)
    if (!pr) return []
    return [
      duplicate({ href: `/manage/products?duplicate=${id}` as Route }),
      edit({ href: `/manage/products?edit=${id}` as Route }),
      destroy(pr.name, 'delete'),
    ]
  }

  /** A ROW shows one pencil, not the bar — the bar belongs to the thing you have
   *  opened. Taken from the same list so the two can never disagree. */
  const editOf = (kind: NonNullable<Selection>['kind'], id: string): PaneAction | undefined =>
    paneActionsFor(kind, id).find((a) => a.key === 'edit')

  /** The destructive action, run against the same collection its own page uses. */
  async function runDestroy() {
    if (!confirming || !currentTeamId) return
    const { kind, id } = confirming
    if (kind === 'activity') {
      await updateDoc(doc(db, ACTIVITIES_COLLECTION, id), { isActive: false })
      refreshQueries(qc, ['activities'])
    } else if (kind === 'plan') {
      await deleteDoc(doc(db, TEAMS_COLLECTION, currentTeamId, SUBSCRIPTION_TYPES_SUBCOLLECTION, id))
      await qc.invalidateQueries({ queryKey: ['subscription-types', currentTeamId] })
    } else if (kind === 'course') {
      await updateDoc(doc(db, COURSES_COLLECTION, id), { status: 'archived' })
      await qc.invalidateQueries({ queryKey: ['courses', currentTeamId] })
    } else {
      await deleteProduct(currentTeamId, id)
      await qc.invalidateQueries({ queryKey: ['products', currentTeamId] })
    }
    // The pane is now pointing at something that is gone or filed away.
    setConfirming(null)
    select(null)
  }

  // ── ORDERING ─────────────────────────────────────────────────────────────
  // The same `order` field the activities list and the subscriptions manager
  // write, through the same `reorderWithinSection` permutation — so a studio
  // that arranges its plans here sees that arrangement everywhere, including on
  // the public surfaces, and not a third opinion about the order.
  //
  // NOT WHILE THE DEAD-END FILTER IS ON. The rail then shows a SUBSET, and every
  // one of these writes `order = index over the full list`: dragging within a
  // filtered view would compute positions from rows that are not all the rows.
  // The handles disappear rather than misbehave.
  const canReorder = canEdit && !onlyDeadEnds
  // Same reason as above, for the plans rail: every reorder write computes
  // `order = index over the FULL list`, so dragging inside a filtered view would
  // position rows against rows that are not all the rows.
  const canReorderPlans = canReorder && !planSource

  async function reorderActivities(section: Activity[], from: number, to: number) {
    if (from === to) return
    const full = reorderWithinSection(activities, section, from, to)
    const batch = writeBatch(db)
    full.forEach((a, i) => {
      if (a.order !== i) batch.update(doc(db, ACTIVITIES_COLLECTION, a.id), { order: i })
    })
    await batch.commit()
    refreshQueries(qc, ['activities'])
  }

  async function reorderPlans(from: number, to: number) {
    if (from === to || !currentTeamId) return
    const next = reorderWithinSection(plans, plans, from, to)
    const batch = writeBatch(db)
    next.forEach((st, i) => {
      if (st.order !== i) {
        batch.update(
          doc(db, TEAMS_COLLECTION, currentTeamId, SUBSCRIPTION_TYPES_SUBCOLLECTION, st.id),
          { order: i }
        )
      }
    })
    await batch.commit()
    await qc.invalidateQueries({ queryKey: ['subscription-types', currentTeamId] })
  }

  /** An open class carries neither facet — see `activityPlanFacets`, which is
   *  where that is decided, so this screen cannot drift from the write path. */
  const selectedActivity =
    selection?.kind === 'activity' ? activities.find((a) => a.id === selection.id) : undefined
  /** An open class carries neither facet — see `activityPlanFacets`. Used for
   *  the SUMMARY line only; what to render is the pricing form's decision.
   *
   *  CLASSES ONLY, and the guard is load-bearing. An APPOINTMENT has no access
   *  facet either (the price is the gate), so the bare facet test called every
   *  appointment "Open to everyone — no plan needed to book it" — wrong on a
   *  priced one, and it shadowed `summaryAppointment` so completely that the
   *  message was unreachable. Plainly false now that a plan can include, cut or
   *  fix the price of each length. */
  const openActivity =
    !!selectedActivity &&
    !isAppointmentActivity(selectedActivity) &&
    !activityPlanFacets(selectedActivity).access
  const selectedCourse =
    selection?.kind === 'course' ? courses.find((c) => c.id === selection.id) : undefined
  const selectedPlan =
    selection?.kind === 'plan' ? plans.find((p) => p.id === selection.id) : undefined
  const selectedProduct =
    selection?.kind === 'product' ? products.find((p) => p.id === selection.id) : undefined

  // ── the way back ──
  // Same markup as the course and document detail pages, but the target is NOT
  // a fixed parent: this page has TWO of them. It is reached from Activities,
  // from Subscriptions, from either editor's dialog and from a pricing warning,
  // and it has no nav row of its own — so the sidebar cannot be the way back the
  // way it is everywhere else, and a hardcoded parent would be wrong for half
  // of the arrivals.
  //
  // Following the SELECTION is deterministic, never leaves the app (unlike
  // history.back() on a deep link), and matches what the studio was just
  // looking at: a plan in the pane means Subscriptions is where they came from,
  // or at least where they were thinking.
  const backToPlans = selection?.kind === 'plan'

  return (
    <div className="space-y-6">
      {/* THE DECK — the page's own header, pinned on a desktop.
          The tab strip is this page's primary control now, and scrolling it away
          undoes the point of lifting it out of the rail. Everything above the
          panels rides with it: title, related links, the dead-end banner, strip.

          `lg` and up only. On a phone the strip already hides once a detail is
          open, and a pinned deck would spend scarce vertical space on a header
          for a screen that is showing exactly one thing.

          The negative margins bleed the background out to the layout wrapper's
          own padding (`px-4 sm:px-6`), so content scrolling under the deck does
          not show through at its edges. */}
      <div
        ref={deckRef}
        className="relative lg:sticky lg:top-0 lg:z-20 lg:-mx-6 lg:-mt-6 lg:bg-background lg:px-6 lg:pt-6"
      >
      <PageHeader
        title={t('title')}
        back={{
          href: (backToPlans ? '/offer/plans' : '/offer/activities') as Route,
          label: backToPlans ? t('backToSubscriptions') : t('backToActivities'),
        }}
        // NO SUBTITLE. "What you offer, and which plans open it" restated the
        // page title in a longer sentence, above a screen that demonstrates the
        // same thing in the first second of looking at it (Franco, 2026-08-31).
        // The related links are what this page CANNOT answer about itself:
        // what everything costs, when it actually runs, and the one sellable
        // thing that has no catalogue row at all.
        //
        // "All activities" was not one of those — the Activities tab is right
        // there, so the link led out of the page to a subset of it. Gift cards
        // take its place: a studio sells them, but there is nothing here to
        // list, because a gift card is a CONFIG (`settings.giftCards` — enabled
        // plus the denominations) and then a ledger of issued codes. Neither is
        // a catalogue item, so it is a link rather than a tab (Franco,
        // 2026-09-01).
        // Places and Payment settings join them for the same reason: both are
        // things a studio reaches for WHILE filling this page in — a class needs
        // a room that does not exist yet, and a price needs a gateway before it
        // can be charged — and neither is a catalogue row, so neither can be a
        // tab (Franco, 2026-09-02). Labels come from `Nav`, so the shortcut and
        // the sidebar row it leads to can never drift apart.
        quickLinks={[
          { href: '/manage/pricing' as Route, label: t('toPricing') },
          { href: '/schedule' as Route, label: t('toSchedule') },
          { href: '/schedule/places' as Route, label: tNav('places') },
          { href: '/settings/team?tab=payments' as Route, label: tNav('teamPayments') },
          { href: '/payments?tab=giftCards' as Route, label: t('toGiftCards') },
        ]}
        // CREATE BELONGS TO THE ACTIVE TAB. One button that makes whatever the
        // rail is currently listing — the catalogue could not make anything at
        // all before, which was the one thing its own pages still had to be
        // opened for (Franco, 2026-09-02).
        //
        // Activities and plans open their dialog HERE, because this page
        // already mounts it for edit and duplicate. Courses and products link
        // to their own page instead: both gate creation on a per-plan cap and
        // own a bespoke first-step form, and a second copy of either is how the
        // two drift apart.
        action={
          canEdit ? (
            <CreateAction
              tabs={tabs}
              onOpen={setCreating}
              onDraftWithAi={aiDrafting ? () => setAiOpen(true) : undefined}
            />
          ) : undefined
        }
      />

      {/* The banner counts dead ends, and clicking it FILTERS THE RAIL rather
          than opening a report — the fix is in the pane beside it. */}
      {warnings.length > 0 && (
        <button
          type="button"
          onClick={() => setOnlyDeadEnds((v) => !v)}
          aria-pressed={onlyDeadEnds}
          className={`flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors ${
            onlyDeadEnds
              ? 'border-amber-500 bg-amber-500/10'
              : 'border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10'
          }`}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{t('deadEnds', { count: warnings.length })}</span>
            <span className="block text-xs text-muted-foreground">
              {onlyDeadEnds ? t('deadEndsClear') : t('deadEndsAction')}
            </span>
          </span>
        </button>
      )}

      {/* THE RAIL HOLDS ITS SIZE. Two `fr` tracks share free space, but an `fr`
          still floors at its content's min-content width — so a wide pane (the
          plan matcher is five columns and a set-all row) pushed the list of
          items narrower the moment you selected something, and the list moved
          under the cursor that had just clicked it.

          A fixed track for the rail, and `minmax(0,1fr)` for the pane: the zero
          minimum is what lets the pane shrink BELOW its content instead of
          shoving, which is also what makes its own overflow scrolling work
          (Franco, 2026-09-01). */}
      {/* THE TAB STRIP LIVES ABOVE BOTH PANELS, and it is not a small control.

          It governs the whole screen — switching tabs changes the rail AND
          clears a selection belonging to another tab, so the pane changes with
          it. Inside the rail it read as secondary, and it was spending the top
          of a 340px column that filters will want later.

          NO TILES. Four bordered cards made four boxes to look at before you
          could read any of them, and the borders were doing work the words
          already did. The icon and the word sit straight on the background,
          divided by hairlines, and ONLY THE ACTIVE ONE is marked — by colour and
          an underline, the two cheapest signals there are (Franco, 2026-09-02).

          Size is still the point: this is where a studio spends its first weeks
          setting the business up, and it should not look like one more of the
          thousand tiny settings controls an app like this accumulates. The room
          now comes from padding rather than from boxes.

          The COUNT turns a label into a fact worth glancing at ("6 activities,
          5 plans"). Zero still prints — "0 products" is exactly what a studio
          needs to see on the tab it has not filled in yet. */}
      {/* Space ABOVE as well as below: the related links sit directly over the
          strip, and on the page's default gap the two rows read as one block of
          links rather than a page header and the control under it.

          PADDING, not margin — the page is a `space-y-6` stack, whose
          `> * + *` rule outranks a `mt-*` on a child and silently wins. */}
      <div className={`mb-5 pt-4 ${selection ? 'hidden lg:block' : ''}`}>
        {/* LEFT-ALIGNED from `sm` up. Centred looked right with four tabs and
            wrong with two: a coach has only Activities and Plans, and two tabs
            centred in a full-width band read as stranded rather than composed —
            the strip has to hold for every plan, not the widest one (Franco,
            2026-09-02). Left, they start where every other row on the page
            starts.

            On a phone they stay full-width and equal (`flex-1`): four tabs
            share the width there, and a horizontally scrolling strip hides the
            very tab a studio is looking for. */}
        <div className="flex" role="tablist" aria-label={t('title')}>
          {tabs.map((tab, i) => {
            const on = tab.key === activeTab
            const dead = onlyDeadEnds ? (deadEndsPerTab[tab.key] ?? 0) : 0
            const TabIcon = tab.icon
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={on}
                // SWITCHING TABS CLEARS A SELECTION FROM ANOTHER ONE. The rail
                // and the pane are one screen making one statement, and a rail
                // of plans beside a pane of activity pricing is two (Franco,
                // 2026-09-02). A selection that BELONGS to the tab being opened
                // survives — going Plans → Activities → Plans should not lose
                // your place.
                onClick={() => {
                  setPickedTab(tab.key)
                  if (selection && TAB_FOR_KIND[selection.kind] !== tab.key) select(null)
                }}
                className={`group relative flex min-w-0 flex-1 flex-col items-center gap-1.5 px-2 py-3 transition-colors sm:min-w-[8rem] sm:flex-none sm:px-6 sm:py-3.5 ${
                  i > 0 ? 'border-l' : ''
                } ${on ? '' : 'hover:bg-muted/40'}`}
              >
                <TabIcon
                  className={`h-5 w-5 transition-colors ${
                    on ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                  }`}
                />
                {/* Four tabs share a phone's width, so the label takes the
                    smaller size there and truncates rather than letting the
                    strip overflow — a horizontally scrolling strip hides the
                    very tab a studio is looking for, on the width where that
                    matters most. */}
                <span
                  className={`max-w-full truncate text-xs leading-none transition-colors sm:text-sm ${
                    on ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground'
                  }`}
                >
                  {tab.label}
                </span>
                <span className="text-xs leading-none text-muted-foreground">{tab.count}</span>
                {/* The underline is the whole active state. It sits ON the
                    hairline row so the strip reads as one band rather than four
                    things, and it is inset by the padding so it underlines the
                    word rather than the gap beside it. */}
                <span
                  className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full transition-colors ${
                    on ? 'bg-primary' : 'bg-transparent'
                  }`}
                />
                {/* The dead-end count rides in the CORNER: inline it would sit
                    where the item count already is and the two numbers would be
                    read as one. */}
                {dead > 0 && (
                  <span className="absolute right-2 top-1.5 rounded-full bg-amber-500/20 px-1.5 text-[10px] leading-tight text-amber-700">
                    {dead}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        {/* The hairline the underline sits on — under the whole strip, so the
            unselected tabs are divided from the content too. */}
        <div className="border-b" />
      </div>

      {/* The same gradient the sidebar's scroll edge uses, so a pinned surface
          reads the same way in both places. It hangs BELOW the deck's box, which
          is why the deck is `relative`.

          DRAWN ONLY WHEN SOMETHING IS UNDER IT. The shadow's whole job is to say
          "there is more above"; at the top of the page that is false, and a
          permanent one turns into a decorative rule that reads as a border
          (Franco, 2026-09-02). Same fade the sidebar uses, for the same reason.

          FADED AT BOTH ENDS. Full-bleed, it stopped dead against the page
          margins — a hard vertical edge where a shadow should have none. The
          mask takes it to nothing over the last 2rem, so it reads as light
          falling off rather than as a bar that was cut. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-full hidden h-3 bg-gradient-to-b from-black/10 to-transparent transition-opacity duration-200 dark:from-black/40 lg:block [mask-image:linear-gradient(to_right,transparent,#000_2rem,#000_calc(100%-2rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,#000_2rem,#000_calc(100%-2rem),transparent)] ${
          deckScrolled ? 'opacity-100' : 'opacity-0'
        }`}
      />
      </div>

      {/* TWO PANELS ON A DESKTOP, TWO SCREENS ON A PHONE.
          Side by side is the point of this page — the whole reason it exists is
          showing plans against the activities they open — so `lg` and up keeps
          both and a selection is a focus change costing nothing to undo.

          Under `lg` they cannot coexist, and stacking them was a defect rather
          than a compromise: selecting a row left the detail starting ~700px down
          the page with no scroll, below the fold, at the top of a list, with
          nothing on screen saying anything had happened (measured at 375px,
          Franco, 2026-09-02). So on a phone the list IS the screen until you
          pick something, and then the detail is — with a back control, which is
          the affordance that makes it navigation rather than a disappearance. */}
      <div
        className="grid items-start gap-6 lg:grid-cols-[minmax(300px,340px)_minmax(0,1fr)]"
        style={{ '--deck-h': `${deckH}px` } as React.CSSProperties}
      >
        {/* ── the rail ── */}
        {/* NO CARD. Once the deck above is the raised surface, a bordered box
            around the list and another around the pane made three layers of
            framing for two panels. The list is a list; whitespace and one
            hairline separate its rows faster than borders would — the same
            reason the tab strip lost its tiles (Franco, 2026-09-02).

            PINNED, AND SCROLLING ITSELF. Sticky alone was not enough: a rail
            taller than the viewport would pin its top and put its own tail out
            of reach, so a studio with thirty activities could not get to the
            last one while a long pane scrolled beside it. `max-h` + overflow is
            what makes pinning safe. The PANE deliberately does not do this — it
            scrolls with the page, because at 1280x800 there are only ~550px
            below the deck and an 855px pane in a 550px window is harder to read
            than the page scroll it replaces. */}
        <div
          className={`space-y-3 lg:sticky lg:top-[var(--deck-h)] lg:max-h-[calc(100vh-var(--deck-h))] lg:overflow-y-auto lg:pb-4 lg:pr-1 ${
            selection ? 'hidden lg:block' : ''
          }`}
        >
          {/* KEYED ON THE TAB so the list announces that it CHANGED. Switching
              tabs swaps every row at once while the frame around them stays
              put, which without motion reads as a redraw rather than as a
              move — the same reason the pane slides when the selection changes
              (Franco, 2026-09-02).

              From the LEFT, where the pane comes from the right: the two
              panels then move away from each other rather than in convoy, so
              the direction says which half changed. */}
          <div
            key={activeTab}
            className="space-y-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-3 motion-safe:duration-200"
          >

          {/* ONE LINE PER TAB, printed, and INSIDE THE RAIL: it describes what
              the list below it holds, so it belongs with the list rather than
              with the cards that switch between them (Franco, 2026-09-02).

              It briefly lived behind an info mark to save the height; the mark
              cost more than the lines did — a studio had to know there was
              something to hover before it could tell them anything, which is the
              wrong trade for a sentence that orients somebody who has just
              arrived (Franco, 2026-09-01).

              Written as four literal keys rather than `t(`hint_${activeTab}`)`:
              `i18n:check` counts computed keys and never fails them, so a typo
              in one would ship silently. */}
          <p className="px-2 pt-1 text-xs leading-snug text-muted-foreground">
            {
              {
                activities: t('hintActivities'),
                plans: t('hintPlans'),
                courses: t('hintCourses'),
                products: t('hintProducts'),
              }[activeTab]
            }
          </p>

          {/* THE WAY OUT, on the two tabs that need one. A course and a product
              are only PRICED here — their content, media, variants and
              collections live on their own page, and the pane's Edit button is
              easy to miss when you have not selected a row yet. So the rail
              says where the rest of the job is, before the list rather than
              after it (Franco, 2026-09-02).
              Absent on activities and plans: nothing about either is edited
              anywhere else any more. */}
          {(activeTab === 'courses' || activeTab === 'products') && (
            <Link
              href={(activeTab === 'courses' ? '/manage/online-courses' : '/manage/products') as Route}
              className="mx-2 flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-solid hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1">
                {activeTab === 'courses' ? t('fullEditCourses') : t('fullEditProducts')}
              </span>
            </Link>
          )}


          {loading && (
            <div className="space-y-2 p-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-lg" />
              ))}
            </div>
          )}

          {!loading && activeTab === 'activities' && (
            <>
              {/* Classes and appointments stay SUB-HEADINGS, not tabs — same
                  kind of thing, one asymmetry worth seeing. See the header. */}
              {/* Classes and appointments reorder SEPARATELY, exactly as they do
                  on the activities page: they are two groups over one stored
                  list, and `reorderWithinSection` keeps a drag inside a group
                  from renumbering the other one. */}
              <RailGroup icon={Zap} label={t('railClasses')}>
                {visible(classes).length === 0 ? (
                  <RailEmpty text={onlyDeadEnds ? t('noneFiltered') : t('noClasses')} />
                ) : (
                  <OrderableRows
                    items={visible(classes)}
                    canReorder={canReorder}
                    onReorder={(from, to) => void reorderActivities(classes, from, to)}
                    renderRow={(a, sortable) => (
                      <RailRow
                        name={a.name}
                        detail={detailLine(activityChips(a))}
                        detailIcon={activityAccessIcon(a)}
                        color={a.color}
                        warn={deadEndIds.has(a.id)}
                        selected={selection?.kind === 'activity' && selection.id === a.id}
                        onClick={() => toggle('activity', a.id)}
                        sortable={sortable}
                        reorderLabel={t('reorder')}
                        edit={editOf('activity', a.id)}
                        editLabel={t('editAll')}
                      />
                    )}
                  />
                )}
              </RailGroup>

              <RailGroup icon={CalendarClock} label={t('railAppointments')}>
                {visible(appointments).length === 0 ? (
                  <RailEmpty text={onlyDeadEnds ? t('noneFiltered') : t('noAppointments')} />
                ) : (
                  <OrderableRows
                    items={visible(appointments)}
                    canReorder={canReorder}
                    onReorder={(from, to) => void reorderActivities(appointments, from, to)}
                    renderRow={(a, sortable) => (
                      <RailRow
                        name={a.name}
                        detail={detailLine(activityChips(a))}
                        detailIcon={activityAccessIcon(a)}
                        color={a.color}
                        warn={deadEndIds.has(a.id)}
                        selected={selection?.kind === 'activity' && selection.id === a.id}
                        onClick={() => toggle('activity', a.id)}
                        sortable={sortable}
                        reorderLabel={t('reorder')}
                        edit={editOf('activity', a.id)}
                        editLabel={t('editAll')}
                      />
                    )}
                  />
                )}
              </RailGroup>
            </>
          )}

          {!loading && activeTab === 'plans' && (
            <div className="space-y-2.5 p-1">
              {/* SOURCE CHIPS, and only once there is a mix to sort out. A studio
                  with nothing but its own plans would get a filter whose every
                  option is the whole list — a control that can only ever be a
                  no-op, occupying the top of the rail on the commonest setup. */}
              {plans.some((st) => st.source === 'aggregator') &&
                plans.some((st) => (st.source ?? 'internal') === 'internal') && (
                  <div className="flex flex-wrap gap-1.5 px-1">
                    {([null, 'internal', 'aggregator'] as const).map((val) => {
                      const on = planSource === val
                      return (
                        <button
                          key={val ?? 'all'}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setPlanSource(val)}
                          className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                            on
                              ? 'border-primary bg-primary/10 font-medium text-foreground'
                              : 'text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                          }`}
                        >
                          {/* Literal keys, never a template-literal one:
                              i18n:check counts computed keys and never fails
                              them. The two source labels are the SAME keys the
                              plan editor and the row chips use, so renaming a
                              source renames it everywhere at once. */}
                          {val === null
                            ? t('filterAll')
                            : val === 'internal'
                              ? tSet('subTypeSourceInternal')
                              : tSet('subTypeSourceAggregator')}
                        </button>
                      )
                    })}
                  </div>
                )}
              {visiblePlans.length === 0 ? (
                <RailEmpty text={planSource ? t('noneFiltered') : t('noPlans')} />
              ) : (
                <OrderableRows
                  items={visiblePlans}
                  canReorder={canReorderPlans}
                  onReorder={(from, to) => void reorderPlans(from, to)}
                  renderRow={(pl, sortable) => (
                    <RailRow
                      name={pl.name}
                      detail={detailLine(planChips(pl))}
                      selected={selection?.kind === 'plan' && selection.id === pl.id}
                      onClick={() => toggle('plan', pl.id)}
                      sortable={sortable}
                      reorderLabel={t('reorder')}
                      edit={editOf('plan', pl.id)}
                      editLabel={t('editAll')}
                    />
                  )}
                />
              )}
              {/* ALWAYS VISIBLE, not only on an empty rail: a studio adds a pack
                  in its second season as readily as its first, and a link that
                  disappears once there is one plan is a link nobody learns. */}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setTemplatesOpen(true)}
                  className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Sparkles className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" />
                  {tTpl('railLink')}
                </button>
              )}
            </div>
          )}

          {!loading && activeTab === 'courses' && (
            <div className="space-y-2.5 p-1">
              {visibleCourses.length === 0 ? (
                <RailEmpty text={onlyDeadEnds ? t('noneFiltered') : t('noCourses')} />
              ) : (
                visibleCourses.map((c) => (
                  <RailRow
                    key={c.id}
                    name={c.title}
                    detail={detailLine(courseChips(c))}
                    warn={deadEndIds.has(c.id)}
                    selected={selection?.kind === 'course' && selection.id === c.id}
                    onClick={() => toggle('course', c.id)}
                    edit={editOf('course', c.id)}
                    editLabel={t('editAll')}
                  />
                ))
              )}
            </div>
          )}

          {!loading && activeTab === 'products' && (
            <div className="space-y-2.5 p-1">
              {/* NEVER filtered by the dead-end banner: no health code is ever
                  raised for a product (it has no access rule to be wrong), so
                  filtering would empty the tab and imply the opposite. */}
              {products.length === 0 ? (
                <RailEmpty text={t('noProducts')} />
              ) : (
                products.map((p) => (
                  <RailRow
                    key={p.id}
                    name={p.name}
                    detail={detailLine(productChips(p))}
                    selected={selection?.kind === 'product' && selection.id === p.id}
                    onClick={() => toggle('product', p.id)}
                    edit={editOf('product', p.id)}
                    editLabel={t('editAll')}
                  />
                ))
              )}
            </div>
          )}
          </div>
        </div>

        {/* ── the pane ── */}
        {/* NO SELECTION, NO PANE — not an empty card, and not a placeholder.
            It briefly held an "At a glance" summary of the tab; a studio does
            not come here to read counts, and it put a second thing in motion
            every time the tab changed, which is one more than a tab change
            should move (Franco, 2026-09-02).

            The rail keeps its 340px track either way, so nothing shifts under
            the cursor that just clicked it — see THE RAIL HOLDS ITS SIZE.

            THE PANE IS A CARD when it is here. It is a settings surface — a
            stack of fields, switches and a table — and a panel of controls
            floating on the page background has no edge saying where the form
            starts and the page ends. */}
        {selection && (
        <div className="rounded-xl border bg-card p-4">
          {/* THE PANE DOES NOT SLIDE. Only the rail does.

              Both moving made a tab change animate two halves of the screen for
              one action, and even on a selection the pane arriving from the
              right competed with the row lighting up on the left — two things
              saying "look here" about the same click (Franco, 2026-09-02).

              So the motion belongs to the LIST, which is the half that actually
              changes wholesale; the pane just appears with whatever the list
              now points at. */}
          {/* THE WAY BACK, on a phone only. On a desktop the list never left,
              so a back control there would undo something that never happened
              — and it would compete with clicking another row, which is how a
              studio actually moves between items. */}
          {selection && (
            <button
              type="button"
              onClick={() => select(null)}
              className="mb-3 -ml-1 flex items-center gap-1 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground lg:hidden"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('backToList')}
            </button>
          )}

          {selectedActivity && (
            <PaneBody
              key={selectedActivity.id}
              title={selectedActivity.name}
              badge={
                isAppointmentActivity(selectedActivity) ? t('appointmentBadge') : t('classBadge')
              }
              summary={
                openActivity
                  ? t('summaryClassOpen')
                  : isAppointmentActivity(selectedActivity)
                    ? t('summaryAppointment', { plans: anyRatedPlanIds(selectedActivity).length })
                    : t('summaryClass', {
                        gated: gatedPlanIds(selectedActivity).length,
                        rated: ratedPlanIds(selectedActivity).length,
                      })
              }
              facts={{
                chips: activityChips(selectedActivity),
                description: selectedActivity.description,
              }}
              actions={paneActionsFor('activity', selectedActivity.id)}
              extraTabs={
                currentTeamId && user
                  ? (['details', 'booking'] as const).map((section) => ({
                      key: section,
                      label: section === 'details' ? t('paneTabDetails') : t('paneTabBooking'),
                      content: (
                        <ActivityDialog
                          // Keyed by the record AND the section so switching
                          // rows remounts each form rather than leaving the
                          // previous one's draft in it.
                          key={`${section}-${selectedActivity.id}`}
                          inline
                          section={section}
                          open
                          onClose={() => {}}
                          teamId={currentTeamId}
                          userId={user.uid}
                          editing={selectedActivity}
                          duplicating={null}
                          nextOrder={activities.length}
                          currency={currency}
                        />
                      ),
                    }))
                  : undefined
              }
            >
              {/* ALWAYS MOUNTED, and the guard that used to sit here was a dead
                  end. It hid this whole form for an OPEN class, which is the
                  one kind that has no other route out: the tier switch lives
                  inside it, so an open activity could not be made anything else
                  from anywhere in the product (Franco, 2026-09-01). Only the
                  MATCHER is conditional, and that decision belongs inside the
                  form, next to the switch that changes it. */}
              <ActivityPricingForm
                activity={selectedActivity}
                plans={plans}
                currency={currency}
                canEdit={canEdit}
              />
            </PaneBody>
          )}

          {selectedPlan && (
            <PaneBody
              key={selectedPlan.id}
              title={selectedPlan.name}
              summary={t('summaryPlan', {
                count:
                  activities.filter(
                    (a) =>
                      gatedPlanIds(a).includes(selectedPlan.id) ||
                      anyRatedPlanIds(a).includes(selectedPlan.id)
                  ).length +
                  courses.filter(
                    (c) =>
                      courseGatedPlanIds(c).includes(selectedPlan.id) ||
                      courseRatedPlanIds(c).includes(selectedPlan.id)
                  ).length,
              })}
              facts={{
                chips: planChips(selectedPlan),
                description: selectedPlan.description,
              }}
              actions={paneActionsFor('plan', selectedPlan.id)}
              extraTabs={
                currentTeamId
                  ? [{ key: 'details', label: t('paneTabDetails'), content: (
                  <SubTypeDialog
                    key={`details-${selectedPlan.id}`}
                    inline
                    open
                    onOpenChange={() => {}}
                    teamId={currentTeamId}
                    editing={selectedPlan}
                    duplicating={null}
                    currency={currency}
                    nextOrder={plans.length}
                    onSaved={() => {
                      void qc.invalidateQueries({ queryKey: ['subscription-types', currentTeamId] })
                      void qc.invalidateQueries({ queryKey: ['activities'] })
                    }}
                  />
                ) },
                     {
                       key: 'automations',
                       label: t('paneTabAutomations'),
                       content: (
                         <SubscriptionAutomationsSection
                           teamId={currentTeamId}
                           subscriptionType={selectedPlan}
                         />
                       ),
                     }]
                  : undefined
              }
            >
              {/* PRICES FIRST, then what they open. A plan is a price and a
                  promise, and the promise means nothing until the price is
                  real — so the money reads top-down into the matcher rather
                  than sitting behind it. */}
              {currentTeamId && (
                <PlanPricingForm
                  plan={selectedPlan}
                  teamId={currentTeamId}
                  currency={currency}
                  canEdit={canEdit}
                  // The matcher goes INSIDE the form, as it does on an
                  // activity, so the tab has one Save rather than two — see
                  // `saveHandle` on ActivityPlanLinks.
                  links={(p) => (
                    <ActivityPlanLinks
                      direction="from-plan"
                      plan={selectedPlan}
                      offerings={allOfferings}
                      plans={plans}
                      currency={currency}
                      canEdit={canEdit}
                      {...p}
                    />
                  )}
                />
              )}
            </PaneBody>
          )}

          {selectedCourse && (
            <PaneBody
              key={selectedCourse.id}
              title={selectedCourse.title}
              badge={t('courseBadge')}
              summary={t(
                selectedCourse.accessRule?.type === 'purchase'
                  ? 'summaryCoursePriced'
                  : selectedCourse.accessRule?.type === 'subscription'
                    ? 'summaryCourseGated'
                    : 'summaryCourseOpen',
                {
                  plans:
                    courseGatedPlanIds(selectedCourse).length +
                    courseRatedPlanIds(selectedCourse).length,
                }
              )}
              facts={{
                chips: courseChips(selectedCourse),
                // `summary`, not `description`: a course's blurb is its summary.
                description: selectedCourse.summary,
              }}
              actions={paneActionsFor('course', selectedCourse.id)}
            >
              <ActivityPlanLinks
                direction="from-offering"
                offering={toCourseOffering(selectedCourse)}
                offerings={allOfferings}
                plans={plans}
                currency={currency}
                canEdit={canEdit}
              />
            </PaneBody>
          )}

          {selectedProduct && (
            <PaneBody
              key={selectedProduct.id}
              title={selectedProduct.name}
              badge={t('productBadge')}
              summary={t('summaryProduct')}
              facts={{
                chips: productChips(selectedProduct),
                description: selectedProduct.description,
                // WHERE THE EDGE EDITOR WOULD BE, the pane says why there is
                // none. A product carries no access rule and no benefit, so no
                // plan can open it — that is a fact about the model, not a gap
                // in this screen, and leaving the space blank would read as the
                // latter. ONE SENTENCE: it explained the reasoning as well as
                // the fact, and the fact is the part a studio needs.
                note: t('productNoPlanEdge'),
              }}
              actions={paneActionsFor('product', selectedProduct.id)}
            />
          )}

          {/* Selected, but gone — a stale deep link, or something archived in
              another tab. Saying so beats an empty pane that looks like a bug. */}
          {selection &&
            !selectedActivity &&
            !selectedCourse &&
            !selectedPlan &&
            !selectedProduct &&
            !loading && (
              <div className="space-y-2 px-4 py-12 text-center">
                <p className="text-sm text-muted-foreground">{t('paneMissing')}</p>
                <Button variant="outline" size="sm" onClick={() => select(null)}>
                  {t('paneMissingAction')}
                </Button>
              </div>
            )}
        </div>
        )}
      </div>

      {aiDrafting && currentTeamId && (
        <AiDraftDialog
          open={aiOpen}
          onOpenChange={setAiOpen}
          teamId={currentTeamId}
          currency={currency}
          // The records exist by the time this runs — the applier commits one
          // batch — so the rail only has to re-read.
          onApplied={() => refreshQueries(qc, ['activities'], ['subscription-types'])}
        />
      )}

      {/* THE EDITORS. Keyed by the record so reopening on a different one
          remounts the form rather than leaving the previous draft in it — the
          same key both list pages use. `currentTeamId` and `user` gate the
          activity form because it writes with both. */}
      {currentTeamId && user && creating === 'activity' && (
        <ActivityDialog
          key="new-activity"
          open
          onClose={() => setCreating(null)}
          teamId={currentTeamId}
          userId={user.uid}
          editing={null}
          duplicating={null}
          nextOrder={activities.length}
          currency={currency}
          onCreated={(id) => select({ kind: 'activity', id })}
        />
      )}

      {currentTeamId && creating === 'plan' && (
        <SubTypeDialog
          key="new-plan"
          open
          onOpenChange={(v) => !v && setCreating(null)}
          teamId={currentTeamId}
          editing={null}
          duplicating={null}
          currency={currency}
          nextOrder={plans.length}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['subscription-types', currentTeamId] })
            void qc.invalidateQueries({ queryKey: ['activities'] })
          }}
        />
      )}

      {currentTeamId && user && duplicatingActivity && (
        <ActivityDialog
          key={`dup-${duplicatingActivity.id}`}
          open
          onClose={() => setDuplicatingActivity(null)}
          onCreated={(id) => select({ kind: 'activity', id })}
          teamId={currentTeamId}
          userId={user.uid}
          editing={null}
          duplicating={duplicatingActivity}
          nextOrder={activities.length}
          currency={currency}
        />
      )}

      {currentTeamId && duplicatingPlan && (
        <SubTypeDialog
          key={`dup-${duplicatingPlan.id}`}
          open
          onOpenChange={(v) => !v && setDuplicatingPlan(null)}
          teamId={currentTeamId}
          editing={null}
          duplicating={duplicatingPlan}
          currency={currency}
          nextOrder={plans.length}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['subscription-types', currentTeamId] })
            void qc.invalidateQueries({ queryKey: ['activities'] })
          }}
        />
      )}

      {currentTeamId && (
        <PlanTemplatesDialog
          open={templatesOpen}
          onOpenChange={setTemplatesOpen}
          teamId={currentTeamId}
          existingCount={plans.length}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ['subscription-types', currentTeamId] })
          }}
        />
      )}

      <ActivityScheduleSheet
        activity={schedulePreview}
        open={!!schedulePreview}
        onOpenChange={(v) => {
          if (!v) setSchedulePreview(null)
        }}
        teamId={currentTeamId ?? ''}
      />

      {/* NEVER STRAIGHT AWAY. One dialog for all four kinds, because the
          question is the same one and only the verb and the noun change. */}
      <AlertDialog open={!!confirming} onOpenChange={(v) => !v && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.mode === 'archive' ? t('archiveAction') : t('deleteAction')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming
                ? t(confirming.mode === 'archive' ? 'archiveConfirm' : 'deleteConfirm', {
                    name: confirming.name,
                  })
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirming?.mode === 'delete'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : undefined
              }
              onClick={() => void runDestroy()}
            >
              {confirming?.mode === 'archive' ? t('archiveAction') : t('deleteAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {currentTeamId && user && editingActivity && (
        <ActivityDialog
          key={editingActivity.id}
          open
          onClose={() => setEditingActivity(null)}
          teamId={currentTeamId}
          userId={user.uid}
          // The LIVE document, re-read from the query on every render — the plan
          // editor inside the form writes `accessRule` on this same doc, so a
          // snapshot taken when the dialog opened would have Save write the
          // pre-edit allow-list back over it.
          editing={activities.find((a) => a.id === editingActivity.id) ?? editingActivity}
          duplicating={null}
          nextOrder={activities.length}
          currency={currency}
        />
      )}

      {currentTeamId && editingPlan && (
        <SubTypeDialog
          key={editingPlan.id}
          open
          onOpenChange={(v) => !v && setEditingPlan(null)}
          teamId={currentTeamId}
          editing={plans.find((pl) => pl.id === editingPlan.id) ?? editingPlan}
          duplicating={null}
          currency={currency}
          nextOrder={plans.length}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['subscription-types', currentTeamId] })
            void qc.invalidateQueries({ queryKey: ['activities'] })
          }}
        />
      )}
    </div>
  )
}

/**
 * The pane's frame: the name, a one-line summary, the facts, an Edit button and
 * the edge editor below.
 *
 * ── NO INLINE RENAME ────────────────────────────────────────────────────────
 * The name used to be editable here, on the reasoning that a pane showing a name
 * but unable to change it sends you to a modal for the commonest small edit
 * there is. That was the wrong trade (Franco, 2026-08-31): it put a second,
 * quieter way to change one field beside a button that changes all of them, so
 * the screen had two edit affordances with different scopes and no way to tell
 * from looking which one a given change needed. One Edit, and it opens the
 * editor that owns the whole record.
 *
 * ── EDIT IS PRIMARY ─────────────────────────────────────────────────────────
 * It was an outline button, which is what you use for the SECOND action on a
 * screen. There is no first one here: this pane reads, and the only thing it
 * does is send you to the form. Primary, with the pencil, because the thing it
 * competes with for attention is the edge grid below it — which saves itself.
 *
 * Edit deep-links: it lands on the owning page AND opens that entity's editor
 * (`?edit=<id>`). Sending the studio to a list page with the row somewhere on
 * it is the shape UX-99 is about — a page naming a destination and then making
 * you look for it.
 */
function PaneBody({
  title,
  badge,
  summary,
  facts,
  actions,
  extraTabs,
  children,
}: {
  title: string
  badge?: string
  summary: string
  /** What the list page would show on this thing's row — see OfferFacts. */
  facts?: OfferFactsProps
  /** The icon row. Empty for a reader who cannot edit — see PaneAction. */
  actions?: PaneAction[]
  /**
   * The tabs BESIDE the main one, in order. Empty or absent means no strip at
   * all: a course and a product are edited on their own page, so their pane
   * has one thing in it and a strip of one tab would be a lie about there
   * being a choice.
   */
  extraTabs?: { key: string; label: string; content: React.ReactNode }[]
  /** The edge editor. ABSENT for a product, which has no edge — the facts block
   *  says so in its `note` rather than leaving a gap that reads as a bug. */
  children?: React.ReactNode
}) {
  const t = useTranslations('OfferCatalogue')
  const { dirty, report } = usePaneDirtyState()

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{title}</h2>
            {badge && (
              <Badge variant="outline" className="text-xs font-normal">
                {badge}
              </Badge>
            )}
            {/* Beside the NAME, because that is what a studio is looking at
                when they wonder whether they still owe a save — the button is
                a scroll away past the plan table. */}
            {dirty && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                {t('unsaved')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{summary}</p>
        </div>
        {actions && actions.length > 0 && (
          /* EDIT IS NOT AN ICON. The rest are: they name an operation on this
             record, and the icon carries it. Edit is different — the pane now
             shows so much (facts, prices, the plan table) that a small pencil
             among three others read as "one more of those" rather than "there
             is a whole other half of this thing", which is the name, the
             description, the colour, the prose (Franco, 2026-09-01).

             So it sits BELOW the icon row, labelled, in the same place on every
             kind. The icons stay icon-only — three same-shaped verbs where
             position teaches faster than repeated words. */
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="flex items-center gap-0.5">
              {actions
                .filter((a) => a.key !== 'edit')
                .map((a) => {
                  const Icon = a.icon
                  const cls = `rounded p-1.5 text-muted-foreground transition-colors ${
                    a.danger ? 'hover:text-destructive' : 'hover:text-foreground'
                  } hover:bg-muted`
                  // A STYLED tooltip, not `title=`: these are icon-only, so
                  // the label is the only thing that says what the button does
                  // — and the browser's own tooltip waits a second, cannot be
                  // read by a keyboard, and never appears on touch.
                  return (
                    <Tip key={a.key} label={a.label}>
                      {'href' in a ? (
                        <Link href={a.href} className={cls} aria-label={a.label}>
                          <Icon className="h-4 w-4" />
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={a.run}
                          className={cls}
                          aria-label={a.label}
                        >
                          <Icon className="h-4 w-4" />
                        </button>
                      )}
                    </Tip>
                  )
                })}
            </div>
            {/* Edit stays a BUTTON only where the editor is somewhere else — a
                course and a product are edited on their own page. Where the
                fields are right here under a tab, a button labelled "Edit"
                beside them said the visible fields were not editing, which was
                false, and gave no hint of what it hid (Franco, 2026-09-02). */}
            {(extraTabs?.length ? [] : actions.filter((a) => a.key === 'edit')).map((a) =>
                'href' in a ? (
                  <Link
                    key={a.key}
                    href={a.href}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    <Pencil className="mr-1.5 h-3.5 w-3.5" />
                    {t('editDetails')}
                  </Link>
                ) : (
                  <Button key={a.key} variant="outline" size="sm" onClick={a.run}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" />
                    {t('editDetails')}
                  </Button>
                )
              )}
          </div>
        )}
      </div>

      {/* THE FACTS, above the hairline: they belong to the header — what this
          thing IS — while everything below the line is what it CONNECTS to. */}
      {facts && <OfferFacts {...facts} />}

      <PaneDirtyProvider report={report}>
        {extraTabs?.length ? (
          <PaneTabs main={children} extra={extraTabs} />
        ) : (
          children && <div className="border-t pt-4">{children}</div>
        )}
      </PaneDirtyProvider>
    </div>
  )
}

/**
 * TWO TABS, NOT MORE.
 *
 * The pane holds two different questions — what this costs and who it is for,
 * and what the thing itself is. Splitting the second further would trade one
 * hunt for another: a name, a colour, the prose and the session lengths are all
 * "what this is", and a studio reads them together.
 *
 * Booking and pricing leads because it is the one asked most often, and it is
 * where the plan matcher lives.
 */
function PaneTabs({
  main,
  extra,
}: {
  main?: React.ReactNode
  extra: { key: string; label: string; content: React.ReactNode }[]
}) {
  const t = useTranslations('OfferCatalogue')
  const [tab, setTab] = useState('main')
  // AN UNDERLINE, not pills — the same shape the contact detail page uses for
  // its tabs. The rail above already spends a filled pill strip on choosing
  // WHAT you are looking at, and a second filled strip choosing which half of
  // it read as two controls of equal weight competing on one screen.
  const tabCls = (on: boolean) =>
    `-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
      on
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`
  return (
    <div className="pt-1">
      {/* NO RULE ABOVE THE STRIP. The tabs' own underline is already a
          horizontal line; a second one two pixels above it drew a box around
          nothing. */}
      <div className="mb-3 flex gap-1 overflow-x-auto border-b" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'main'}
          onClick={() => setTab('main')} className={tabCls(tab === 'main')}>
          {t('paneTabAccess')}
        </button>
        {extra.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={tab === x.key}
            onClick={() => setTab(x.key)} className={tabCls(tab === x.key)}>
            {x.label}
          </button>
        ))}
      </div>
      {/* EVERY TAB STAYS MOUNTED. Each is a form that may hold unsaved input,
          and unmounting the one you tabbed away from would throw it away
          without saying so. */}
      <div className={tab === 'main' ? '' : 'hidden'}>{main}</div>
      {extra.map((x) => (
        <div key={x.key} className={tab === x.key ? '' : 'hidden'}>
          {x.content}
        </div>
      ))}
    </div>
  )
}

function RailGroup({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ElementType
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <SectionHeading level="eyebrow" icon={Icon} title={label} className="px-2 pb-1.5 pt-2" />
      {/* Cards need a real gap, not a hairline's worth of space — at
          `space-y-1` twenty bordered rows read as one striped block, and the
          eye has to find each boundary instead of being handed it. */}
      <div className="space-y-2.5">{children}</div>
    </div>
  )
}

/**
 * One row of the rail — a select target, and (where the list is orderable) a
 * drag handle beside it.
 *
 * THE HANDLE IS ITS OWN BUTTON, not the row. Two reasons, and the first is not
 * negotiable: a `<button>` inside a `<button>` is invalid, so the row cannot
 * both be the select target and carry the drag listeners. The second is that
 * dragging and selecting are different intents on the same pixels — making the
 * whole row draggable means every mis-drag also changes what the pane is
 * showing. Same shape the activities and subscription lists already use.
 */
/**
 * One row of the rail: a drag handle where the list is orderable, a two-line
 * select target, and an edit shortcut that appears on hover.
 *
 * ── TWO LINES ───────────────────────────────────────────────────────────────
 * The rail was one name per row, which was all it had space for while it stacked
 * four groups. Tabs gave it the height back, so the row now carries the same
 * summary the pane does (price, access, state) — enough to pick the right thing
 * WITHOUT selecting each one to find out, which is the whole job of a list you
 * scan. Exactly one detail line: a third would make the list a second copy of
 * the pane, and then the pane is the redundant one.
 *
 * ── THREE CONTROLS, THREE BUTTONS ───────────────────────────────────────────
 * The handle and the edit shortcut are siblings of the select target, not
 * children: a `<button>` inside a `<button>` is invalid, and all three are
 * different intents on the same row. The edit shortcut is hidden until hover or
 * KEYBOARD FOCUS — `focus-visible:opacity-100` is not decoration, it is the only
 * thing that keeps it reachable without a mouse.
 */
function RailRow({
  name,
  detail,
  detailIcon: DetailIcon,
  color,
  warn,
  selected,
  onClick,
  sortable,
  reorderLabel,
  edit,
  editLabel,
}: {
  name: string
  /** The second line — see `detailLine` in the page. */
  detail?: string
  /** Leads the detail line, labelling the fact the line OPENS with. Only the
   *  activity rows pass one, and `activityChips` puts the access fact first for
   *  exactly that reason — an icon sitting next to a freeform tag would look
   *  like it labelled the tag. */
  detailIcon?: LucideIcon
  color?: string
  warn?: boolean
  selected: boolean
  onClick: () => void
  /** Present only when this list is orderable — see `canReorder` in the page. */
  sortable?: SortableRenderProps
  reorderLabel?: string
  /** What the pencil does — open a dialog, or go somewhere. Absent for a reader
   *  who cannot edit. */
  edit?: PaneAction
  editLabel?: string
}) {
  return (
    <div
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      // ONE CARD PER ITEM. The rail lost its wrapping card, and a bare list on
      // the page background gave each item no edge of its own — so a card each,
      // which also gives the selected one somewhere to put its state (Franco,
      // 2026-09-02).
      //
      // The border carries selection rather than a fill: on a card the fill
      // reads as a hover that got stuck, while a coloured edge reads as "this
      // one", and it survives the drag shadow without fighting it.
      className={`group flex items-center rounded-lg border bg-card transition-colors ${
        sortable?.isDragging ? 'shadow-lg' : ''
      } ${
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
          : 'hover:border-muted-foreground/30 hover:bg-muted/40'
      }`}
    >
      {sortable && (
        <button
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          aria-label={reorderLabel}
          // `touch-none` is what makes this work on a phone at all: without it
          // the browser claims the gesture for scrolling before the sensor sees
          // it.
          className="shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground/50 transition-colors hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}

      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        // ROOM TO SCAN. Two lines of text in `py-1.5` made a rail of twenty
        // items one dense block; the eye needs a gap to find the boundary
        // between rows, and the name is doing the work now that it has weight.
        // Loosened again once each row became a card — a border makes tight
        // padding read as cramped where whitespace alone did not (Franco,
        // 2026-09-02).
        className={`flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-2.5 py-3 text-left ${
          selected ? 'text-primary' : ''
        }`}
      >
        {color !== undefined && (
          <span
            className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: color || DEFAULT_ACCENT }}
          />
        )}
        <span className="min-w-0 flex-1">
          {/* THE NAME CARRIES THE ROW. It was `text-sm` with no weight, one
              step from the muted detail line under it, so a rail of twenty
              items read as twenty pairs of similar-looking lines rather than a
              list of names with notes attached (Franco, 2026-09-02). */}
          <span className="block truncate text-[15px] font-semibold leading-tight">{name}</span>
          {detail && (
            <span className="mt-1 flex items-center gap-1 text-[11px] leading-tight text-muted-foreground">
              {DetailIcon && <DetailIcon className="h-3 w-3 shrink-0" aria-hidden />}
              {/* `truncate` stays on the TEXT, not on the row: hung on the flex
                  parent it would clip the icon first and leave the words the
                  ellipsis was meant to protect. */}
              <span className="truncate">{detail}</span>
            </span>
          )}
        </span>
        {warn && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />}
      </button>

      {edit && (
        <EditPencil edit={edit} label={editLabel} />
      )}
    </div>
  )
}

/**
 * A rail list that is orderable, or the same list that is not.
 *
 * The branch is here rather than at each call site because there are three of
 * them and the difference is one wrapper: with `canReorder` the rows sit in a
 * `SortableList` and each gets its handle props; without it they render plain.
 * Writing that out three times is how one of them ends up still draggable while
 * the dead-end filter is on — which would reorder the whole collection from a
 * subset of it.
 */
/**
 * THE GAP LIVES IN BOTH BRANCHES, and it must match `RailGroup`'s.
 *
 * These divs sit INSIDE RailGroup's, so whatever they say wins. When the rail
 * moved to one card per item, RailGroup was loosened and these two were not —
 * which left every reorderable list tight while the plain ones breathed, and
 * that is exactly what shipped (Franco, 2026-09-02).
 */
function OrderableRows<T extends { id: string }>({
  items,
  canReorder,
  onReorder,
  renderRow,
}: {
  items: T[]
  canReorder: boolean
  onReorder: (from: number, to: number) => void
  renderRow: (item: T, sortable?: SortableRenderProps) => React.ReactNode
}) {
  if (!canReorder) {
    return (
      <div className="space-y-2.5">
        {items.map((item) => (
          <Fragment key={item.id}>{renderRow(item)}</Fragment>
        ))}
      </div>
    )
  }
  return (
    <SortableList ids={items.map((item) => item.id)} onReorder={onReorder}>
      <div className="space-y-2.5">
        {items.map((item) => (
          <SortableItem key={item.id} id={item.id}>
            {(sortable) => <>{renderRow(item, sortable)}</>}
          </SortableItem>
        ))}
      </div>
    </SortableList>
  )
}

/** The row's pencil. A BUTTON or a LINK depending on what editing this thing
 *  means — the two must look identical, because to the reader they are the same
 *  affordance and the difference is ours, not theirs. */
function EditPencil({ edit, label }: { edit: PaneAction; label?: string }) {
  const className =
    'mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100'
  return (
    <Tip label={label ?? ''}>
      {'run' in edit ? (
        <button
          type="button"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation()
            edit.run()
          }}
          className={className}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      ) : (
        <Link
          href={edit.href}
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          className={className}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Link>
      )}
    </Tip>
  )
}

function RailEmpty({ text }: { text: string }) {
  return <p className="px-2 py-1.5 text-xs text-muted-foreground">{text}</p>
}

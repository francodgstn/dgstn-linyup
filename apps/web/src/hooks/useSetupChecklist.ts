import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { collection, doc, getDoc, query, where, limit, getDocs, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { PUBLIC_PAGE_QR_PARAM } from '@/lib/onboarding'
import {
  ACTIVITIES_COLLECTION,
  SESSIONS_COLLECTION,
  CONTACTS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_MEMBERS_SUBCOLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  AUTOMATION_RULES_SUBCOLLECTION,
  type SaasPlan,
  type SocialLink,
  type Team,
  type TeamLink,
  type TeamPublicProfile,
  PUBLIC_PROFILE_SUBCOLLECTION,
} from '@linyup/shared'

/**
 * THE SETUP CHECKLIST — what a studio has to do before it can open its doors.
 *
 * ── TWO RULES, BOTH LEARNED FROM STEPS THAT WERE LYING ──────────────────────
 *
 * 1. **A STEP MUST BE ABLE TO BE FALSE.** "Publish your bio link" checked
 *    whether `teams/{id}/public_profile/{id}` existed — and
 *    `syncTeamPublicProfile` is an `onDocumentWritten('teams/{teamId}')`
 *    trigger, so that document exists from the instant the team is created. The
 *    step had never been false for any studio, ever. It also started every
 *    progress bar at 1/5 before anybody had done anything.
 *
 *    That is why the mirror is read for its FIELDS and never for its existence
 *    (see `publicPageHasContent`), and why "star a favourite" (label text since
 *    2026-08-29, UX-84 — it was "pin a shortcut") is an acknowledgement rather
 *    than a derived check: `NavPinsContext` seeds a default shortcut list, so a
 *    derived check there could never be false.
 *
 * 2. **A STEP'S CHECK MUST MEAN WHAT ITS LABEL SAYS.** "Schedule a session"
 *    ticked on the existence of any session — and `allowBooking` used to default
 *    to FALSE, so the step went green with the door shut. The old hook computed
 *    `sessionsNotActuallyBookable` as a "UX-2 interim" and no surface ever
 *    rendered it. The requirement is now IN the step: a future session that
 *    people can actually book. (A NEW session now opts in — see
 *    `components/sessions/SessionFormDialog.tsx`, where an edit or a duplicate
 *    still keeps whatever its source had — so the two no longer pull apart, but
 *    the step checks the door rather than trusting the default.)
 *
 * ── AND ONE ABOUT FRESHNESS, LEARNED FROM STEPS THAT WERE RIGHT BUT LATE ────
 *
 * A DERIVED STEP IS ONLY AS GOOD AS ITS LAST READ. Every derived fact below
 * comes from a cached query, and the guide that renders it is mounted by the
 * persistent `(auth)` layout — so its observer does NOT remount on a client-side
 * navigation. Until 2026-08-24 nothing invalidated this query either, and the
 * result was a studio adding an activity, or saving a class, and watching the
 * step stay open until some unrelated navigation happened to refetch. Two
 * mechanisms keep it honest now, and BOTH are needed:
 *
 *   INVALIDATION (`useInvalidateSetupChecklist`) — instant, for writes the
 *   browser makes itself.
 *
 *   A BOUNDED POLL — for writes it does NOT make. A recurring save writes one
 *   `session_series` doc and lets `generateRecurringSessions` materialise the
 *   occurrences server-side afterwards, so a refetch fired at the instant of
 *   save legitimately finds nothing. No invalidation can see that; only looking
 *   again can. It is bounded on both ends: it stops the moment there is nothing
 *   counted left to find, and it gives up `POLL_WINDOW_MS` after the last change
 *   to `factsSignature` — a primitive fingerprint of the counted facts, because
 *   the data REFERENCE cannot answer that question (see the effect that writes
 *   `lastChangeRef`) — so an unfinished tab left open all day cannot poll
 *   forever.
 *
 * ── THREE SECTIONS, AND ONLY TWO OF THEM COUNT ──────────────────────────────
 *
 *   offer   what you sell        counted
 *   doors   how people reach you counted
 *   extra   "Extra steps"        NOT counted — real work, but you can open
 *                                without it. Same argument as the dashboard
 *                                queue's housekeeping split. The label says
 *                                "extra" rather than naming a theme so that the
 *                                section itself explains why its rows are
 *                                missing from the count (Franco, 2026-08-23).
 *
 * ── TWO WAYS A STEP CAN END, AND THEY ARE NOT THE SAME ──────────────────────
 *
 * DERIVED (most steps): the studio did the thing, and we can see it. Cannot be
 * gamed, needs no new state, and is right wherever "leave it as it is" would be
 * a bad outcome — a bare public page, no activities.
 *
 * ACKNOWLEDGED (`ack`): the studio closes it by hand. Two kinds, because they
 * are two different sentences:
 *
 *   'skip'    "this does not apply to us" — a cash-only club never wants
 *             Stripe, a solo coach has nobody to invite. A permanent nag at
 *             somebody who has already decided is worse than no step at all.
 *   'review'  "I looked and it is right" — the only way a REVIEW step can end.
 *             There is nothing to observe about somebody having read a page,
 *             and inventing a signal would be the third lying step.
 *
 * An acknowledged step is drawn closed but visibly distinct from a completed
 * one; we never pretend they did the thing (Franco, 2026-08-23).
 *
 * ── PLAN-GATED STEPS STAY VISIBLE ───────────────────────────────────────────
 *
 * Signup provisions a STUDIO trial, so every studio meets the full list first.
 * When one later drops to Coach or Free, the steps their plan no longer
 * includes are not removed — they are muted, tagged, and stop counting. Removing
 * them would quietly rewrite what the product is while somebody is deciding
 * whether to pay for it.
 *
 * Ranks were here once and are not (UX-39): a martial-arts grading feature
 * advertised to every yoga studio that will never award one. Places were
 * considered and left out — the session form now prompts for one at the moment
 * a place is actually needed, which beats a fourth line here.
 */

/** The query key this hook owns. Nothing spells it inline. */
export const SETUP_CHECKLIST_KEY = 'setup-checklist'

/** The full key for one team's checklist. */
export const setupChecklistKey = (teamId: string | null) =>
  [SETUP_CHECKLIST_KEY, teamId] as const

/**
 * Ask the checklist to look again.
 *
 * WHERE IT BELONGS: on any write that can move a DERIVED step — an activity, a
 * subscription type, a session, an installed plugin, a team member, an automation
 * rule. Those are the facts `queryFn` below reads; anything else on this list
 * comes off the live team document (AuthContext's snapshot) and is already
 * instant, so `payments`, the acknowledgements, and the team-doc halves of
 * `bioLink` / `branding` need no call at all.
 *
 * A PAGE THAT REFRESHES ITSELF IS NOT EVIDENCE THIS IS UNNECESSARY. Where the
 * page already invalidates its own list, add this beside it; where the page's
 * list is a live `onSnapshot` and there is nothing of its own to invalidate
 * (`settings/plugins`), this is the only call there is. Being CACHED is what
 * makes the checklist need telling, and it always is.
 *
 * PREFIX MATCH, on purpose: the caller does not have to know the teamId, and the
 * dashboard's and How-to's observers of the same key refresh with the guide's —
 * they show the same numbers, so they must never show different ones.
 *
 * It cannot cover a write the browser does not make: a recurring save writes one
 * `session_series` doc and the occurrences are materialised server-side
 * afterwards, so there is nothing to find at the moment of the save. That is the
 * poll's job, not this one's — neither mechanism replaces the other.
 */
export function useInvalidateSetupChecklist() {
  const qc = useQueryClient()
  return useCallback(
    () => qc.invalidateQueries({ queryKey: [SETUP_CHECKLIST_KEY] }),
    [qc]
  )
}

/** How often the checklist looks again while a counted step is still open. */
const POLL_MS = 20_000

/**
 * How long the poll keeps going after the last time a COUNTED FACT changed.
 * The bound exists so an unfinished studio that leaves a tab focused all day
 * does not pay for a refetch every 20 seconds forever.
 *
 * What restarts it: a refetch whose `factsSignature` differs from the last one
 * (see below), or a fresh observer — a remount starts a new `lastChangeRef`. A
 * window focus or an invalidation restarts it only if it finds something
 * different; one that finds the same answers deliberately does not, because
 * "nothing has changed" is the exact condition the window was written to stop
 * paying for.
 */
const POLL_WINDOW_MS = 10 * 60 * 1000

export type SetupStepKey =
  | 'activities'
  | 'pricing'
  | 'sessions'
  | 'bioLink'
  | 'pricingReview'
  | 'payments'
  | 'branding'
  | 'bookingForm'
  | 'plugins'
  | 'coaches'
  | 'publicPages'
  | 'qrCodes'
  | 'automations'
  | 'paymentsReview'
  | 'shortcuts'

export type SetupSection = 'offer' | 'doors' | 'extra'

export interface SetupStep {
  key: SetupStepKey
  section: SetupSection
  done: boolean
  href: string
  /**
   * Never counted toward the bar. DERIVED from the section (`extra`), not
   * declared per step — two knobs that had to agree is one way for them to
   * disagree, and a step sitting in "Open the doors" while quietly not counting
   * would be unexplainable from the screen.
   */
  optional?: boolean
  /**
   * The step can be closed by hand, writing `setup_ack[key]`.
   *
   * TWO KINDS, because they are two different sentences and one label could not
   * say both. `'skip'` is "this does not apply to us" — a cash-only club, a solo
   * coach with nobody to invite. `'review'` is "I looked and it is right", which
   * is the ONLY way a review step can ever end: there is nothing to observe
   * about somebody having read a page.
   */
  ack?: 'skip' | 'review'
  /** Closed because the studio said it does not apply, not because they did it. */
  acknowledged?: boolean
  /** The plan this step needs. Below it the step is muted, tagged and uncounted. */
  requiresPlan?: SaasPlan
  /** Muted + uncounted: the current plan does not include this. */
  locked?: boolean
}

// Cheap existence check: read at most one doc from a top-level collection
// filtered by teamId.
async function teamCollectionHasAny(coll: string, teamId: string): Promise<boolean> {
  const snap = await getDocs(query(collection(db, coll), where('teamId', '==', teamId), limit(1)))
  return !snap.empty
}

async function subcollectionHasAny(teamId: string, sub: string, take = 1): Promise<number> {
  const snap = await getDocs(query(collection(db, TEAMS_COLLECTION, teamId, sub), limit(take)))
  return snap.size
}

/**
 * Is anything the studio sells actually PRICED?
 *
 * Two equality filters and no range, so the automatic single-field indexes
 * serve it — no composite index to add.
 */
async function hasPricedDropIn(teamId: string): Promise<boolean> {
  const snap = await getDocs(
    query(
      collection(db, ACTIVITIES_COLLECTION),
      where('teamId', '==', teamId),
      where('dropIn.enabled', '==', true),
      limit(1)
    )
  )
  return !snap.empty
}

/** A future session people can actually book — the thing "schedule a class" means. */
async function hasBookableFutureSession(teamId: string, nowTs: Timestamp): Promise<boolean> {
  const snap = await getDocs(
    query(
      collection(db, SESSIONS_COLLECTION),
      where('allowBooking', '==', true),
      where('teamId', '==', teamId),
      where('start', '>=', nowTs),
      limit(1)
    )
  )
  return !snap.empty
}

/** The public mirror of the team, read for its FIELDS — never for its existence. */
async function readPublicProfile(teamId: string): Promise<TeamPublicProfile | null> {
  const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId, PUBLIC_PROFILE_SUBCOLLECTION, teamId))
  return snap.exists() ? (snap.data() as TeamPublicProfile) : null
}

const filled = (value: string | null | undefined) => !!(value ?? '').trim()

/**
 * Does the public page say anything about this studio?
 *
 * ── IT READS BOTH DOCUMENTS, AND THAT IS THE FIX ────────────────────────────
 *
 * `/team/bio-link` writes the public mirror FIRST (team-member permission, and
 * it must succeed) and then updates the team doc as a non-fatal side effect —
 * because `teams/{id}` is owner-only. So a MANAGER's save genuinely publishes
 * the page while `team.links` / `team.socialLinks` never move. Reading the team
 * doc alone therefore made this step unreachable from its own page for every
 * manager, silently. It now asks both and takes either.
 *
 * FIELDS, NEVER THE DOC'S EXISTENCE (rule 1): `syncTeamPublicProfile` is an
 * `onDocumentWritten` trigger, so the mirror exists from the moment the team
 * does — but it is written with `description: ''` and mapped links, so every
 * field check below can still be false on a fresh team.
 *
 * A BARE PAGE LINK IS NOT CONTENT, and that is not an oversight — it is rule 1
 * again. `provisionTeam` (`lib/provisioning.ts`, `defaultLinks`) seeds every new
 * team with page links — "Book Now" carrying `target: 'booking'` and "Membership
 * Signup" carrying `target: 'signup'` — each with `url: ''`, and
 * `syncTeamPublicProfile` copies `target` straight into the mirror. So a
 * predicate that took `target` as evidence would be TRUE for every studio from
 * the instant its team document was written, and the counted step would start
 * green before anybody had opened the tab.
 *
 * What is left is what the studio itself had to type or upload: a URL on a link,
 * a description, an image, a social link. Every one of those is empty on a fresh
 * team, so this predicate can still be false.
 */
function publicPageHasContent(
  team: Team | null | undefined,
  profile: TeamPublicProfile | null | undefined
): boolean {
  if (filled(team?.description) || filled(profile?.description)) return true
  if (team?.profileImage || profile?.profileImage) return true
  const links: TeamLink[] = [...(team?.links ?? []), ...(profile?.links ?? [])]
  if (links.some((l) => filled(l.url))) return true
  const socials: SocialLink[] = [...(team?.socialLinks ?? []), ...(profile?.socialLinks ?? [])]
  if (socials.some((l) => filled(l.url))) return true
  return false
}

/**
 * Logo or colours — the LOOK, as opposed to `publicPageHasContent`'s WORDS.
 *
 * Reads the mirror too, for the same reason: the accent colour is picked on the
 * bio-link page, whose team-doc write a manager is not allowed to make.
 */
function hasBranding(
  team: Team | null | undefined,
  profile: TeamPublicProfile | null | undefined
): boolean {
  return !!(
    team?.profileImage ||
    team?.heroImage ||
    team?.bioLinkAccentColor ||
    profile?.profileImage ||
    profile?.heroImage ||
    profile?.bioLinkAccentColor
  )
}

export function useSetupChecklist(teamId: string | null, team?: Team | null, plan?: SaasPlan) {
  // The poll reads its two answers off refs written after render, so this
  // callback never has to change identity — see below for why that matters.
  const stopPollingRef = useRef(false)
  const lastChangeRef = useRef(Date.now())

  /**
   * BOTH ANSWERS COME OFF REFS, NEVER OFF THE CLOSURE — that is the part that
   * matters. `QueryObserver` CALLS this callback (`#computeRefetchInterval`) on
   * every `setOptions` and again on every query update, and acts on the VALUE it
   * returns, not on the callback's identity: `setOptions` restarts the timer only
   * when the returned number differs, and `onQueryUpdate` restarts it after each
   * fetch regardless. So a stale closure would be read as a live answer. The
   * stable `useCallback` identity is plain memoisation on top of that, not a
   * correctness requirement.
   *
   * IT RETURNS FALSE — and the observer then clears the interval and schedules
   * nothing — under exactly two conditions:
   *
   *   1. `stopPollingRef`: there is no counted step left open, or the studio put
   *      the guide away. Looking again could only cost reads.
   *   2. `POLL_WINDOW_MS` has passed since `factsSignature` last changed — i.e.
   *      every refetch in that whole span came back with the identical counted
   *      facts. Because the observer re-evaluates this after each poll's result
   *      lands, at most one further poll runs past the deadline.
   */
  const refetchInterval = useCallback(() => {
    if (stopPollingRef.current) return false
    if (Date.now() - lastChangeRef.current > POLL_WINDOW_MS) return false
    return POLL_MS
  }, [])

  const queryResult = useQuery({
    queryKey: setupChecklistKey(teamId),
    enabled: !!teamId,
    // ZERO, deliberately: an invalidation that is answered from a fresh cache
    // is an invalidation that did nothing, and this data is a handful of
    // `limit(1)` reads — cheap enough to be right rather than fast.
    staleTime: 0,
    refetchOnWindowFocus: true,
    // A hidden tab finds nothing worth the reads; coming back to it refetches
    // on focus anyway.
    refetchIntervalInBackground: false,
    refetchInterval,
    queryFn: async () => {
      const id = teamId as string
      const nowTs = Timestamp.now()
      const [
        activities,
        subscriptions,
        pricedDropIn,
        sessionsBookable,
        contacts,
        memberCount,
        installedPlugins,
        automations,
        publicProfile,
      ] = await Promise.all([
          teamCollectionHasAny(ACTIVITIES_COLLECTION, id),
          subcollectionHasAny(id, SUBSCRIPTION_TYPES_SUBCOLLECTION),
          hasPricedDropIn(id),
          hasBookableFutureSession(id, nowTs),
          // NOT a step any more — the product's whole model is that contacts
          // arrive by themselves, through booking, the signup surface and the
          // shop, so telling a studio to type one in teaches the opposite. The
          // probe survives because the DASHBOARD still needs to know whether it
          // has anything to say on day one.
          teamCollectionHasAny(CONTACTS_COLLECTION, id),
          subcollectionHasAny(id, TEAM_MEMBERS_SUBCOLLECTION, 2),
          subcollectionHasAny(id, INSTALLED_PLUGINS_SUBCOLLECTION),
          subcollectionHasAny(id, AUTOMATION_RULES_SUBCOLLECTION),
          readPublicProfile(id),
        ])

      return {
        activities,
        pricing: subscriptions > 0 || pricedDropIn,
        sessions: sessionsBookable,
        contacts,
        hasOtherMembers: memberCount > 1,
        hasPlugins: installedPlugins > 0,
        hasAutomations: automations > 0,
        publicProfile,
      }
    },
  })

  const d = queryResult.data
  const ack = team?.setup_ack ?? {}
  const acked = (key: SetupStepKey) => !!ack[key]

  const raw: Array<Omit<SetupStep, 'acknowledged' | 'locked' | 'optional'>> = [
    // ── What you sell ────────────────────────────────────────────────────────
    {
      key: 'activities',
      section: 'offer',
      href: '/offer/activities',
      done: !!d?.activities,
    },
    {
      // Skippable because the probe cannot see every way a studio charges —
      // courses and products are plugin surfaces this hook deliberately does
      // not read — so a studio whose prices live somewhere else can close it
      // rather than be nagged by a step that is wrong about them.
      //
      // THE `OR` IS DELIBERATE AND STAYS: a priced drop-in on its own is a
      // price per class, which is what the label asks for. Narrowing it to
      // subscriptions would retroactively un-tick every studio that sells by
      // the class.
      key: 'pricing',
      section: 'offer',
      href: '/offer/plans?tab=subscriptions',
      ack: 'skip',
      done: !!d?.pricing,
    },

    {
      // IN "WHAT YOU SELL", beside the prices, not with the doors: how you get
      // paid is part of composing the offer, and it is the step that decides
      // whether the price you just typed can ever be charged (Franco,
      // 2026-08-23).
      //
      // ALWAYS SHOWN, never silently required. A cash-only club is a legitimate
      // tenant and must be able to close this; a studio that means to take card
      // payments must not be able to miss that it has not — without a
      // chargeable Connect account `payments_enabled` fails closed, and the
      // shop, the per-class prices, priced trials and priced appointments all
      // silently disappear.
      key: 'payments',
      section: 'offer',
      href: '/settings/team?tab=payments',
      ack: 'skip',
      done: team?.payments?.connectStatus === 'enabled',
    },

    // ── Open the doors ───────────────────────────────────────────────────────
    { key: 'sessions', section: 'doors', href: '/schedule', done: !!d?.sessions },
    {
      // `bioLink`, not `publicPage`: this step is about the bio-link editor it
      // links to, and the "Extra steps" row for the public-pages hub is
      // `publicPages`. Two keys a letter apart, one of them the id a hand-close
      // is stored under (`setup_ack.{key}`), is a trap not worth leaving.
      key: 'bioLink',
      section: 'doors',
      href: '/team/bio-link',
      done: publicPageHasContent(team, d?.publicProfile),
    },
    {
      // WHAT THE BOOKING FORM ASKS is part of opening the doors, not polish
      // (Franco, 2026-08-23): it is the last thing standing between somebody
      // and a booking, and a form asking for a date of birth nobody wanted is a
      // door that costs bookings rather than one that is merely unstyled.
      //
      // NO derived signal, deliberately: leaving the defaults is a perfectly
      // good answer, so there is nothing to observe. It closes on the studio
      // saying they have looked.
      key: 'bookingForm',
      section: 'doors',
      href: '/settings/booking',
      ack: 'review',
      done: false,
    },
    {
      // THE LAST LOOK BEFORE ANYBODY PAYS. /manage/pricing renders every price
      // as a member actually meets it — the plan, the per-class price, the
      // member rate on top of it — which is the one thing no individual editor
      // can show, because each of them only knows its own half.
      //
      // Pure acknowledgement, like the booking form: there is nothing to
      // observe about somebody having read a page, and pretending otherwise
      // would be the third lying step (Franco, 2026-08-23).
      key: 'pricingReview',
      section: 'doors',
      href: '/manage/pricing',
      ack: 'review',
      done: false,
    },

    // ── Make it yours (uncounted) ────────────────────────────────────────────
    {
      key: 'branding',
      section: 'extra',
      href: '/team/bio-link',
      ack: 'skip',
      done: hasBranding(team, d?.publicProfile),
    },
    {
      // WHERE EVERYTHING PUBLIC ACTUALLY IS. The surfaces are managed from
      // prefixes with nothing in common — /team/bio-link, /settings/booking,
      // /plugins/website, /events — and this hub is the census of them. Pure
      // acknowledgement: there is nothing to observe about having read a
      // directory.
      key: 'publicPages',
      section: 'extra',
      href: '/public-page',
      ack: 'review',
      done: false,
    },
    {
      // The QR codes are a DIALOG with nothing behind it, so the row opens it
      // where it belongs — on the hub that is the census of the surfaces the
      // codes point at. `?qr=1` follows the `?new=1` convention rather than
      // inventing a second one.
      key: 'qrCodes',
      section: 'extra',
      href: `/public-page?${PUBLIC_PAGE_QR_PARAM}=1`,
      ack: 'review',
      done: false,
    },
    {
      // EXPLORING is the point, not installing — so it closes BOTH ways.
      // Installing one is proof they looked, and a studio that looked and
      // wanted none of them has finished this just as honestly; there is
      // nothing to observe about the second case, which is what the review
      // acknowledgement is for. `installed_plugins` starts empty on a new team
      // (nothing in `onTeamCreated` seeds it), so the derived half can be false.
      key: 'plugins',
      section: 'extra',
      href: '/settings/plugins',
      ack: 'review',
      done: !!d?.hasPlugins,
    },
    {
      // Same shape as plugins, and for the same reason: building a rule is the
      // outcome, deciding you want none is an equally finished answer. Nothing
      // seeds `automation_rules`, so the derived half starts false.
      key: 'automations',
      section: 'extra',
      href: '/automations',
      ack: 'review',
      done: !!d?.hasAutomations,
    },
    {
      // `paymentsReview`, NOT `payments` — that id is taken by the Connect step
      // above, and a hand-close is stored per id (`setup_ack.{key}`), so a
      // collision would have the two steps closing each other. Same naming
      // shape as the `pricing` / `pricingReview` pair.
      key: 'paymentsReview',
      section: 'extra',
      href: '/payments',
      ack: 'review',
      done: false,
    },
    {
      key: 'coaches',
      section: 'extra',
      href: '/coaches',
      ack: 'skip',
      requiresPlan: 'studio',
      done: !!d?.hasOtherMembers,
    },
    {
      // NEVER DERIVED (rule 1): `NavPinsContext` falls back to
      // `DEFAULT_SHORTCUT_IDS`, so a studio has shortcuts from its first render
      // and a derived check could not be false. It is also per-browser
      // localStorage rather than a fact about the studio. The row exists to
      // teach the gesture; How-to is where the gesture is explained.
      key: 'shortcuts',
      section: 'extra',
      href: '/how-to',
      ack: 'review',
      done: false,
    },
  ]

  const steps: SetupStep[] = raw.map((s) => {
    const locked = !!s.requiresPlan && !planAtLeast(plan, s.requiresPlan)
    const acknowledged = !s.done && acked(s.key)
    return {
      ...s,
      optional: s.section === 'extra',
      locked,
      acknowledged,
      done: s.done || acknowledged,
    }
  })

  // The bar counts the two sections that stand between a studio and its first
  // booking — and nothing a plan has taken away.
  const counted = steps.filter((s) => !s.optional && !s.locked)
  const requiredDone = counted.filter((s) => s.done).length
  const allRequiredDone = requiredDone === counted.length

  // ── What the poll reads ────────────────────────────────────────────────────
  // Nothing counted left to find, or the studio has put the guide away: looking
  // again can only cost reads.
  const pollPointless = allRequiredDone || team?.setup_dismissed === true
  useEffect(() => {
    stopPollingRef.current = pollPointless
  }, [pollPointless])

  // THE DEADLINE IS KEYED ON A STRING, NEVER ON `queryResult.data`.
  //
  // The data REFERENCE cannot answer "did anything change". TanStack's
  // structural sharing (`replaceEqualDeep`) keeps the previous value only for
  // pairs that are both plain objects or arrays, and returns the new one for
  // everything else — and `publicProfile` carries a Firestore `Timestamp`
  // (`updated_at`, written by every `syncTeamPublicProfile` run). A fresh
  // `Timestamp` instance therefore mints a new `publicProfile`, which mints a
  // new root object, on EVERY refetch. Keying the deadline on that refreshed it
  // every 20 seconds and `refetchInterval`'s give-up branch could never be
  // reached — an unfinished tab polled forever, which is the precise cost the
  // window was written to cap.
  //
  // So the fingerprint is the counted facts themselves, as primitives: identical
  // across a refetch that found nothing new, different the moment one moves.
  const factsSignature = d
    ? [
        d.activities,
        d.pricing,
        d.sessions,
        d.contacts,
        d.hasOtherMembers,
        d.hasPlugins,
        d.hasAutomations,
        // The mirror is read for the two answers the steps ask of it, not for
        // its bytes — a description edited from one sentence to another is not
        // progress toward opening the doors.
        publicPageHasContent(null, d.publicProfile),
        hasBranding(null, d.publicProfile),
      ].join('|')
    : ''
  useEffect(() => {
    lastChangeRef.current = Date.now()
  }, [factsSignature])

  return {
    steps,
    requiredDone,
    requiredTotal: counted.length,
    allRequiredDone,
    /** Day one: the dashboard has nothing to say. Not "the checklist is unfinished". */
    hasContacts: !!d?.contacts,
    loading: queryResult.isLoading,
  }
}

/** Plan ordering, local to the one question this file asks. */
const PLAN_RANK: Record<SaasPlan, number> = { free: 0, coach: 1, studio: 2, organization: 3 }

function planAtLeast(plan: SaasPlan | undefined, min: SaasPlan): boolean {
  // Unknown plan is treated as sufficient: a step muted because the plan had
  // not loaded yet would flicker, and over-showing is the harmless direction.
  if (!plan) return true
  return PLAN_RANK[plan] >= PLAN_RANK[min]
}

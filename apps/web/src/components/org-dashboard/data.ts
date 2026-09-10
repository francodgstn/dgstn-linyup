'use client'

/**
 * WHAT AN ORGANISATION CAN HONESTLY BE ASKED — the whole data layer of the org
 * dashboard, in one place, because the interesting constraint here is not the
 * shape of the queries but WHO IS ALLOWED TO ASK THEM.
 *
 * A federation is not a bigger studio, and its dashboard cannot be the studio
 * dashboard with a wider `where` clause. Three facts about `firestore.rules`
 * decide the whole page:
 *
 *   1. **`teams/{teamId}` is members-or-creator.** An org admin is NOT
 *      automatically a member of the studios in the organisation, so the roster
 *      cannot read a studio's own document — which is why the existing Studios
 *      page falls back to printing a raw team id. The studio's NAME is reachable
 *      anyway, from `teams/{id}/public_profile/{id}`, which is world-readable.
 *      That is the one read here nothing can deny.
 *
 *   2. **Contacts are readable across the federation, but only by an ADMIN.**
 *      `contacts` admits `isOrgAdminOfTeam(resource.data.teamId)`, which resolves
 *      to `hasOrgRole(orgId, 'org_admin')`. An `org_viewer` gets nothing here, so
 *      every people figure is GATED on the role rather than attempted and caught
 *      — a viewer opening this page should not fire two denials per studio into
 *      their console to be told a dash.
 *
 *   3. **A denial is not a zero.** Every count below returns `null` when the read
 *      did not answer, and the components render `—` for it. Printing "0 people"
 *      at a federation that has thousands is the one failure mode that looks
 *      like data rather than like an error, and it is exactly what the Studios
 *      page shipped when an unguarded enrichment rejected a whole `Promise.all`.
 *
 * NOTHING HERE RELAXES A RULE, and nothing here needs a Cloud Function. That is
 * deliberate for a first iteration: the page is composed entirely of reads the
 * organisation already had, so it can be reshaped freely without a deploy.
 *
 * ── WHY COUNTS AND NOT DOCUMENTS ────────────────────────────────────────────
 *
 * `getCountFromServer` per studio, never a fan-out of contact documents. The org
 * Affiliations page downloads every contact of every member studio to count the
 * affiliated ones; at HMD's scale that is 1,600 documents to render four
 * numbers. An aggregation query transfers one integer and does not grow with the
 * federation. The cost is that the page cannot slice what it did not download —
 * which is the right trade for a dashboard and the wrong one for a roster.
 */

import { useQuery } from '@tanstack/react-query'
import {
  collection,
  collectionGroup,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  Timestamp,
  where,
  type QueryFieldFilterConstraint,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { liveContactConstraints } from '@/lib/liveContacts'
import {
  CONTACTS_COLLECTION,
  CONTACT_AFFILIATIONS_SUBCOLLECTION,
  DEFAULT_ORG_AFFILIATION_STATUSES,
  EVENTS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  ORG_AFFILIATION_STATUSES_SUBCOLLECTION,
  ORG_MEMBER_INVITATIONS_SUBCOLLECTION,
  ORG_TEAMS_SUBCOLLECTION,
  TEAMS_COLLECTION,
} from '@linyup/shared'
import type { OrgAffiliationStatusDef, OrgTeamStatus } from '@linyup/shared'

/**
 * A stand-in name for a studio whose public profile has not synced, chosen so it
 * sorts after every real one. `localeCompare` has no "put this last" argument,
 * and U+FFFF written literally in the source reads as an encoding accident.
 */
const SORTS_LAST = '\uFFFF'

/** How many upcoming events the "coming up" list shows before "all events". */
export const UPCOMING_EVENTS_SHOWN = 5

/** One member studio, as the dashboard knows it. */
export interface OrgStudioRow {
  teamId: string
  /** From the world-readable public profile. `null` when the studio has none
   *  yet (a brand-new team before `syncTeamPublicProfile` has run). */
  name: string | null
  slug: string | null
  status: OrgTeamStatus
  joined: Timestamp | null
}

/** Per-studio figures. `null` on either field means NOT ASKED OR DENIED. */
export interface OrgStudioCounts {
  onBooks: number | null
  affiliated: number | null
}

/**
 * THE ROSTER — the organisation's constituent studios, named.
 *
 * `status in ['active', 'invited']` matches the Studios page: a removed studio
 * is history, and the dashboard is about the federation as it stands. The two
 * live statuses are kept apart rather than summed, because an invitation nobody
 * accepted is work waiting on somebody, not a member.
 *
 * The name comes from the studio's PUBLIC PROFILE and not from its team
 * document — see fact 1 in the module header. `Promise.allSettled`, so a studio
 * whose profile has not synced yet loses its name, never its row.
 */
export function useOrgRoster(orgId: string) {
  return useQuery<OrgStudioRow[]>({
    queryKey: ['org-dashboard-roster', orgId],
    staleTime: 60_000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_TEAMS_SUBCOLLECTION),
          where('status', 'in', ['active', 'invited'])
        )
      )
      const rows: OrgStudioRow[] = snap.docs.map((d) => {
        const data = d.data()
        return {
          // `teamId` is a field on the row AND its document id; prefer the field
          // and fall back, exactly as the Studios page does.
          teamId: (data.teamId as string) ?? d.id,
          name: null,
          slug: null,
          status: (data.status as OrgTeamStatus) ?? 'active',
          joined: (data.joined as Timestamp | undefined) ?? null,
        }
      })

      const profiles = await Promise.allSettled(
        rows.map((r) => getDoc(doc(db, TEAMS_COLLECTION, r.teamId, 'public_profile', r.teamId)))
      )
      profiles.forEach((p, i) => {
        if (p.status !== 'fulfilled' || !p.value.exists()) return
        const data = p.value.data()
        rows[i].name = (data.name as string) ?? null
        rows[i].slug = (data.slug as string) ?? null
      })

      // Named studios first and alphabetically; the unnamed sink to the bottom
      // rather than sorting under a raw id nobody recognises.
      return rows.sort((a, b) => (a.name ?? SORTS_LAST).localeCompare(b.name ?? SORTS_LAST))
    },
  })
}

/**
 * ON THE BOOKS AND STILL VALID, per studio — the two counts the federation is
 * scaled by, and NEITHER of them is a headcount.
 *
 * ── WHY THE HEADCOUNT IS GONE ───────────────────────────────────────────────
 *
 * This used to count every live contact of every member studio and call it
 * `people`. A federation does not have those people: a studio inside it has
 * contacts who are nobody's business but its own — someone who trains at the
 * club spot, a lead from a fitness app, a person doing a personalised activity
 * the studio runs under its own name. Counting them made the organisation look
 * bigger than it is AND made every studio that serves non-members look worse at
 * "coverage" for doing so. Both directions were wrong, and the second was a
 * perverse incentive. See `docs/org-contact-visibility.md`.
 *
 * The federation now sees only the people on its books, and the rules agree:
 * `orgAdminMayReadContact` denies an org admin a contact who holds no
 * affiliation of theirs, so the old query would not merely be impolite — it
 * would be refused.
 *
 * ── THE TWO FIELDS ARE DIFFERENT QUESTIONS AND BOTH ARE NEEDED ──────────────
 *
 *   `onBooks`    — `org_ids`, ANY status. Expired, revoked and merely requested
 *                  all count: the organisation knows this person. This is the
 *                  DENOMINATOR, and it is also exactly the set the rules let an
 *                  admin read, so the figure can never describe more people than
 *                  the page could name.
 *
 *   `affiliated` — `active_org_ids`, valid RIGHT NOW (denormalised from the
 *                  status def's `countsAsActive`, flipped by the
 *                  `expireAffiliations` sweep). This is the NUMERATOR. Needs
 *                  `pnpm backfill:affiliation-active-orgs` on data written
 *                  before the field existed; `org_ids` needs no backfill, being
 *                  non-optional since the summary existed.
 *
 * Both name THIS org, so a studio's own internal club membership
 * (`issuer: 'team'`) and a governing body it merely tracks (`issuer: 'external'`)
 * are excluded — counting other people's badges as your own would be worse than
 * counting nothing.
 *
 * The ratio of the two therefore reads "how many of our members are current",
 * which is renewal health. The old ratio read "what share of these studios'
 * customers are ours", which is market penetration — a different question, and
 * not one a member studio had agreed to answer.
 *
 * BOTH COUNT LIVE CONTACTS ONLY, through `liveContactConstraints` — not deleted
 * AND not archived. They shipped with `deleted_at` alone, so an organisation
 * counted people who had left and read a figure that flattered it (Franco,
 * 2026-09-08). The pair has one owner; see `lib/liveContacts.ts`.
 *
 * (`affiliation_summary` is denormalised onto the contact by
 * `onAffiliationWrite`, so these are indexed counts rather than a walk of every
 * contact's affiliations subcollection.)
 *
 * ADMIN ONLY, by rule — see fact 2 in the module header. `enabled` carries that,
 * so a viewer's page simply never asks.
 */
export function useOrgStudioCounts(orgId: string, teamIds: string[], enabled: boolean) {
  return useQuery<Record<string, OrgStudioCounts>>({
    // The ids are part of the key: the roster resolves first and this refetches
    // when it changes, rather than holding counts for a studio that has gone.
    queryKey: ['org-dashboard-studio-counts', orgId, [...teamIds].sort()],
    enabled: enabled && teamIds.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const settled = await Promise.allSettled(
        teamIds.map(async (teamId) => {
          const [onBooks, affiliated] = await Promise.allSettled([
            getCountFromServer(
              query(
                collection(db, CONTACTS_COLLECTION),
                where('teamId', '==', teamId),
                ...liveContactConstraints(),
                where('affiliation_summary.org_ids', 'array-contains', orgId)
              )
            ),
            getCountFromServer(
              query(
                collection(db, CONTACTS_COLLECTION),
                where('teamId', '==', teamId),
                ...liveContactConstraints(),
                where('affiliation_summary.active_org_ids', 'array-contains', orgId)
              )
            ),
          ])
          return {
            teamId,
            counts: {
              onBooks: onBooks.status === 'fulfilled' ? onBooks.value.data().count : null,
              affiliated: affiliated.status === 'fulfilled' ? affiliated.value.data().count : null,
            } satisfies OrgStudioCounts,
          }
        })
      )
      const out: Record<string, OrgStudioCounts> = {}
      settled.forEach((r) => {
        if (r.status === 'fulfilled') out[r.value.teamId] = r.value.counts
      })
      return out
    },
  })
}

/** An upcoming org event, reduced to what a row shows. */
export interface OrgEventRow {
  id: string
  title: string
  start: Timestamp | null
}

/**
 * THE FEDERATION'S OWN CALENDAR — `scope: 'org'` events, which carry no
 * `teamId` at all and so can never be found by a studio-scoped query.
 *
 * The same filter shape the org Events page and the member-studio Overview use,
 * so all three hit one index. The count is a second, separate aggregation
 * because the list is capped: "3 of the next 5" would be a lie about a
 * federation with twenty events booked.
 */
export function useOrgUpcomingEvents(orgId: string) {
  return useQuery<{ rows: OrgEventRow[]; total: number | null }>({
    queryKey: ['org-dashboard-events', orgId],
    staleTime: 60_000,
    queryFn: async () => {
      const base = [
        where('orgId', '==', orgId),
        where('scope', '==', 'org'),
        where('deleted_at', '==', null),
        where('start', '>=', Timestamp.now()),
      ] as const
      const [listed, counted] = await Promise.allSettled([
        getDocs(
          query(
            collection(db, EVENTS_COLLECTION),
            ...base,
            orderBy('start', 'asc'),
            limit(UPCOMING_EVENTS_SHOWN)
          )
        ),
        getCountFromServer(query(collection(db, EVENTS_COLLECTION), ...base)),
      ])
      return {
        rows:
          listed.status === 'fulfilled'
            ? listed.value.docs.map((d) => ({
                id: d.id,
                title: (d.data().title as string) ?? '',
                start: (d.data().start as Timestamp | undefined) ?? null,
              }))
            : [],
        total: counted.status === 'fulfilled' ? counted.value.data().count : null,
      }
    },
  })
}

/** What is waiting on the organisation's admins. `null` = not asked or denied. */
export interface OrgAttentionCounts {
  accessRequests: number | null
  memberInvitations: number | null
}

/**
 * THE ADMIN'S QUEUE — the two things that sit unanswered until a person acts.
 *
 * Both reads are `hasOrgRole(orgId, 'org_admin')` in the rules, so an org_viewer
 * never asks (`enabled`). `org_member_invitations` in particular carries a
 * bearer `token` per row, which is why its rule excludes viewers at all — this
 * hook reads the documents to count them and deliberately returns nothing but
 * the number.
 *
 * The third queue item — a studio invited that has not accepted — is NOT here:
 * the roster already knows it, and asking the same question twice is how the
 * two answers start to disagree.
 */
export function useOrgAttention(orgId: string, enabled: boolean) {
  return useQuery<OrgAttentionCounts>({
    queryKey: ['org-dashboard-attention', orgId],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const [requests, invitations] = await Promise.allSettled([
        getDocs(
          query(
            collection(db, ORGANIZATIONS_COLLECTION, orgId, 'team_access_requests'),
            where('status', '==', 'pending')
          )
        ),
        getDocs(
          query(
            collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_MEMBER_INVITATIONS_SUBCOLLECTION),
            where('status', '==', 'pending')
          )
        ),
      ])
      return {
        accessRequests: requests.status === 'fulfilled' ? requests.value.size : null,
        memberInvitations: invitations.status === 'fulfilled' ? invitations.value.size : null,
      }
    },
  })
}

/**
 * Sum a per-studio figure across the federation.
 *
 * A SINGLE denial poisons the total, on purpose: "4,312 people" computed from
 * fifteen studios out of sixteen is a number a federation would quote in a
 * board meeting, and nothing on the card would say it was short. `null` renders
 * as `—`, which is honest and visibly incomplete.
 */
export function sumOrNull(values: (number | null | undefined)[]): number | null {
  if (values.length === 0) return 0
  let total = 0
  for (const v of values) {
    if (v == null) return null
    total += v
  }
  return total
}

/**
 * The strip's whole answer: one row per status, plus how many DISTINCT people
 * hold any affiliation from this org.
 *
 * The two are counted separately because they answer differently-shaped
 * questions. A row is "people in this status"; `people` is "people with a record
 * at all", and it is NOT the sum of the rows — somebody holding a licence that
 * is active and a grading that is merely requested is one person in two rows.
 * The bar is a distribution and so is sized by the row sum; the header states
 * `people`, which can never exceed the headcount above it.
 */
export interface OrgAffiliationStatusBreakdown {
  rows: OrgAffiliationStatusCount[]
  /** `null` = the count did not answer. */
  people: number | null
}

/** One row of the status strip: a status def and how many people are in it. */
export interface OrgAffiliationStatusCount {
  def: OrgAffiliationStatusDef
  /** `null` = the count did not answer. Never rendered as zero. */
  count: number | null
}

/**
 * THE ORGANISATION'S AFFILIATION VOCABULARY, in the org's own words.
 *
 * `affiliation_statuses` is tenant-configurable and admits `isOrgMember`; an
 * organisation that has never edited it has an empty subcollection, which means
 * the DEFAULTS rather than "no statuses". Merged the same way the Affiliations
 * page merges them, so both surfaces name and order the vocabulary identically.
 */
export function useOrgAffiliationStatusDefs(orgId: string) {
  return useQuery<OrgAffiliationStatusDef[]>({
    queryKey: ['org-affiliation-status-defs', orgId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const snap = await getDocs(
        collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_AFFILIATION_STATUSES_SUBCOLLECTION)
      )
      if (snap.empty) return DEFAULT_ORG_AFFILIATION_STATUSES
      const byId: Record<string, OrgAffiliationStatusDef> = Object.fromEntries(
        DEFAULT_ORG_AFFILIATION_STATUSES.map((d) => [d.id, d])
      )
      snap.docs.forEach((d) => {
        byId[d.id] = { ...(d.data() as OrgAffiliationStatusDef), id: d.id }
      })
      return Object.values(byId).sort((a, b) => a.order - b.order)
    },
  })
}

/**
 * HOW MANY OF THE ORGANISATION'S AFFILIATIONS SIT IN EACH STATUS.
 *
 * ── IT COUNTS ROWS, THROUGH THE COLLECTION GROUP, AND THAT IS A DECISION ────
 *
 * `org_id` names the issuing organisation, `status_id` the bucket. That shape is
 * the ONE `firestore.rules` can prove for an org admin: the collection-group
 * block admits `isOrgAdminOfOrg` on the row's own `org_id`, so a query pinning
 * `org_id` is provably inside it.
 *
 * It was moved onto the CONTACT (#249) so the counts would compose with
 * `archived_at`, filtering a denormalised `org:status` key, and moved back here
 * (Franco, 2026-09-09) because `orgAdminMayReadContact` cannot prove that query:
 * Firestore matches a query against a rule by VALUE, and an `org:status` key has
 * a tenant-configurable half no rule can name. Every document it would have
 * returned was readable; only the proof was missing, so the counts came back
 * `permission-denied` on every studio the caller was not personally a member of.
 * See `docs/org-contact-visibility.md`.
 *
 * ── WHAT #249 FIXED IS NOT GIVEN BACK ───────────────────────────────────────
 *
 * A collection group cannot reach the parent contact, which is why this count
 * could not see `archived_at` and an ex-member's licence sat in the federation's
 * queue for ever. `contact_live` is now denormalised onto every affiliation by
 * `syncAffiliationContactLive`, so the same exclusion is an ordinary equality
 * filter here.
 *
 * A missing field never matches an equality filter, so a row written before that
 * field simply does not count — visibly low rather than invisibly high, which is
 * the safe direction. Every dataset that has affiliations writes it now (the
 * three seeders and the HMD migration), so re-seed or re-migrate rather than
 * reaching for a backfill.
 *
 * ── RECORDS, NOT PEOPLE, AND THE DISTINCTION IS LOAD-BEARING ────────────────
 *
 * A person holding a licence that is active and a grading that is merely
 * requested is one person in two rows. That is the right answer to "how many
 * licences are awaiting review" and the wrong one to "how many people", so the
 * copy says records and the strip states no percentage of the headcount — a
 * ratio across those two populations would be the lie.
 *
 * ── ONE AGGREGATION PER STATUS ─────────────────────────────────────────────
 *
 * `getCountFromServer` per status def transfers one integer each, where
 * downloading the rows to tally them would be every licence the federation has
 * ever issued. No `teamId` scoping and no chunking: `org_id` already bounds the
 * query to this organisation's own rows, which is also what makes it provable.
 */
export function useOrgAffiliationStatusCounts(
  orgId: string,
  defs: OrgAffiliationStatusDef[] | undefined,
  enabled: boolean
) {
  return useQuery<OrgAffiliationStatusBreakdown>({
    queryKey: ['org-affiliation-status-counts', orgId, (defs ?? []).map((d) => d.id)],
    enabled: enabled && !!defs && defs.length > 0,
    staleTime: 2 * 60_000,
    queryFn: async () => {
      const settled = await Promise.allSettled(
        (defs ?? []).map(async (def) => {
          const snap = await getCountFromServer(
            query(
              collectionGroup(db, CONTACT_AFFILIATIONS_SUBCOLLECTION),
              where('org_id', '==', orgId),
              where('contact_live', '==', true),
              where('status_id', '==', def.id)
            )
          )
          return snap.data().count
        })
      )
      const rows = (defs ?? []).map((def, i) => {
        const r = settled[i]
        return { def, count: r?.status === 'fulfilled' ? r.value : null }
      })
      return {
        // Summed from the buckets it is showing, rather than counted separately:
        // a total that does not add up to its own parts is the number a reader
        // stops trusting. `sumOrNull` keeps a single denial honest.
        people: sumOrNull(rows.map((r) => r.count)),
        rows,
      }
    },
  })
}

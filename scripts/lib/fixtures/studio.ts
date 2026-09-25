/**
 * Shared studio-configuration fixtures — places, recurring session series, and
 * gift cards.
 *
 * These three came out of the Phase 1 audit's per-surface worklists rather than
 * its cross-surface list, and they are here rather than inline in each seeder
 * because two lanes needed the same helper and a helper written twice is the
 * drift the whole phase is about (docs/seed-truth-2026-08.md).
 *
 * Path constants mirror @linyup/shared (same convention as lib/storefront.ts).
 */

import admin from 'firebase-admin'

const TEAMS_COLLECTION = 'teams'
const TEAM_PLACES_SUBCOLLECTION = 'team_places'
const SESSIONS_COLLECTION = 'sessions'
const SESSION_SERIES_COLLECTION = 'session_series'
const GIFT_CARDS_SUBCOLLECTION = 'gift_cards'
const INSTALLED_PLUGINS_SUBCOLLECTION = 'installed_plugins'
const PUBLIC_PROFILE_SUBCOLLECTION = 'public_profile'

const tsOf = (d: Date) => admin.firestore.Timestamp.fromDate(d)
function daysFrom(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

// ── Places ────────────────────────────────────────────────────────────────────

export interface SeedPlace {
  key: string
  name: string
  address: string
  mapsLink?: string
  rooms?: string[]
}

/**
 * A studio's venues, plus the primary one denormalised onto the team's public
 * profile.
 *
 * `PublicMainAddress` on `public_profile` is what the bio-link renders, so a
 * seeded place that skipped it would leave the public page addressless while the
 * admin side looked complete — the kind of half-state that reads as a UI bug.
 *
 * The FIRST place is primary. `Place.isPrimary` is team-scope only.
 */
export async function seedTeamPlaces(opts: {
  teamId: string
  uid: string
  places?: SeedPlace[]
  /** Defaults to a two-venue studio. */
  teamName?: string
}): Promise<SeedPlace[]> {
  const db = admin.firestore()
  const { teamId, uid } = opts
  const teamName = opts.teamName ?? 'the studio'
  const places: SeedPlace[] =
    opts.places ??
    [
      {
        key: 'main',
        name: `${teamName} — Main`,
        address: 'Bahnhofstrasse 12, 8001 Zürich',
        rooms: ['Mat A', 'Mat B'],
      },
      {
        key: 'annex',
        name: `${teamName} — Annex`,
        address: 'Langstrasse 88, 8004 Zürich',
        rooms: ['Studio 1'],
      },
    ]

  for (let i = 0; i < places.length; i++) {
    const p = places[i]
    await db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(TEAM_PLACES_SUBCOLLECTION)
      .doc(`${teamId}-place-${p.key}`)
      .set({
        id: `${teamId}-place-${p.key}`,
        teamId,
        scope: 'team',
        name: p.name,
        address: p.address,
        ...(p.mapsLink ? { mapsLink: p.mapsLink } : {}),
        isPrimary: i === 0,
        // Rooms are FEW, so they live embedded on the place rather than in a
        // subcollection — the same call `Event.program`'s days/tracks makes.
        ...(p.rooms?.length
          ? {
              rooms: p.rooms.map((name, r) => ({
                id: `${teamId}-room-${p.key}-${r}`,
                name,
                order: r,
              })),
            }
          : {}),
        order: i,
        created_at: tsOf(daysFrom(-200)),
        createdBy: uid,
      })
  }

  const primary = places[0]
  if (primary) {
    await db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(PUBLIC_PROFILE_SUBCOLLECTION)
      .doc(teamId)
      .set(
        {
          mainAddress: {
            name: primary.name,
            address: primary.address,
            ...(primary.mapsLink ? { mapsLink: primary.mapsLink } : {}),
          },
        },
        { merge: true }
      )
  }

  return places
}

// ── Recurring session series ──────────────────────────────────────────────────

/**
 * Bind the team's existing recurring-looking sessions to a `session_series`
 * record, so at least one class reads as a recurring class rather than a
 * one-off.
 *
 * A studio's first question is almost always "can it handle my weekly
 * schedule", and every seeded session looked standalone on three of the five
 * surfaces. This does NOT generate new sessions: it groups sessions the seeder
 * already wrote, which is also what stops it from drifting away from whatever
 * schedule each seeder invents.
 */
export async function seedSessionSeries(opts: {
  teamId: string
  uid: string
  /** How many distinct activities to bind, most-frequent first. Default 1. */
  activities?: number
}): Promise<number> {
  const db = admin.firestore()
  const { teamId, uid } = opts
  const wanted = opts.activities ?? 1

  const sessions = await db
    .collection(SESSIONS_COLLECTION)
    .where('teamId', '==', teamId)
    .get()

  // Group by activity, ignoring appointments — an appointment session is created
  // lazily at booking and is never part of a recurring series.
  const byActivity = new Map<string, admin.firestore.QueryDocumentSnapshot[]>()
  for (const d of sessions.docs) {
    const data = d.data()
    if (data.activityType === 'appointment') continue
    const activityId = data.activityId as string | undefined
    if (!activityId) continue
    const list = byActivity.get(activityId) ?? []
    list.push(d)
    byActivity.set(activityId, list)
  }

  const ranked = [...byActivity.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, wanted)

  let created = 0
  for (const [activityId, docs] of ranked) {
    if (docs.length < 2) continue
    const seriesId = `${teamId}-series-${activityId}`
    const starts = docs
      .map((d) => (d.data().start as admin.firestore.Timestamp | undefined)?.toDate())
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())
    if (!starts.length) continue

    const daysOfWeek = [...new Set(starts.map((d) => d.getDay()))].sort()
    const first = starts[0]
    const last = starts[starts.length - 1]

    await db
      .collection(SESSION_SERIES_COLLECTION)
      .doc(seriesId)
      .set({
        id: seriesId,
        teamId,
        activityId,
        recurrence: {
          frequency: 'weekly',
          interval: 1,
          daysOfWeek,
          // Minutes, derived from the sessions themselves rather than assumed.
          duration: durationMinutes(docs[0]),
          startDate: tsOf(first),
          endCondition: 'date',
          endDate: tsOf(last),
        },
        created_at: tsOf(daysFrom(-200)),
        createdBy: uid,
      })

    // Point the sessions back at the series, which is what makes the schedule
    // offer "edit this occurrence / edit the series". The field is `seriesId`;
    // `isException` stays absent, because none of these was edited away from the
    // pattern.
    for (const d of docs) await d.ref.set({ seriesId }, { merge: true })
    created += 1
  }
  return created
}

function durationMinutes(doc: admin.firestore.QueryDocumentSnapshot): number {
  const data = doc.data()
  const start = (data.start as admin.firestore.Timestamp | undefined)?.toDate()
  const end = (data.end as admin.firestore.Timestamp | undefined)?.toDate()
  if (!start || !end) return 60
  const mins = Math.round((end.getTime() - start.getTime()) / 60000)
  return mins > 0 ? mins : 60
}

// ── Gift cards ────────────────────────────────────────────────────────────────

/**
 * Turn gift cards on for a studio: the plugin, the team setting, its public
 * mirror, and one pre-minted demo card.
 *
 * ALL FOUR ARE REQUIRED, which is why this is a helper and not four lines in a
 * seeder. `syncTeamPublicProfile` refuses to mirror `giftCards.enabled` without
 * the plugin installed, so a card seeded without the install silently vanishes
 * from the shop; and the public mirror is written directly because the sync
 * trigger may not be deployed on a sandbox.
 *
 * The demo card exists so redemption can be SHOWN in the one-off checkouts
 * (drop-in / product / course) without buying a card first. It is shaped exactly
 * as the webhook's `mintGiftCard` writes one — the readable code IS the doc id.
 *
 * NOT seeded: `gift_card_issues`. That subcollection is the serialization point
 * for a manager mint — whoever wins the `create()` mints and everyone else reads
 * the code back — so a seeded row would be a claim on a race that never happened.
 */
export async function seedTeamGiftCards(opts: {
  teamId: string
  uid: string
  currency?: string
  amounts?: number[]
  /** Face value of the pre-minted demo card. Default 100. */
  demoCardAmount?: number
  installedDaysAgo?: number
}): Promise<string> {
  const db = admin.firestore()
  const { teamId, uid } = opts
  const amounts = opts.amounts ?? [50, 100]
  const currency = opts.currency ?? 'CHF'
  const installedDaysAgo = opts.installedDaysAgo ?? 200
  const giftCardSettings = { enabled: true, amounts }

  await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(INSTALLED_PLUGINS_SUBCOLLECTION)
    .doc('gift-cards')
    .set({
      pluginId: 'gift-cards',
      teamId,
      installedAt: tsOf(daysFrom(-installedDaysAgo)),
      installedBy: uid,
      status: 'active',
      config: {},
      updated_at: tsOf(daysFrom(-installedDaysAgo)),
    })

  // The setting on the team doc, and its public mirror. Merged, because the team
  // document is written by the seeder before this runs and carries other
  // settings that must survive.
  await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .set({ settings: { giftCards: giftCardSettings } }, { merge: true })
  await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(PUBLIC_PROFILE_SUBCOLLECTION)
    .doc(teamId)
    .set({ giftCards: giftCardSettings }, { merge: true })

  const amount = opts.demoCardAmount ?? 100
  const code = 'GC-DEMO-CARD'
  await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(GIFT_CARDS_SUBCOLLECTION)
    .doc(code)
    .set({
      code,
      teamId,
      amount,
      balance: amount,
      currency,
      status: 'active',
      purchaserContactId: null,
      purchaserEmail: null,
      payment_intent_id: null,
      created_at: tsOf(daysFrom(-10)),
      updated_at: tsOf(daysFrom(-10)),
    })

  return code
}

// Keeps events/{eventId}/public_profile/{eventId} in sync.
//
// Unlike the other mirrors this is an AGGREGATE one: the whole program
// (tracks, days and every item) is embedded into the single mirror doc, so a
// public event page is one document read and the "explicit whitelist, never
// spread" invariant lives in exactly one place. It therefore reacts to writes on
// the event AND on its program_items subcollection.
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import * as admin from 'firebase-admin'
import {
  EVENTS_COLLECTION,
  EVENT_PROGRAM_ITEMS_SUBCOLLECTION,
  MAX_PROGRAM_ITEMS,
  compareProgramItems,
} from '@linyup/shared'
import type { EventProgramItem } from '@linyup/shared'
import { touchTeamForSurfaceRecompute } from '../utils/plugins'

/** An event is world-readable only when the studio has explicitly published it.
 *  Events are private by default — this gate is the whole reason
 *  `publicVisibility` exists. */
const isLiveEvent = (d?: Record<string, unknown>): boolean =>
  !!d && d.publicVisibility === 'public' && d.deleted_at == null && d.status !== 'cancelled'

/** Public shape of one program item. INTERNAL NOTES ARE NEVER INCLUDED —
 *  `internalNote` is staff-only and must not leak onto a public page. */
function publicProgramItem(item: EventProgramItem) {
  return {
    id: item.id,
    dayId: item.dayId,
    trackId: item.trackId ?? null,
    startTime: item.startTime,
    endTime: item.endTime ?? null,
    allDay: item.allDay === true,
    title: item.title,
    subtitle: item.subtitle ?? null,
    description: item.description ?? null,
    locationText: item.locationText ?? null,
    peopleText: item.peopleText ?? null,
    kind: item.kind ?? null,
    color: item.color ?? null,
    isHighlight: item.isHighlight === true,
    order: item.order ?? 0,
  }
}

export async function rebuildEventPublicProfile(eventId: string): Promise<void> {
  const db = admin.firestore()
  const eventRef = db.collection(EVENTS_COLLECTION).doc(eventId)
  const snap = await eventRef.get()
  const mirrorRef = eventRef.collection('public_profile').doc(eventId)

  if (!snap.exists || !isLiveEvent(snap.data())) {
    await mirrorRef.delete()
    return
  }

  const data = snap.data()!
  const program = (data.program ?? null) as
    | { days?: unknown[]; tracks?: unknown[]; timezoneLabel?: string; note?: string }
    | null

  const itemsSnap = await eventRef.collection(EVENT_PROGRAM_ITEMS_SUBCOLLECTION).get()
  const items = itemsSnap.docs
    .map((d) => ({ ...d.data(), id: d.id }) as EventProgramItem)
    .sort(compareProgramItems)
    // Hard cap so the embedded program cannot push the mirror past Firestore's
    // 1 MB document limit. The UI enforces the same cap on the way in.
    .slice(0, MAX_PROGRAM_ITEMS)
    .map(publicProgramItem)

  await mirrorRef.set({
    type: 'event',
    // teamId is null for an org event and orgId is null for a team one — public
    // surfaces query on whichever applies, so BOTH are always written.
    teamId: data.teamId ?? null,
    orgId: data.orgId ?? null,
    scope: data.scope ?? 'team',
    title: data.title ?? '',
    eventType: data.type ?? null,
    start: data.start ?? null,
    end: data.end ?? null,
    status: data.status ?? 'open',
    location: data.location || null,
    description: data.description ?? data.desc ?? null,
    coachName: data.coachName ?? null,
    program: program
      ? {
          days: program.days ?? [],
          tracks: program.tracks ?? [],
          timezoneLabel: program.timezoneLabel ?? null,
          note: program.note ?? null,
        }
      : null,
    programItems: items,
    programItemCount: items.length,
  })
}

export const syncEventPublicProfile = onDocumentWritten(
  `${EVENTS_COLLECTION}/{eventId}`,
  async (event) => {
    const { eventId } = event.params
    await rebuildEventPublicProfile(eventId)

    // Crossing the published boundary may flip whether the team's public events
    // surface is live. Org events have no team surface to recompute.
    const before = event.data!.before.data()
    const after = event.data!.after.data()
    if (isLiveEvent(before) !== isLiveEvent(after)) {
      const teamId = (after?.teamId ?? before?.teamId) as string | undefined
      if (teamId) await touchTeamForSurfaceRecompute(teamId)
    }
  },
)

/** The program lives in a subcollection, so item writes must rebuild the
 *  mirror too — otherwise a published event's public agenda would silently go
 *  stale the moment anyone edited it. */
export const syncEventProgramPublicProfile = onDocumentWritten(
  `${EVENTS_COLLECTION}/{eventId}/${EVENT_PROGRAM_ITEMS_SUBCOLLECTION}/{itemId}`,
  async (event) => {
    await rebuildEventPublicProfile(event.params.eventId)
  },
)

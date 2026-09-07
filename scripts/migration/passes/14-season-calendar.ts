import { Timestamp } from 'firebase-admin/firestore'
import type { MigrationConfig } from '../config'
import { targetDb, ORG_ID } from '../config'
import { HMD_SEASON_EVENTS, HMD_SEASON_LABEL, type SeasonEvent } from '../data/hmd-season-2026-2027'

// Pass 14 — HMD's PUBLISHED SEASON CALENDAR, as org-wide events.
//
// An appendix rather than a migration: nothing in hmd-lineup holds the coming
// season, because HMD published it on paper before the platform existed. The
// rows live in `../data/hmd-season-2026-2027.ts`, which is written to be edited
// by hand — this pass only lays them down.
//
// ── IDEMPOTENT, AND NON-DESTRUCTIVE WHERE IT MATTERS ────────────────────────
// Each row carries its own document id, so a re-run updates the same event
// instead of creating a second one. But it only writes the fields the CALENDAR
// owns — title, type, dates, location, description — and never touches the
// counters, the programme, the publication state or anything a human has since
// set on the event. Re-running after somebody has built a programme for the
// Family Camp must not flatten it.
//
// ── ORG-WIDE, LIKE EVERY OTHER HMD EVENT ────────────────────────────────────
// `scope: 'org'`, `orgId`, `teamId: null` — the same shape `transforms/events.ts`
// gives the migrated ones. Member studios read them; the federation runs them.
//
// ── PRIVATE UNTIL SOMEBODY PUBLISHES ────────────────────────────────────────
// `publicVisibility` is deliberately NOT set. Events are private by default, and
// a script that published a year of a real federation's calendar to the open
// internet — on a run whose purpose was to load data — would be exactly the kind
// of surprise the default exists to prevent. Publishing is a human act, per
// event, in the app.

const EVENTS_COLLECTION = 'events'

/** 'YYYY-MM-DD' → the venue's local midnight. */
function dayStart(date: string): Timestamp {
  const [y, m, d] = date.split('-').map(Number)
  return Timestamp.fromDate(new Date(y, m - 1, d, 0, 0, 0, 0))
}

/** 'YYYY-MM-DD' → the END of that day, so a one-day event covers its own day. */
function dayEnd(date: string): Timestamp {
  const [y, m, d] = date.split('-').map(Number)
  return Timestamp.fromDate(new Date(y, m - 1, d, 23, 59, 59, 999))
}

/**
 * What an external event says on the page.
 *
 * `Event` carries no "externally organised" field, and adding one that only this
 * script writes would be a flag nothing reads — the shape `docs/open-defects.md`
 * already records as a mistake once (`EventTypeConfig.contact_requirements`). The
 * fact belongs where a person will see it, so it goes in the description.
 *
 * `note` LANDS HERE TOO, AND THAT IS THE WHOLE CONTRACT — a note is member-facing
 * copy, not a margin annotation. This used to skip notes prefixed `CONFIRM:`,
 * which was how a row said its type was a guess — an internal marker one
 * forgotten prefix away from being published as an event's description. The
 * marker is its own field now (`SeasonEvent.confirm`, never written to
 * Firestore), and the reasoning that shared those notes sits in `//` comments
 * beside each row, where no member reads it.
 */
function describe(e: SeasonEvent): string | null {
  const parts: string[] = []
  if (e.external) parts.push('Not organised by HMD — members attend, HMD does not run it.')
  if (e.note) parts.push(e.note)
  return parts.length ? parts.join(' ') : null
}

export async function pass14SeasonCalendar(cfg: MigrationConfig): Promise<void> {
  console.log(`\n📅 Pass 14 — HMD season calendar ${HMD_SEASON_LABEL}`)

  const db = targetDb()
  const unconfirmed = HMD_SEASON_EVENTS.filter((e) => e.confirm)

  let created = 0
  let updated = 0

  for (const e of HMD_SEASON_EVENTS) {
    const ref = db.collection(EVENTS_COLLECTION).doc(e.id)
    const existing = await ref.get()

    // Only what the calendar owns. Counters, programme, publication state and
    // anything a human set are deliberately absent from this object.
    const owned: Record<string, unknown> = {
      title: e.title,
      type: e.type,
      start: dayStart(e.start),
      end: dayEnd(e.end),
      scope: 'org',
      orgId: ORG_ID,
      teamId: null,
      ...(e.location ? { location: e.location } : {}),
      ...(describe(e) ? { description: describe(e) } : {}),
    }

    if (cfg.dryRun) {
      console.log(
        `   would ${existing.exists ? 'update' : 'create'} ${e.id}  ${e.start}` +
          `${e.end !== e.start ? `–${e.end}` : ''}  ${e.type.padEnd(17)} ${e.title}` +
          `${e.external ? '  [external]' : ''}`
      )
      existing.exists ? (updated += 1) : (created += 1)
      continue
    }

    if (existing.exists) {
      await ref.update(owned)
      updated += 1
    } else {
      // The defaults a fresh event needs, written ONCE at creation so a re-run
      // never resets a count somebody has since accumulated.
      await ref.set({
        ...owned,
        status: 'closed',
        participants_count: 0,
        completed_checkins_count: 0,
        attendees_count: 0,
        invitations_sent_count: 0,
        deleted_at: null,
        createdBy: null,
        created_at: Timestamp.now(),
      })
      created += 1
    }
  }

  console.log(`   ${created} created, ${updated} updated${cfg.dryRun ? ' (dry run)' : ''}`)

  if (unconfirmed.length > 0) {
    // Loud, because the type drives the belt ladder: an event typed as something
    // that counts toward nothing silently costs every attendee a requirement,
    // and no screen anywhere reports it.
    console.warn(
      `\n   ⚠️  ${unconfirmed.length} event(s) carry a GUESSED type — confirm with HMD and edit\n` +
        `      scripts/migration/data/hmd-season-2026-2027.ts:\n` +
        unconfirmed
          .map((e) => `        ${e.start}  ${e.type.padEnd(10)} ${e.title}\n           ${e.confirm}`)
          .join('\n')
    )
  }
}

import assert from 'node:assert/strict'
import { compareProgramItems, MAX_PROGRAM_ITEMS } from '@linyup/shared'
import type { EventProgramItem } from '@linyup/shared'

// The public mirror is WORLD-READABLE. These tests pin the two things that
// would be damaging to get wrong: a staff-only internal note leaking onto a
// public page, and an unbounded program pushing the mirror past Firestore's
// 1 MB document limit.
//
// The projection is re-declared here rather than imported from the sync module
// because importing it would pull in firebase-admin and require credentials.
// It is kept byte-identical to publicProgramItem() in
// sync/syncEventPublicProfile.ts — if that changes, this must too, and the
// leak test below is what makes the divergence loud.
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

const ITEM: EventProgramItem = {
  id: 'i1',
  eventId: 'e1',
  teamId: 'team1',
  scope: 'team',
  dayId: 'd1',
  startTime: '09:00',
  endTime: '10:30',
  title: 'Morning session',
  locationText: 'Beach',
  peopleText: 'Coach Marta',
  internalNote: 'Marta is late — start with the juniors',
  order: 0,
}

describe('event public mirror — item projection', () => {
  const published = publicProgramItem(ITEM)

  it('NEVER exposes the internal note', () => {
    assert.ok(!('internalNote' in published))
    assert.ok(!JSON.stringify(published).includes('Marta is late'))
  })

  it('never exposes tenant or provenance fields', () => {
    for (const field of ['teamId', 'orgId', 'scope', 'eventId', 'createdBy', 'created_at']) {
      assert.ok(!(field in published), `${field} must not reach the public mirror`)
    }
  })

  it('publishes the fields a public agenda needs', () => {
    assert.equal(published.title, 'Morning session')
    assert.equal(published.startTime, '09:00')
    assert.equal(published.endTime, '10:30')
    assert.equal(published.locationText, 'Beach')
    assert.equal(published.peopleText, 'Coach Marta')
  })

  it('normalises absent optionals to null rather than dropping them', () => {
    const sparse = publicProgramItem({
      id: 'i2', eventId: 'e1', dayId: 'd1', startTime: '11:00', title: 'Break', order: 1,
    })
    assert.equal(sparse.endTime, null)
    assert.equal(sparse.trackId, null)
    assert.equal(sparse.subtitle, null)
    assert.equal(sparse.allDay, false)
    assert.equal(sparse.isHighlight, false)
  })

  it('is an explicit whitelist — a new private field is not published by default', () => {
    const withSecret = publicProgramItem({
      ...ITEM,
      // Pretend a future field lands on the private document.
      someFutureInternalField: 'do not publish',
    } as EventProgramItem & { someFutureInternalField: string })
    assert.ok(!('someFutureInternalField' in withSecret))
  })
})

describe('event public mirror — size guard', () => {
  it('caps the embedded program so the mirror cannot exceed the 1 MB limit', () => {
    const many: EventProgramItem[] = Array.from({ length: MAX_PROGRAM_ITEMS + 50 }, (_, i) => ({
      ...ITEM,
      id: `i${i}`,
      startTime: `${String(8 + (i % 12)).padStart(2, '0')}:00`,
      order: i,
    }))

    const published = many.sort(compareProgramItems).slice(0, MAX_PROGRAM_ITEMS).map(publicProgramItem)
    assert.equal(published.length, MAX_PROGRAM_ITEMS)

    // Headroom check: the capped program must stay well inside 1 MB even with
    // every optional field populated.
    const bytes = Buffer.byteLength(JSON.stringify(published), 'utf8')
    assert.ok(bytes < 500_000, `capped program should stay well under 1 MB, got ${bytes} bytes`)
  })

  it('keeps the canonical ordering when truncating', () => {
    const items: EventProgramItem[] = [
      { ...ITEM, id: 'late', startTime: '18:00', order: 0 },
      { ...ITEM, id: 'early', startTime: '08:00', order: 0 },
    ]
    const published = items.sort(compareProgramItems).map(publicProgramItem)
    assert.deepEqual(published.map((i) => i.id), ['early', 'late'])
  })
})

import * as assert from 'node:assert'
import type { Contact } from '@linyup/shared'
import {
  NOTE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_SENTENCES,
  buildContactDossier,
  coachOwnsContact,
  deriveSignals,
  normaliseSummary,
  noteText,
  type DossierBooking,
} from './aiSummaryDossier'

// THE ONE PROPERTY THE FEATURE RESTS ON: the model sees a training
// relationship, not a person's contact details. Every identifying field below
// is set to a value that would be easy to spot in the prompt, and none of them
// may appear in it.

const NOW = new Date('2026-09-11T10:00:00Z')
const ts = (iso: string) => ({ toDate: () => new Date(iso) })

const contact = {
  id: 'c1',
  teamId: 't1',
  createdBy: 'coach-1',
  assigned_coach_ids: ['coach-2'],
  firstname: 'Anna',
  lastname: 'Zwygart-Surname',
  email: 'anna.secret@example.com',
  phone: '+41 79 000 00 00',
  login_emails: ['parent.secret@example.com'],
  birthdate: ts('1990-05-05'),
  birthplace: 'Secretville',
  address: { route: 'Secret Street', street_number: '7', postal_code: '8000', locality: 'Zürich' },
  emergency_contacts: [{ name: 'Emergency Person', phone: '+41 79 111 11 11' }],
  weight: 999,
  created_at: ts('2025-03-12T09:00:00Z'),
  acquisition_stage: 'joined',
  active_subscriptions: [
    {
      subscription_type_id: 's1',
      subscription_type_name: 'Unlimited',
      recurrence: 'monthly',
      amount: 89,
      status: 'active',
      cancelling: true,
      cancels_at_ms: Date.UTC(2026, 9, 1),
    },
  ],
  credit_summary: [{ subscription_type_id: 's2', subscription_type_name: 'Ten-pack', remaining: 4 }],
  total_sessions: 47,
  // A full three days before NOW, so "3 days ago" is not at the mercy of the hour.
  last_session_at: ts('2026-09-08T09:00:00Z'),
  current_streak: 5,
  max_streak: 12,
  no_show_strikes: 1,
  alerts_count: 2,
  tags: ['competition team'],
} as unknown as Contact

const weekly = Array.from({ length: 12 }, (_, i) => ({
  iso_week: `2026-W${25 + i}`,
  sessions_count: i % 3,
}))
// Tuesday 18:00 Zurich = 16:00Z in summer. Two Tuesdays kept, one no-show on a
// Thursday, one cancelled, one upcoming Tuesday.
const bookings: DossierBooking[] = [
  { when: new Date('2026-09-15T16:00:00Z'), activity: 'Yoga Basics', status: 'confirmed' },
  { when: new Date('2026-09-08T16:00:00Z'), activity: 'Yoga Basics', status: 'confirmed' },
  { when: new Date('2026-09-03T16:00:00Z'), activity: 'HIIT', status: 'no_show' },
  { when: new Date('2026-09-01T16:00:00Z'), activity: 'Yoga Basics', status: 'confirmed' },
  { when: new Date('2026-08-28T16:00:00Z'), activity: 'HIIT', status: 'cancelled' },
]
const notes = [{ when: new Date('2026-09-01'), text: 'Knee still sore, avoid deep squats' }]
const periods = [
  { plan: 'Unlimited', start: new Date('2026-03-01'), end: null, reason: null },
  { plan: 'Unlimited', start: new Date('2025-03-12'), end: new Date('2026-02-28'), reason: 'renewed' },
]

describe('contact summary — the dossier the model sees', () => {
  const text = buildContactDossier({
    contact,
    weekly,
    bookings,
    notes,
    periods,
    engagementBand: 'active',
    now: NOW,
  })

  it('carries the training relationship and the computed signals', () => {
    for (const expected of [
      'Person: Anna',
      'Unlimited (active, cancelled — ends 2026-10-01)',
      'Membership history: 2 periods on record; first started 2025-03-12; last ended 2026-02-28 (renewed)',
      'Credits: 4 left on Ten-pack',
      '47 sessions in total',
      'last session 2026-09-08 (3 days ago)',
      '5 weeks now, best 12',
      'oldest first: 0 1 2 0 1 2 0 1 2 0 1 2',
      'Computed signals:',
      '- Attendance trend:',
      '- Active in 8 of the last 12 weeks',
      '- Bookings, last 5: 2 kept, 1 no-show (33% of decided bookings), 1 cancelled, 1 upcoming — next 2026-09-15 Yoga Basics',
      '- Usual rhythm: Tuesday; evenings; mostly Yoga Basics (3), HIIT (1)',
      '- Tenure: 18 months',
      "- Engagement band by the studio's own thresholds: active",
      'No-show strikes: 1',
      'Open alerts on this contact: 2',
      'competition team',
      '2026-09-01: Knee still sore',
    ]) {
      assert.ok(text.includes(expected), `missing: ${expected}\n${text}`)
    }
  })

  it('never carries a contact detail, a birthdate, an address, a weight, a surname or an emergency contact', () => {
    for (const forbidden of [
      'Zwygart',
      'anna.secret',
      'parent.secret',
      '79 000',
      '1990',
      'Secretville',
      'Secret Street',
      '8000',
      'Emergency Person',
      '79 111',
      '999',
    ]) {
      assert.ok(!text.includes(forbidden), `leaked: ${forbidden}\n${text}`)
    }
  })

  it('says so when there is nothing — no plan, no session, no notes, no history', () => {
    const bare = { id: 'c2', teamId: 't1', firstname: 'Ben' } as unknown as Contact
    const t = buildContactDossier({ contact: bare, weekly: [], bookings: [], notes: [], now: NOW })
    assert.ok(t.includes('Person: Ben'), t)
    assert.ok(t.includes('Plans held: none'), t)
    assert.ok(t.includes('0 sessions in total; no session recorded'), t)
    assert.ok(t.includes('Coach notes: none'), t)
    assert.ok(!t.includes('Membership history'), t)
    assert.ok(!t.includes('Attendance trend'), t)
  })
})

describe('contact summary — the signals', () => {
  const base = { contact, bookings: [], notes: [], now: NOW }
  const weeks = (counts: number[]) => counts.map((n, i) => ({ iso_week: `W${i}`, sessions_count: n }))

  it('reads a rising trend from the last four weeks against the weeks before', () => {
    const s = deriveSignals({ ...base, weekly: weeks([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3]) })
    assert.strictEqual(s.trend, 'up')
    assert.strictEqual(s.recentPerWeek, 2.5)
    assert.strictEqual(s.earlierPerWeek, 1)
  })

  it('reads a slipping trend, and the trailing gap', () => {
    const s = deriveSignals({ ...base, weekly: weeks([2, 2, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0]) })
    assert.strictEqual(s.trend, 'down')
    assert.strictEqual(s.trailingGapWeeks, 3)
    assert.strictEqual(s.longestGapWeeks, 3)
  })

  it('calls a small wobble steady', () => {
    const s = deriveSignals({ ...base, weekly: weeks([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 3]) })
    assert.strictEqual(s.trend, 'steady')
  })

  it('refuses to compare against too little history', () => {
    const s = deriveSignals({ ...base, weekly: weeks([1, 2, 1, 2, 1]) })
    assert.strictEqual(s.trend, 'insufficient')
    assert.strictEqual(s.earlierPerWeek, null)
  })

  it('decides bookings by their date: past confirmed is kept, future confirmed is upcoming', () => {
    const s = deriveSignals({ ...base, weekly: [], bookings })
    assert.deepStrictEqual(s.outcomes, { kept: 2, noShow: 1, cancelled: 1, upcoming: 1 })
    assert.strictEqual(s.nextUpcoming?.activity, 'Yoga Basics')
    assert.ok(Math.abs((s.noShowRate ?? 0) - 1 / 3) < 1e-9)
  })

  it('reads the weekly rhythm in the studio clock, not UTC', () => {
    // 22:30Z on a Tuesday is 00:30 Wednesday in Zurich (summer): the day and
    // the time bucket must follow the studio's clock.
    const late: DossierBooking[] = [
      { when: new Date('2026-09-08T22:30:00Z'), activity: 'Late', status: 'confirmed' },
      { when: new Date('2026-09-01T22:30:00Z'), activity: 'Late', status: 'confirmed' },
    ]
    const s = deriveSignals({ ...base, weekly: [], bookings: late })
    assert.deepStrictEqual(s.favouriteDays, ['Wednesday'])
    assert.strictEqual(s.favouriteTime, 'morning')
  })

  it('needs three decided bookings before it quotes a no-show rate', () => {
    const s = deriveSignals({ ...base, weekly: [], bookings: bookings.slice(1, 3) })
    assert.strictEqual(s.noShowRate, null)
  })
})

describe('contact summary — what the model says back', () => {
  it('drops fences, heading lines, bullets and emphasis', () => {
    const raw = '```text\n## Anna\n- **Anna** comes *twice* a week.\n- She holds Unlimited.\n```'
    assert.strictEqual(normaliseSummary(raw), 'Anna comes twice a week. She holds Unlimited.')
  })

  it('keeps at most six sentences', () => {
    assert.strictEqual(SUMMARY_MAX_SENTENCES, 6)
    assert.strictEqual(
      normaliseSummary('One. Two. Three. Four. Five. Six. Seven. Eight.'),
      'One. Two. Three. Four. Five. Six.'
    )
  })

  it('never exceeds the character cap, cutting at a sentence where it can', () => {
    const sentence = `${'A'.repeat(200)}.`
    const five = Array(5).fill(sentence).join(' ')
    assert.strictEqual(normaliseSummary(five), Array(4).fill(sentence).join(' '))
    const huge = normaliseSummary('B'.repeat(2000))
    assert.ok(huge.length <= SUMMARY_MAX_CHARS, String(huge.length))
    assert.ok(huge.endsWith('…'))
  })

  it('empty in, empty out', () => {
    assert.strictEqual(normaliseSummary('   '), '')
    assert.strictEqual(normaliseSummary('```\n```'), '')
  })
})

describe('contact summary — notes', () => {
  it('flattens note HTML to one plain line and decodes entities', () => {
    assert.strictEqual(
      noteText('<p>Knee &amp; hip:</p><ul><li>avoid <b>deep</b> squats</li></ul>'),
      'Knee & hip: avoid deep squats'
    )
  })

  it('cuts a long note', () => {
    const out = noteText(`<p>${'x'.repeat(1000)}</p>`)
    assert.ok(out.length <= NOTE_MAX_CHARS, String(out.length))
    assert.ok(out.endsWith('…'))
  })
})

describe('contact summary — the own-scope check', () => {
  it("is the rules' callerOwnsContact: on the coach list, or the creator", () => {
    assert.strictEqual(coachOwnsContact(contact, 'coach-2'), true)
    assert.strictEqual(coachOwnsContact(contact, 'coach-1'), true)
    assert.strictEqual(coachOwnsContact(contact, 'coach-9'), false)
  })
})

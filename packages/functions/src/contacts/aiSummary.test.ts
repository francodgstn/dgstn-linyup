import * as assert from 'node:assert'
import type { Contact } from '@linyup/shared'
import {
  NOTE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  buildContactDossier,
  coachOwnsContact,
  normaliseSummary,
  noteText,
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
    },
  ],
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
const bookings = [{ when: new Date('2026-09-08T18:00:00Z'), activity: 'Yoga Basics', status: 'confirmed' }]
const notes = [{ when: new Date('2026-09-01'), text: 'Knee still sore, avoid deep squats' }]

describe('contact summary — the dossier the model sees', () => {
  const text = buildContactDossier({ contact, weekly, bookings, notes, now: NOW })

  it('carries the training relationship', () => {
    for (const expected of [
      'Person: Anna',
      'Unlimited (active)',
      '47 sessions in total',
      'last session 2026-09-08 (3 days ago)',
      '5 weeks now, best 12',
      'oldest first: 0 1 2 0 1 2 0 1 2 0 1 2',
      '2026-09-08 Yoga Basics (confirmed)',
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

  it('says so when there is nothing — no plan, no session, no notes', () => {
    const bare = { id: 'c2', teamId: 't1', firstname: 'Ben' } as unknown as Contact
    const t = buildContactDossier({ contact: bare, weekly: [], bookings: [], notes: [], now: NOW })
    assert.ok(t.includes('Person: Ben'), t)
    assert.ok(t.includes('Plans held: none'), t)
    assert.ok(t.includes('0 sessions in total; no session recorded'), t)
    assert.ok(t.includes('Coach notes: none'), t)
  })
})

describe('contact summary — what the model says back', () => {
  it('drops fences, heading lines, bullets and emphasis', () => {
    const raw = '```text\n## Anna\n- **Anna** comes *twice* a week.\n- She holds Unlimited.\n```'
    assert.strictEqual(normaliseSummary(raw), 'Anna comes twice a week. She holds Unlimited.')
  })

  it('keeps at most three sentences', () => {
    assert.strictEqual(normaliseSummary('One. Two. Three. Four. Five.'), 'One. Two. Three.')
  })

  it('never exceeds the character cap, cutting at a sentence where it can', () => {
    const sentence = `${'A'.repeat(200)}.`
    assert.strictEqual(
      normaliseSummary(`${sentence} ${sentence} ${sentence}`),
      `${sentence} ${sentence}`
    )
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

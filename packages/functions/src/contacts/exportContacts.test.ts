import assert from 'node:assert/strict'
import { toContactsCsv, CONTACT_CSV_COLUMNS } from '@linyup/shared'

/** A Firestore-shaped Timestamp, which is what the real rows carry. */
const ts = (iso: string) => ({ toDate: () => new Date(iso) })

function rows(csv: string): string[] {
  return csv.trimEnd().split('\r\n')
}

describe('toContactsCsv', () => {
  it('always emits a header, even with no contacts', () => {
    const out = rows(toContactsCsv([]))
    assert.equal(out.length, 1)
    assert.equal(out[0], CONTACT_CSV_COLUMNS.join(','))
  })

  // The failure this guards is silent and destroys the file: a comma in a name
  // shifts every later column by one, and nothing errors.
  it('quotes fields containing a comma, a quote or a newline', () => {
    const csv = toContactsCsv([
      { id: 'c1', lastname: 'Müller, Anna', notes: 'said "yes"\nthen left' },
    ])
    const line = rows(csv)[1]
    assert.match(line, /"Müller, Anna"/)
    assert.match(line, /"said ""yes""\nthen left"/)
  })

  it('renders timestamps as ISO, and a birthdate as a date only', () => {
    const csv = toContactsCsv([
      { id: 'c1', birthdate: ts('1990-04-05T00:00:00Z'), created_at: ts('2026-01-02T03:04:05Z') },
    ])
    const line = rows(csv)[1]
    assert.match(line, /1990-04-05(,|$)/)
    assert.ok(line.includes('2026-01-02T03:04:05.000Z'))
    assert.ok(!line.includes('1990-04-05T'), 'birthdate must carry no time')
  })

  it('flattens the address map and the emergency-contact list', () => {
    const csv = toContactsCsv([
      {
        id: 'c1',
        address: { route: 'Kleinhüningerstrasse', street_number: '205', postal_code: '4057', locality: 'Basel' },
        emergency_contacts: [{ name: 'Ana', phone: '+41 79 000 00 00' }],
      },
    ])
    const line = rows(csv)[1]
    assert.ok(line.includes('Kleinhüningerstrasse 205, 4057 Basel'))
    assert.ok(line.includes('Ana +41 79 000 00 00'))
  })

  // An id means nothing once the file leaves us — the point of an export is that
  // it survives leaving.
  it('resolves group ids to names, and falls back to the id when unknown', () => {
    const csv = toContactsCsv([{ id: 'c1', group_ids: ['g1', 'g-missing'] }], {
      groupNames: new Map([['g1', 'Adults']]),
    })
    assert.ok(rows(csv)[1].includes('Adults; g-missing'))
  })

  it('appends one column per custom field, in the studio order', () => {
    const csv = toContactsCsv([{ id: 'c1', custom_fields: { belt: 'blue', risk: true } }], {
      customFields: [
        { id: 'belt', label: 'Belt' },
        { id: 'risk', label: 'Payment risk' },
      ],
    })
    const [header, line] = rows(csv)
    assert.ok(header.endsWith('Belt,Payment risk'))
    assert.ok(line.endsWith('blue,yes'), 'booleans read as yes/no, not true/false')
  })

  // Two fields may share a label. Without the id suffix the two columns look
  // identical and a reader cannot tell which is which.
  it('disambiguates duplicate custom-field labels with the field id', () => {
    const csv = toContactsCsv([{ id: 'c1', custom_fields: { a: '1', b: '2' } }], {
      customFields: [
        { id: 'a', label: 'Notes' },
        { id: 'b', label: 'Notes' },
      ],
    })
    assert.ok(rows(csv)[0].endsWith('Notes (a),Notes (b)'))
  })

  it('leaves a missing custom-field value empty rather than writing undefined', () => {
    const csv = toContactsCsv([{ id: 'c1' }], { customFields: [{ id: 'belt', label: 'Belt' }] })
    const line = rows(csv)[1]
    assert.ok(line.endsWith(','), 'trailing empty cell')
    assert.ok(!line.includes('undefined'))
  })

  // docs/multi-plan-holdings.md §5: every held plan, not the legacy slot's one.
  it('lists every plan held at export time, and none that has ended or not begun', () => {
    const DAY = 86_400_000
    const now = Date.parse('2026-09-25T12:00:00Z')
    const plan = (over: Record<string, unknown>) => ({
      subscription_type_id: 't',
      subscription_type_name: null,
      source: 'grant',
      status: 'active',
      starts_at_ms: now - 30 * DAY,
      ends_at_ms: null,
      price_id: null,
      amount: null,
      recurrence: null,
      ref: 'r',
      ...over,
    })
    const csv = toContactsCsv(
      [
        {
          id: 'c1',
          subscription_type_name: 'Legacy slot',
          held_plans: [
            plan({ subscription_type_name: 'Gold', source: 'stripe', status: 'past_due' }),
            plan({
              subscription_type_name: 'Kids',
              grant_source: 'purchase',
              ends_at_ms: Date.parse('2026-12-31T00:00:00Z'),
            }),
            plan({ subscription_type_name: '10er', source: 'credits', credits_remaining: 4 }),
            plan({ subscription_type_name: 'Ended', ends_at_ms: now - DAY }),
            plan({ subscription_type_name: 'Future', starts_at_ms: now + DAY }),
            plan({ subscription_type_name: 'Empty pack', source: 'credits', credits_remaining: 0 }),
          ],
        },
      ],
      { nowMs: now }
    )
    const [header, line] = rows(csv)
    assert.ok(header.includes(',plans,'))
    assert.ok(!header.includes('subscription_type'))
    assert.ok(
      line.includes(
        'Gold (recurring billing, past_due); Kids (bought, until 2026-12-31); 10er (credit pack, 4 left)'
      ),
      line
    )
    for (const gone of ['Legacy slot', 'Ended', 'Future', 'Empty pack'])
      assert.ok(!line.includes(gone), gone)
  })

  it('emits one row per contact, in the order given', () => {
    const csv = toContactsCsv([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const out = rows(csv)
    assert.equal(out.length, 4)
    assert.ok(out[1].startsWith('a,'))
    assert.ok(out[3].startsWith('c,'))
  })
})

import assert from 'node:assert/strict'
import { Timestamp } from 'firebase-admin/firestore'
import { buildContactFieldPatch } from './contactFields'
import { resolveBookingContactFields } from '@linyup/shared'
import type { CustomFieldDefinition } from '@linyup/shared'

const DEFS: CustomFieldDefinition[] = [
  { id: 'swim_level', label: 'Swim level', type: 'select', options: ['Beginner', 'Advanced'], publicOnBookingForm: true },
  { id: 'notes_internal', label: 'Payment risk', type: 'text' }, // never opted in
]

describe('resolveBookingContactFields — team default + activity, and the legacy fallback', () => {
  it('EXTENDS rather than replaces: a kids class adds to what the team asks', () => {
    const fields = resolveBookingContactFields(
      { showPhone: true, contactFields: [{ key: 'phone' }, { key: 'custom:swim_level' }] },
      [{ key: 'birthdate', required: true }]
    )
    assert.deepEqual(fields.map((f) => f.key), ['phone', 'custom:swim_level', 'birthdate'])
  })

  it('lets the ACTIVITY win on required-ness without restating the rest', () => {
    const fields = resolveBookingContactFields(
      { showPhone: true, contactFields: [{ key: 'phone' }] },
      [{ key: 'phone', required: true }]
    )
    assert.deepEqual(fields, [{ key: 'phone', required: true }])
  })

  it('falls back to showPhone ONLY while the new list is absent', () => {
    // A team that never edited the new list keeps its old phone behavior…
    assert.deepEqual(resolveBookingContactFields({ showPhone: true }, null), [{ key: 'phone' }])
    assert.deepEqual(resolveBookingContactFields({ showPhone: false }, null), [])
    // …and one that HAS edited it is never second-guessed by the old boolean.
    assert.deepEqual(
      resolveBookingContactFields({ showPhone: false, contactFields: [{ key: 'phone' }] }, null),
      [{ key: 'phone' }]
    )
  })
})

describe('buildContactFieldPatch — the payload is narrowed, never merged', () => {
  const fields = [{ key: 'phone' }, { key: 'custom:swim_level' }]

  it('keeps only what the resolved list names', () => {
    const patch = buildContactFieldPatch({
      fields,
      // Everything after `phone` is an attacker writing fields nobody asked for.
      answers: {
        phone: '+41 79 000 00 00',
        archived_at: 'now',
        subscription_type_id: 'free-forever',
        teamId: 'someone-elses-team',
      },
      definitions: DEFS,
    })
    assert.deepEqual(patch, { phone: '+41 79 000 00 00' })
  })

  it('REFUSES a custom field that never opted in, however the payload arrives', () => {
    const patch = buildContactFieldPatch({
      fields: [...fields, { key: 'custom:notes_internal' }],
      answers: { 'custom:notes_internal': 'poked' },
      definitions: DEFS,
    })
    assert.deepEqual(patch, {}, 'an un-ticked definition is refused at the write, not merely hidden')
  })

  it('drops a select value outside its own options rather than guessing', () => {
    assert.deepEqual(
      buildContactFieldPatch({ fields, answers: { 'custom:swim_level': 'Olympian' }, definitions: DEFS }),
      {}
    )
    assert.deepEqual(
      buildContactFieldPatch({ fields, answers: { 'custom:swim_level': 'Advanced' }, definitions: DEFS }),
      { 'custom_fields.swim_level': 'Advanced' }
    )
  })

  it('NEVER blanks a stored value with an empty answer', () => {
    // The failure this prevents: a member with a phone on file books, leaves the
    // prefilled box untouched, and the client posts ''. Treating that as an edit
    // would delete a number the studio collected months ago, silently.
    for (const empty of ['', '   ', null, undefined]) {
      assert.deepEqual(
        buildContactFieldPatch({ fields, answers: { phone: empty }, definitions: DEFS }),
        {},
        `empty answer ${JSON.stringify(empty)} must not reach the patch`
      )
    }
  })

  it('writes a custom answer under its dotted path, not as a top-level key', () => {
    const patch = buildContactFieldPatch({
      fields,
      answers: { 'custom:swim_level': 'Beginner' },
      definitions: DEFS,
    })
    assert.deepEqual(patch, { 'custom_fields.swim_level': 'Beginner' })
  })

  it('ignores a base key the vocabulary does not allow', () => {
    assert.deepEqual(
      buildContactFieldPatch({ fields: [{ key: 'email' }], answers: { email: 'x@y.z' }, definitions: DEFS }),
      {},
      'firstname/lastname/email are always collected by the form itself, never through this list'
    )
  })
})

describe('buildContactFieldPatch — the two base fields that are not strings', () => {
  it('stores a birthdate as a TIMESTAMP, not the string the date input posted', () => {
    const patch = buildContactFieldPatch({
      fields: [{ key: 'birthdate' }],
      answers: { birthdate: '2014-03-09' },
      definitions: DEFS,
    })
    const ts = patch.birthdate as Timestamp
    assert.ok(ts instanceof Timestamp, 'Contact.birthdate is a Timestamp — a string there is unreadable')
    assert.equal(ts.toDate().toISOString().slice(0, 10), '2014-03-09')
  })

  it('drops a birthdate it cannot trust rather than coercing one', () => {
    for (const bad of ['09.03.2014', '2014-02-31', 'yesterday', '1014-03-09', 42]) {
      assert.deepEqual(
        buildContactFieldPatch({ fields: [{ key: 'birthdate' }], answers: { birthdate: bad }, definitions: DEFS }),
        {},
        `${JSON.stringify(bad)} must not become a date`
      )
    }
  })

  it('writes an address as its four known parts, merged over what is stored', () => {
    const patch = buildContactFieldPatch({
      fields: [{ key: 'address' }],
      answers: {
        address: { route: ' Bahnhofstrasse ', street_number: '12', locality: 'Zürich', country: 'CH' },
      },
      definitions: DEFS,
      existing: { address: { postal_code: '8001' } },
    })
    assert.deepEqual(patch, {
      // `country` is not a member of ContactAddress and is dropped; the stored
      // postcode survives because this answer said nothing about it.
      address: { postal_code: '8001', route: 'Bahnhofstrasse', street_number: '12', locality: 'Zürich' },
    })
  })

  it('never overwrites a stored address with an empty one', () => {
    assert.deepEqual(
      buildContactFieldPatch({
        fields: [{ key: 'address' }],
        answers: { address: { route: '', locality: '  ' } },
        definitions: DEFS,
        existing: { address: { locality: 'Basel' } },
      }),
      {}
    )
  })
})

describe('buildContactFieldPatch — the partner-app answer', () => {
  const allowed = ['FitPass Partner', 'SportPass']

  it('stores the STUDIO’s spelling, whatever case was posted', () => {
    assert.deepEqual(
      buildContactFieldPatch({
        fields: [],
        answers: null,
        definitions: DEFS,
        partnerApp: { value: '  fitpass partner ', allowed },
      }),
      { acquisition_partner_app: 'FitPass Partner' }
    )
  })

  it('drops a name this studio does not accept', () => {
    // The public form is anonymous; the posted string is a claim, not a fact.
    assert.deepEqual(
      buildContactFieldPatch({
        fields: [],
        answers: null,
        definitions: DEFS,
        partnerApp: { value: 'ClassPass', allowed },
      }),
      {}
    )
    // …and a studio with no partner types accepts nothing at all.
    assert.deepEqual(
      buildContactFieldPatch({
        fields: [],
        answers: null,
        definitions: DEFS,
        partnerApp: { value: 'FitPass Partner', allowed: [] },
      }),
      {}
    )
  })

  it('treats the "not using one" sentinel as no answer, leaving a stored value alone', () => {
    // The form posts '' for "I don't use one" — which must not erase what a
    // previous booking recorded, the same rule an untouched phone box gets.
    for (const value of ['', '   ', null, undefined, 42]) {
      assert.deepEqual(
        buildContactFieldPatch({
          fields: [],
          answers: null,
          definitions: DEFS,
          partnerApp: { value, allowed },
        }),
        {}
      )
    }
  })

  it('writes nothing when the caller never asked', () => {
    assert.deepEqual(
      buildContactFieldPatch({ fields: [{ key: 'phone' }], answers: { phone: '079' }, definitions: DEFS }),
      { phone: '079' }
    )
  })
})

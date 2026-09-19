import assert from 'node:assert/strict'
import { withDefinedParameters } from './activityParameters'

// The Admin SDK refuses `undefined` anywhere in a document, and the activity
// logger swallows the error — so a booking with no name lost its whole row.
// Seen on the member-app review tenant's seeded booking (contact id only).

/** Every `undefined` reachable in a value, as dotted paths. */
function undefinedPaths(value: unknown, path = ''): string[] {
  if (value === undefined) return [path]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    undefinedPaths(v, path ? `${path}.${k}` : k)
  )
}

describe('withDefinedParameters', () => {
  it('drops the name of a booking that carries none — the trackBookings shape', () => {
    const booking: Record<string, unknown> = { contact: 'linyup-demo-reviewer', status: 'confirmed' }
    const entry = withDefinedParameters({
      event: 'booking_confirmed',
      parameters: {
        description: 'linyup-demo-reviewer confirmed for session on Sep 19th, 2026.',
        contact_firstname: booking.firstname,
        contact_lastname: booking.lastname,
        session_date: null,
        session_id: 's1',
        from_bio_link: false,
      },
      refs: { contact: booking.contact, session: 's1' },
    })

    assert.deepEqual(undefinedPaths(entry), [])
    assert.equal('contact_firstname' in entry.parameters, false)
    assert.equal('contact_lastname' in entry.parameters, false)
  })

  it('keeps null, false, empty strings and zero — only undefined is dropped', () => {
    const entry = withDefinedParameters({
      parameters: { a: null, b: false, c: '', d: 0, e: undefined },
    })
    assert.deepEqual(entry.parameters, { a: null, b: false, c: '', d: 0 })
  })

  it('keeps a named booking untouched', () => {
    const parameters = { contact_firstname: 'Alex', contact_lastname: 'Reviewer' }
    assert.deepEqual(withDefinedParameters({ parameters }).parameters, parameters)
  })

  it('passes an entry without parameters through', () => {
    const entry = { event: 'x' }
    assert.equal(withDefinedParameters(entry), entry)
  })
})

import * as assert from 'node:assert'
import { personInitials, nameInitials } from '@linyup/shared'

// The fallback is the rule: every surface shows "?" for a nameless person,
// never an empty bubble (the app used to; the web never did).

describe('personInitials', () => {
  it('upper-cases the first letter of each name', () => {
    assert.strictEqual(personInitials({ firstname: 'ada', lastname: 'lovelace' }), 'AL')
  })

  it('one name is enough', () => {
    assert.strictEqual(personInitials({ firstname: 'Ada' }), 'A')
    assert.strictEqual(personInitials({ lastname: 'Lovelace', firstname: null }), 'L')
  })

  it('falls back to "?" rather than an empty bubble', () => {
    assert.strictEqual(personInitials({}), '?')
    assert.strictEqual(personInitials({ firstname: '', lastname: null }), '?')
  })
})

describe('nameInitials', () => {
  it('takes the first letter of the first two words', () => {
    assert.strictEqual(nameInitials('Ada Lovelace'), 'AL')
    assert.strictEqual(nameInitials('  ada   king  lovelace '), 'AK')
  })

  it('a single word — a first name, or the email a coach falls back to — gives one letter', () => {
    assert.strictEqual(nameInitials('Ada'), 'A')
    assert.strictEqual(nameInitials('ada@example.com'), 'A')
  })

  it('nothing → "?"', () => {
    assert.strictEqual(nameInitials(''), '?')
    assert.strictEqual(nameInitials('   '), '?')
    assert.strictEqual(nameInitials(null), '?')
    assert.strictEqual(nameInitials(undefined), '?')
  })
})

import assert from 'node:assert/strict'
import { allocateNumber, DOCUMENT_NUMBER_MAX, formatDocumentNumber } from './numbering'

describe('formatDocumentNumber', () => {
  it('pads n to 5 digits', () => {
    assert.equal(formatDocumentNumber('TAR', 2026, 1), 'TAR-2026-00001')
    assert.equal(formatDocumentNumber('TAR', 2026, 42), 'TAR-2026-00042')
    assert.equal(formatDocumentNumber('TAR', '2026', 12345), 'TAR-2026-12345')
  })

  it('throws when the formatted number exceeds DOCUMENT_NUMBER_MAX characters', () => {
    const longPrefix = 'A'.repeat(30)
    assert.throws(() => formatDocumentNumber(longPrefix, 2026, 1))
    // Sanity: the threshold is real, not always-throwing.
    assert.ok(formatDocumentNumber('TAR', 2026, 1).length <= DOCUMENT_NUMBER_MAX)
  })
})

// A minimal fake transaction: just enough of `get`/`set` for `allocateNumber`
// to drive, backed by an in-memory map keyed by the ref's `path`.
function fakeTx(store: Map<string, unknown>) {
  return {
    get: async (ref: { path: string }) => {
      const data = store.get(ref.path)
      return { exists: data !== undefined, data: () => data }
    },
    set: (ref: { path: string }, value: unknown) => {
      store.set(ref.path, value)
    },
  } as unknown as FirebaseFirestore.Transaction
}

describe('allocateNumber', () => {
  it('first call in a year allocates 1', async () => {
    const store = new Map<string, unknown>()
    const tx = fakeTx(store)
    const ref = { path: 'counters/tar-2026' } as unknown as FirebaseFirestore.DocumentReference
    const result = await allocateNumber(tx, ref, 'TAR', '2026')
    assert.deepEqual(result, { number: 'TAR-2026-00001', last: 1 })
  })

  it('a second call the same year allocates last + 1', async () => {
    const store = new Map<string, unknown>()
    const tx = fakeTx(store)
    const ref = { path: 'counters/tar-2026' } as unknown as FirebaseFirestore.DocumentReference
    const first = await allocateNumber(tx, ref, 'TAR', '2026')
    const second = await allocateNumber(tx, ref, 'TAR', '2026')
    assert.equal(first.last, 1)
    assert.equal(second.last, 2)
    assert.equal(second.number, 'TAR-2026-00002')
  })

  it('a new year resets to 1', async () => {
    const store = new Map<string, unknown>()
    const tx = fakeTx(store)
    const ref = { path: 'counters/tar' } as unknown as FirebaseFirestore.DocumentReference
    await allocateNumber(tx, ref, 'TAR', '2026')
    await allocateNumber(tx, ref, 'TAR', '2026')
    const thirdNewYear = await allocateNumber(tx, ref, 'TAR', '2027')
    assert.deepEqual(thirdNewYear, { number: 'TAR-2027-00001', last: 1 })
  })

  it('writes an absolute `last`, never an increment sentinel', async () => {
    const store = new Map<string, unknown>()
    const tx = fakeTx(store)
    const ref = { path: 'counters/tar' } as unknown as FirebaseFirestore.DocumentReference
    await allocateNumber(tx, ref, 'TAR', '2026')
    await allocateNumber(tx, ref, 'TAR', '2026')
    const written = store.get('counters/tar') as { last: number; year: string }
    assert.equal(typeof written.last, 'number')
    assert.equal(written.last, 2)
    assert.equal(written.year, '2026')
  })
})

import assert from 'node:assert/strict'
import { Timestamp } from 'firebase-admin/firestore'
import {
  contactDeletionState,
  anonymizedContactPatch,
  CONTACT_IDENTIFYING_FIELDS,
  CONTACT_DELETION_GRACE_DAYS,
} from '@linyup/shared'

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const ts = (ms: number) => Timestamp.fromMillis(ms) as unknown as never

describe('contactDeletionState — the window, and its ends', () => {
  it('is none when nothing was ever requested', () => {
    assert.equal(contactDeletionState({}, NOW), 'none')
    assert.equal(contactDeletionState(null, NOW), 'none')
  })

  it('is scheduled inside the window — the account still works', () => {
    const c = { deletion_scheduled_for: ts(NOW + 5 * 86400_000) }
    assert.equal(contactDeletionState(c, NOW), 'scheduled')
  })

  it('is due once the date passes, and stays due until the sweep runs', () => {
    assert.equal(contactDeletionState({ deletion_scheduled_for: ts(NOW - 1) }, NOW), 'due')
    // Hours later, still due — the sweep is nightly, and a cancel must work in
    // that gap.
    assert.equal(
      contactDeletionState({ deletion_scheduled_for: ts(NOW - 1) }, NOW + 6 * 3600_000),
      'due'
    )
  })

  it('anonymized wins over everything — it is terminal', () => {
    const c = { anonymized_at: ts(NOW - 86400_000), deletion_scheduled_for: ts(NOW + 86400_000) }
    assert.equal(contactDeletionState(c, NOW), 'anonymized')
  })
})

describe('anonymizedContactPatch — what actually stops identifying somebody', () => {
  const patch = anonymizedContactPatch(NOW)

  it('clears every field on the identifying list', () => {
    for (const field of CONTACT_IDENTIFYING_FIELDS) {
      assert.ok(field in patch, `${field} must be written, not merely omitted`)
    }
  })

  it('CLEARS login_emails — the parent-access allow-list', () => {
    // The one that bites: leave it and the account is anonymized but still
    // reachable by whoever controls one of those inboxes, which is worse than
    // not deleting it because it looks done.
    assert.equal(patch.login_emails, null)
  })

  it('nulls the email rather than replacing it, so nothing can match on it', () => {
    assert.equal(patch.email, null)
    assert.equal(patch.phone, null)
  })

  it('leaves a readable placeholder name instead of a blank row', () => {
    assert.equal(patch.firstname, 'Deleted')
    assert.equal(patch.lastname, 'account')
  })

  it('spends the request, so the sweep cannot select the row again', () => {
    assert.equal(patch.deletion_requested_at, null)
    assert.equal(patch.deletion_scheduled_for, null)
    assert.ok(patch.anonymized_at instanceof Date)
  })

  it('archives rather than deletes — the studio keeps a coherent history', () => {
    assert.ok(patch.archived_at instanceof Date)
    assert.ok(!('deleted_at' in patch), 'a self-deletion is not the staff delete path')
  })

  it('writes every key EXPLICITLY, never undefined', () => {
    // A merge that omits a key leaves the old value standing, which is exactly
    // the failure this patch exists to avoid.
    for (const [key, value] of Object.entries(patch)) {
      assert.notEqual(value, undefined, `${key} must not be undefined`)
    }
  })

  it('keeps the grace period at the convention everyone already knows', () => {
    assert.equal(CONTACT_DELETION_GRACE_DAYS, 30)
  })
})

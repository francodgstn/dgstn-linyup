import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTACT_PLUGIN_RECORDS, TARIF595_CONTACTS_SUBCOLLECTION, TARIF595_CONTACT_SELF_FIELDS } from '@linyup/shared'

// Two lists that live in two places on purpose, pinned to each other here:
//
//   • the fields a CONTACT may write on their own tarif595_contacts row —
//     TARIF595_CONTACT_SELF_FIELDS in @linyup/shared (what the Space form
//     writes) and the literal `hasOnly([...])` in firestore.rules (what the
//     server allows). Rules cannot import a constant, so the copy is checked.
//   • the plugin-owned records the anonymisation sweep removes with the
//     identity — CONTACT_PLUGIN_RECORDS (the census, beside the field list in
//     utils/contactDeletion.ts) and the sweep's own source.

function findUp(file: string): string {
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, file)
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8').replace(/\r\n/g, '\n')
    dir = join(dir, '..')
  }
  throw new Error(`${file} not found above ${__dirname}`)
}

describe('tarif595 — the contact self-write list, rules ↔ shared', () => {
  const rules = findUp('firestore.rules')
  const block = rules.slice(rules.indexOf('match /tarif595_contacts/{contactId}'), rules.indexOf('match /tarif595_receipts/{receiptId}'))

  it('the rules block exists and gates the contact arm on the session AND the document id', () => {
    assert.ok(block.length > 0, 'tarif595_contacts block not found')
    assert.match(block, /isContactOfTeam\(teamId\) && request\.auth\.token\.contactId == contactId/)
  })

  it('every hasOnly list in the block is exactly TARIF595_CONTACT_SELF_FIELDS', () => {
    const lists = [...block.matchAll(/hasOnly\(\[([^\]]*)\]\)/g)].map((m) =>
      m[1]
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter(Boolean)
        .sort()
    )
    assert.equal(lists.length, 2, 'one list for create (keys), one for update (affectedKeys)')
    for (const list of lists) assert.deepEqual(list, [...TARIF595_CONTACT_SELF_FIELDS].sort())
  })

  it('the manager-only fields are not on the list', () => {
    for (const field of ['insurer_gln', 'sex_override', 'guardian', 'updated_by']) {
      assert.ok(!(TARIF595_CONTACT_SELF_FIELDS as readonly string[]).includes(field), `${field} decides what a legal document says`)
    }
  })

  it('the contact never deletes the row — the sweep does', () => {
    assert.match(block, /allow delete: if hasTeamRole\(teamId, 'manager'\) \|\| hasTeamRole\(teamId, 'owner'\);/)
  })
})

describe('tarif595 — the anonymisation arm', () => {
  const sweep = readFileSync(join(__dirname, '..', 'dailyTasks', 'anonymizeScheduledContacts.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('the census names the insurer row, and the sweep deletes it in the same batch as the patch', () => {
    assert.ok((CONTACT_PLUGIN_RECORDS as readonly string[]).includes(TARIF595_CONTACTS_SUBCOLLECTION))
    assert.match(sweep, /batch\.update\(doc\.ref, anonymizedContactPatch\(nowMs\)\)/)
    assert.match(sweep, /batch\.delete\([\s\S]*TARIF595_CONTACTS_SUBCOLLECTION[\s\S]*\.doc\(doc\.id\)\)/)
  })

  it('every record on the census is acted on by the sweep', () => {
    for (const record of CONTACT_PLUGIN_RECORDS) {
      const constant = `${record.toUpperCase()}_SUBCOLLECTION`
      assert.match(sweep, new RegExp(constant), `the sweep does not touch ${record} (add it there AND to the census, never to one alone)`)
    }
  })

  it('receipts are kept — nothing in the sweep touches tarif595_receipts', () => {
    assert.ok(!/tarif595_receipts|TARIF595_RECEIPTS_SUBCOLLECTION/.test(sweep), 'a receipt is a record of a document handed out')
  })
})

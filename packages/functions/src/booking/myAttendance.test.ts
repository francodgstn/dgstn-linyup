import * as assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// THE MEMBER'S OWN ATTENDANCE — three properties, all of them read off the
// SOURCE, because the failure modes here are shapes rather than values and a
// unit test of the handler would need the whole Admin SDK to express them.

const src = readFileSync(resolve(__dirname, 'myAttendance.ts'), 'utf8')
const mobile = readFileSync(
  resolve(__dirname, '../../../../apps/mobile/src/services/firestore.ts'),
  'utf8',
)

describe('getMyAttendance', () => {
  // A contactId on the wire would make this an attendance enumerator for every
  // member of the team — the same hazard utils/contactSession.ts exists for,
  // and the reason getMyBookings takes only a teamId.
  it('takes identity from the contact session and never from the payload', () => {
    assert.match(src, /requireContactSessionForTeam\(request, teamId\)/)
    const payload = /const data = \(request\.data \?\? \{\}\) as \{[^}]*\}/.exec(src)?.[0]
    assert.ok(payload, 'the payload shape is still declared inline')
    assert.doesNotMatch(payload!, /contactId/)
  })

  // The window is the SESSION's clock; the scan is the row's. Filtering only on
  // `checkedInAt` would answer a different question (see the module header),
  // and dropping the scan bound would read her whole history every time.
  it('scans on checkedInAt with a margin and filters on the session start', () => {
    assert.match(src, /\.where\('checkedInAt', '>=',[\s\S]{0,80}ATTENDANCE_SCAN_MARGIN_DAYS|margin/)
    assert.match(src, /startMs < fromMs \|\| startMs > toMs/)
    assert.match(src, /limit\(MY_ATTENDANCE_SCAN_PAGE\)/)
    assert.match(src, /truncated: snap\.size === MY_ATTENDANCE_SCAN_PAGE/)
  })

  // THE POINT OF THE WHOLE CHANGE, and the one property a regex over `getDoc`
  // cannot hold: the fan-out was a participant read inside a loop over the
  // window's sessions, and it was spelled across two statements (build the ref,
  // then read it), so "does `getDoc(` sit next to PARTICIPANTS_SUBCOLLECTION"
  // answers a different question and answers it reassuringly.
  //
  // So this derives the SET of functions in the member app's Firestore service
  // that address a participant document at all, and pins it by NAME. A new one
  // fails here and has to be justified; the survivor is justified below.
  it('only cancelSession addresses a participant document in the member app', () => {
    const owners = new Set<string>()
    const lines = mobile.split('\n')
    lines.forEach((line, i) => {
      // The import of the constant is not a read of a document.
      if (!line.includes('PARTICIPANTS_SUBCOLLECTION') || !line.includes('doc(')) return
      // The nearest enclosing method of the FirestoreService object literal.
      for (let j = i; j >= 0; j--) {
        const m = /^  (?:async )?([A-Za-z][\w]*)\s*\(/.exec(lines[j]!)
        if (m) {
          owners.add(m[1]!)
          return
        }
      }
      owners.add(`<top level, line ${i + 1}>`)
    })
    // `cancelSession` looks one booking up on a user's own tap — a single
    // document read on an action, not a read per row of a list. Every other
    // member-app question about attendance goes through the callable.
    assert.deepStrictEqual(
      [...owners].sort(),
      ['cancelSession'],
      'a new participants read appeared in apps/mobile — if it is per-session, route it through getMyAttendance',
    )
    assert.match(mobile, /'getMyAttendance'/)
  })
})

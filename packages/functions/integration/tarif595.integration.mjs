// End-to-end verification of the Tarif 595 callables against the emulators —
// the plan's verification list, scripted: issue → counter → files → download
// (sha256) → idempotent re-issue → void → re-issue as revision 2 → email
// (send_count) → the attendance path. Real documents, real callables through
// the Functions emulator, real objects in the Storage emulator. Nothing mocked.
//
//   pnpm --filter @linyup/functions build
//   cd packages/functions && FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase emulators:exec \
//     --only auth,firestore,functions,storage --project demo-linyup \
//     "node integration/tarif595.integration.mjs"
// HOSTS COME FROM THE ENVIRONMENT, defaults last. `emulators:exec` exports the
// hosts of the suite it started, and the default ports are often busy on a
// machine running several worktrees — overwriting them here would point this
// script (which WIPES and seeds a team) at somebody else's emulator. The
// functions origin has no standard variable, hence TARIF595_IT_FUNCTIONS_HOST.
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199'
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST
const FUNCTIONS_HOST = process.env.TARIF595_IT_FUNCTIONS_HOST || '127.0.0.1:5001'
import { createHash } from 'node:crypto'
import admin from 'firebase-admin'

admin.initializeApp({ projectId: 'demo-linyup', storageBucket: 'demo-linyup.appspot.com' })
const db = admin.firestore()
const { Timestamp, FieldValue } = admin.firestore

const TEAM = 'verif-595'
const CONTACT = 'verif-595-contact'
const UID = 'verif-595-owner'
const EMAIL = 'owner595@example.com'
const PASSWORD = 'verif595pass'
const FN = `http://${FUNCTIONS_HOST}/demo-linyup/europe-west6`

let pass = 0, fail = 0
const results = []
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  ok ? pass++ : fail++
}

const teamRef = db.collection('teams').doc(TEAM)
const contactRef = db.collection('contacts').doc(CONTACT)
// Phase 2 — the bulk run walks these too: one complete member (issued), one
// without an AHV number (skipped with the reason), one archived (never walked).
const CONTACT2 = 'verif-595-contact2'
const CONTACT3 = 'verif-595-contact3'
const CONTACT4 = 'verif-595-contact4'

async function seedMember(id, { firstname, ahv, start, end, archived = false }) {
  const ref = db.collection('contacts').doc(id)
  await ref.set({
    teamId: TEAM, firstname, lastname: 'Beispiel', email: `${id}@example.com`, gender: 'M',
    birthdate: Timestamp.fromDate(new Date('1990-05-05T00:00:00Z')),
    address: { route: 'Seestrasse', street_number: '1', postal_code: '8002', locality: 'Zürich' },
    archived_at: archived ? Timestamp.now() : null, deleted_at: null, created_at: FieldValue.serverTimestamp(),
  })
  await ref.collection('subscription_history').doc('h').set({
    subscription_type_id: 'verif-type', subscription_type_name: 'Abo', recurrence: 'monthly', amount: 89,
    start_date: Timestamp.fromDate(new Date(`${start}T00:00:00Z`)), end_date: end ? Timestamp.fromDate(new Date(`${end}T00:00:00Z`)) : null,
  })
  if (ahv) await teamRef.collection('tarif595_contacts').doc(id).set({ ahv_number: ahv })
}

async function reset() {
  await db.recursiveDelete(teamRef)
  await db.recursiveDelete(contactRef)
  for (const c of [CONTACT2, CONTACT3, CONTACT4]) await db.recursiveDelete(db.collection('contacts').doc(c))
  await db.collection('activities').doc('verif-595-act').delete().catch(() => {})
  await db.collection('activities').doc('verif-595-act2').delete().catch(() => {})
  for (const s of ['verif-595-s1', 'verif-595-s2', 'verif-595-s3', 'verif-595-s4']) {
    await db.recursiveDelete(db.collection('sessions').doc(s)).catch(() => {})
  }
  await teamRef.set({ name: 'Studio Bewegung GmbH', slug: 'verif-595', language: 'de', plan: 'coach', plan_status: 'active', created: FieldValue.serverTimestamp(), createdBy: UID })
  await teamRef.collection('team_members').doc(UID).set({ role: 'owner', joined: FieldValue.serverTimestamp() })
  await db.collection('users').doc(UID).set({ currentTeam: TEAM, email: EMAIL })
  await teamRef.collection('installed_plugins').doc('tarif-595').set({ pluginId: 'tarif-595', teamId: TEAM, status: 'active', installedAt: FieldValue.serverTimestamp(), installedBy: UID })
  await teamRef.collection('settings').doc('legal_profile').set({
    legal_name: 'Studio Bewegung GmbH',
    postal: { street_name: 'Bahnhofstrasse', house_no: '12', zip: '8001', city: 'Zürich', country: 'CH' },
    canton: 'ZH', iban: 'CH9300762011623852957', vat_number: null, vat_rate: null,
  })
  await teamRef.collection('tarif595_settings').doc('config').set({
    language: 'de', modus: 'test',
    biller: { gln: '7601001302112', zsr: 'Q123456' },
    provider: { gln: '7601001302112', gln_location: '7601001302112', zsr: 'Q123456' },
    numbering: { prefix: '595' },
    offerings: {
      'subscription:verif-type': { position: '1001', unit: 'month' },
      'activity:verif-595-act': { position: '3039', unit: 'lesson' },
      'activity:verif-595-act2': { position: '3039', unit: 'lesson' },
    },
  })
  await contactRef.set({
    teamId: TEAM, firstname: 'Petra', lastname: 'Muster-Meier', email: 'petra@example.com', gender: 'F',
    birthdate: Timestamp.fromDate(new Date('1986-02-28T00:00:00Z')),
    address: { route: 'Musterstrasse', street_number: '5', postal_code: '6001', locality: 'Luzern' },
    archived_at: null, deleted_at: null, created_at: FieldValue.serverTimestamp(),
  })
  await contactRef.collection('subscription_history').doc('hist1').set({
    subscription_type_id: 'verif-type', subscription_type_name: 'Jahresabo', recurrence: 'monthly', amount: 89,
    start_date: Timestamp.fromDate(new Date('2027-01-15T00:00:00Z')), end_date: Timestamp.fromDate(new Date('2028-01-14T00:00:00Z')),
  })
  await teamRef.collection('tarif595_contacts').doc(CONTACT).set({ ahv_number: '7569217076985', insured_number: '123.45.678-012', insurer_gln: '7601003000012', insurer_name: 'Krankenkasse AG' })
  await seedMember(CONTACT2, { firstname: 'Bruno', ahv: '7569217076985', start: '2027-02-01', end: '2027-07-31' })
  // A fixed end: the test data lives in 2027 while the run happens today, and
  // an OPEN row ends at the run day — which would put Carla's whole period in
  // the future and out of the window before her missing AHV number is reached.
  await seedMember(CONTACT3, { firstname: 'Carla', ahv: null, start: '2027-03-01', end: '2027-08-31' })
  await seedMember(CONTACT4, { firstname: 'Dora', ahv: '7569217076985', start: '2027-01-01', end: '2027-12-31', archived: true })
  // attendance: three sessions of one activity, each with a participant row
  await db.collection('activities').doc('verif-595-act').set({ teamId: TEAM, name: 'Krafttraining', isActive: true })
  // A gated class WITH a door price: what an attendance receipt takes when no price is typed.
  await db.collection('activities').doc('verif-595-act2').set({ teamId: TEAM, name: 'Yoga', isActive: true, type: 'class', accessRule: { type: 'members' }, dropIn: { mode: 'custom', enabled: true, priceAmount: 30 } })
  {
    const sref = db.collection('sessions').doc('verif-595-s4')
    await sref.set({ teamId: TEAM, activityId: 'verif-595-act2', activityName: 'Yoga', start: Timestamp.fromDate(new Date('2027-04-06T18:00:00+02:00')), end: Timestamp.fromDate(new Date('2027-04-06T19:00:00+02:00')) })
    await sref.collection('participants').doc(CONTACT).set({ contactId: CONTACT, contact: CONTACT, session: sref.id, checkedInAt: Timestamp.fromDate(new Date('2027-04-06T18:05:00+02:00')) })
  }
  const days = ['2027-03-02', '2027-03-09', '2027-03-16']
  for (const [i, d] of days.entries()) {
    const sref = db.collection('sessions').doc(`verif-595-s${i + 1}`)
    await sref.set({ teamId: TEAM, activityId: 'verif-595-act', activityName: 'Krafttraining', start: Timestamp.fromDate(new Date(`${d}T18:00:00+01:00`)), end: Timestamp.fromDate(new Date(`${d}T19:00:00+01:00`)) })
    await sref.collection('participants').doc(CONTACT).set({ contactId: CONTACT, contact: CONTACT, session: sref.id, checkedInAt: Timestamp.fromDate(new Date(`${d}T18:05:00+01:00`)) })
  }
}

async function idToken() {
  try { await admin.auth().deleteUser(UID) } catch {}
  await admin.auth().createUser({ uid: UID, email: EMAIL, password: PASSWORD, emailVerified: true })
  const res = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  })
  const body = await res.json()
  if (!body.idToken) throw new Error('no idToken: ' + JSON.stringify(body))
  return body.idToken
}

let token
async function call(name, data) {
  const res = await fetch(`${FN}/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  })
  const body = await res.json()
  if (body.error) return { error: body.error }
  return { result: body.result }
}

const subReq = { teamId: TEAM, contactId: CONTACT, source: { kind: 'subscription', historyId: 'hist1' }, from: '2027-01-15', to: '2028-01-14' }

async function main() {
  await reset()
  token = await idToken()

  // 1. preview
  const p = await call('previewTarif595Receipt', subReq)
  check('preview ok', p.result?.ok === true, JSON.stringify(p.error ?? p.result?.blocking))
  check('preview: one monthly line, quantity 12, 12 × 89.00', p.result?.draft?.lines?.length === 1 && p.result.draft.lines[0].quantity === 12 && p.result.draft.totals.amount_minor === 106800, JSON.stringify(p.result?.draft?.lines))

  // 2. issue
  const i1 = await call('issueTarif595Receipt', subReq)
  const year = new Date().getFullYear()
  check('issue returns number 595-YYYY-00001', i1.result?.number === `595-${year}-00001`, JSON.stringify(i1.error ?? i1.result))
  const counter = (await teamRef.collection('counters').doc('tarif595_receipts').get()).data()
  check('counter last == 1 (absolute)', counter?.last === 1 && counter?.year === String(year), JSON.stringify(counter))
  const r1 = (await teamRef.collection('tarif595_receipts').doc(i1.result?.receiptId ?? 'x').get()).data()
  check('receipt issued with files + sha256', r1?.status === 'issued' && !!r1?.files?.pdf?.sha256 && !!r1?.files?.xml?.sha256, JSON.stringify(r1?.files))
  const bucket = admin.storage().bucket()
  const [pdfExists] = await bucket.file(`teams/${TEAM}/tarif595/${i1.result?.receiptId}/receipt.pdf`).exists()
  const [xmlExists] = await bucket.file(`teams/${TEAM}/tarif595/${i1.result?.receiptId}/receipt.xml`).exists()
  check('two objects in the Storage emulator', pdfExists && xmlExists)

  // 3. download + checksum
  const d = await call('downloadTarif595Receipt', { teamId: TEAM, receiptId: i1.result?.receiptId, kind: 'pdf' })
  const pdf = Buffer.from(d.result?.base64 ?? '', 'base64')
  check('download: PDF bytes whose sha256 matches the receipt', pdf.subarray(0, 5).toString() === '%PDF-' && createHash('sha256').update(pdf).digest('hex') === r1?.files?.pdf?.sha256, d.error ? JSON.stringify(d.error) : `${pdf.length} bytes`)
  const dx = await call('downloadTarif595Receipt', { teamId: TEAM, receiptId: i1.result?.receiptId, kind: 'xml' })
  const xml = Buffer.from(dx.result?.base64 ?? '', 'base64').toString('utf8')
  check('download: XML carries the number, VVG and the AHV number', xml.includes(`request_id="595-${year}-00001"`) && xml.includes('law type="VVG"') && xml.includes('ssn="7569217076985"'))

  // 4. idempotent re-issue
  const i1b = await call('issueTarif595Receipt', subReq)
  const counterB = (await teamRef.collection('counters').doc('tarif595_receipts').get()).data()
  check('re-issue of the same source/period returns the same receipt and takes no number', i1b.result?.receiptId === i1.result?.receiptId && counterB?.last === 1, JSON.stringify(i1b.result ?? i1b.error))

  // 5. void → re-issue as revision 2
  const v = await call('voidTarif595Receipt', { teamId: TEAM, receiptId: i1.result?.receiptId, reason: 'typo' })
  check('void → voided', v.result?.status === 'voided', JSON.stringify(v.error ?? v.result))
  const i2 = await call('issueTarif595Receipt', subReq)
  const r2 = (await teamRef.collection('tarif595_receipts').doc(i2.result?.receiptId ?? 'x').get()).data()
  check('re-issue after void gets 00002, revision 2, replaces the first', i2.result?.number === `595-${year}-00002` && r2?.revision === 2 && r2?.replaces === i1.result?.receiptId, JSON.stringify(i2.error ?? { number: i2.result?.number, revision: r2?.revision, replaces: r2?.replaces }))
  check('void refuses a receipt that is not issued (already voided is a no-op, pending refused)', (await call('voidTarif595Receipt', { teamId: TEAM, receiptId: i1.result?.receiptId })).result?.status === 'voided')

  // 6. email (no BREVO key in the emulator → the mail service logs the send)
  const e1 = await call('emailTarif595Receipt', { teamId: TEAM, receiptId: i2.result?.receiptId })
  const e2 = await call('emailTarif595Receipt', { teamId: TEAM, receiptId: i2.result?.receiptId })
  const r2b = (await teamRef.collection('tarif595_receipts').doc(i2.result?.receiptId ?? 'x').get()).data()
  check('email twice → send_count 2 (absolute writes)', e1.result?.send_count === 1 && e2.result?.send_count === 2 && r2b?.delivery?.send_count === 2, JSON.stringify(e1.error ?? e2.error ?? r2b?.delivery))

  // 7. attendance path: three check-ins → three single-entry lines at the typed price
  const attReq = { teamId: TEAM, contactId: CONTACT, source: { kind: 'attendance', activityId: 'verif-595-act' }, from: '2027-03-01', to: '2027-03-31', unitPriceMinor: 2500 }
  const pa = await call('previewTarif595Receipt', attReq)
  check('attendance preview: three lines, qty 1 each, 75.00', pa.result?.ok === true && pa.result.draft.lines.length === 3 && pa.result.draft.lines.every((l) => l.quantity === 1 && l.code === '3039') && pa.result.draft.totals.amount_minor === 7500, JSON.stringify(pa.error ?? pa.result?.blocking ?? pa.result?.draft?.lines))
  const ia = await call('issueTarif595Receipt', attReq)
  check('attendance issue → 00003', ia.result?.number === `595-${year}-00003`, JSON.stringify(ia.error ?? ia.result))

  // 7a. THE DOOR PRICE: no typed price → the class's resolved drop-in price, said as a warning;
  // a typed price always wins; a class without a door price still warns about a zero price.
  const doorReq = { teamId: TEAM, contactId: CONTACT, source: { kind: 'attendance', activityId: 'verif-595-act2' }, from: '2027-04-01', to: '2027-04-30' }
  const pd = await call('previewTarif595Receipt', doorReq)
  check('attendance without a typed price takes the drop-in price (30.00) and says so', pd.result?.ok === true && pd.result.draft.lines.length === 1 && pd.result.draft.lines[0].unit_minor === 3000 && pd.result.warnings.some((w) => w.code === 'unit_price_from_drop_in') && !pd.result.warnings.some((w) => w.code === 'unit_price_zero'), JSON.stringify(pd.error ?? { lines: pd.result?.draft?.lines, warnings: pd.result?.warnings, blocking: pd.result?.blocking }))
  const pt = await call('previewTarif595Receipt', { ...doorReq, unitPriceMinor: 2200 })
  check('a typed price wins over the door price, with no door-price warning', pt.result?.draft?.lines?.[0]?.unit_minor === 2200 && !pt.result.warnings.some((w) => w.code === 'unit_price_from_drop_in'), JSON.stringify(pt.error ?? pt.result?.warnings))
  const pn = await call('previewTarif595Receipt', { teamId: TEAM, contactId: CONTACT, source: { kind: 'attendance', activityId: 'verif-595-act' }, from: '2027-03-02', to: '2027-03-31' })
  check('a class with NO door price still warns about a zero price', pn.result?.warnings?.some((w) => w.code === 'unit_price_zero') && !pn.result.warnings.some((w) => w.code === 'unit_price_from_drop_in'), JSON.stringify(pn.error ?? pn.result?.warnings))

  // 7b. BULK: the 2027 window over every live contact. The first contact's
  // row (2027-01-15..2028-01-14) is clipped to 2027-01-15..2027-12-31 — a
  // different period from the receipt issued by hand above, so it is SKIPPED
  // as overlapping (a job never attests a period twice); Bruno is issued; Carla
  // has no AHV number and is skipped with that reason; Dora is archived and
  // never walked.
  const b1 = await call('startTarif595BulkIssue', { teamId: TEAM, from: '2027-01-01', to: '2027-12-31' })
  check('bulk starts and reports the scope', !!b1.result?.jobId && b1.result.total === 4, JSON.stringify(b1.error ?? b1.result))
  async function waitForJob(jobId) {
    for (let i = 0; i < 120; i++) {
      const j = (await teamRef.collection('tarif595_jobs').doc(jobId).get()).data()
      if (j && j.status !== 'running') return j
      await new Promise((r) => setTimeout(r, 500))
    }
    return (await teamRef.collection('tarif595_jobs').doc(jobId).get()).data()
  }
  const job1 = await waitForJob(b1.result?.jobId ?? 'x')
  check(`bulk (${b1.result?.mode}) completes: 1 issued, 2 skipped, 0 failed, 4 walked`, job1?.status === 'completed' && job1.issued === 1 && job1.skipped === 2 && job1.failed === 0 && job1.processed === 4, JSON.stringify(job1 && { status: job1.status, issued: job1.issued, skipped: job1.skipped, failed: job1.failed, processed: job1.processed, error: job1.error }))
  const skipCodes = Object.fromEntries((job1?.skips ?? []).map((s) => [s.contactId, s.code]))
  check('bulk records WHY: overlapping for the hand-issued member, AHV missing for Carla', skipCodes[CONTACT] === 'overlapping_receipt' && skipCodes[CONTACT3] === 'contact_ahv_missing', JSON.stringify(job1?.skips))
  const brunoReceipts = await teamRef.collection('tarif595_receipts').where('contact_id', '==', CONTACT2).get()
  const bruno = brunoReceipts.docs[0]?.data()
  check('bulk issued Bruno 00004 for Feb–Jul, six months, through the same issue path', brunoReceipts.size === 1 && bruno?.number === `595-${year}-00004` && bruno.period.from === '2027-02-01' && bruno.period.to === '2027-07-31' && bruno.lines[0].quantity === 6 && bruno.status === 'issued' && !!bruno.files?.pdf?.sha256, JSON.stringify(bruno && { number: bruno.number, period: bruno.period, q: bruno.lines?.[0]?.quantity }))
  const b2 = await call('startTarif595BulkIssue', { teamId: TEAM, from: '2027-01-01', to: '2027-12-31' })
  const job2 = await waitForJob(b2.result?.jobId ?? 'x')
  check('a second run issues nothing new — Bruno is already_issued, no number consumed', job2?.status === 'completed' && job2.issued === 0 && job2.skipped === 3 && (job2.skips ?? []).some((s) => s.contactId === CONTACT2 && s.code === 'already_issued') && (await teamRef.collection('counters').doc('tarif595_receipts').get()).data()?.last === 4, JSON.stringify(job2 && { issued: job2.issued, skipped: job2.skipped, skips: job2.skips }))
  check('a bulk job is client-read-only (functions write it)', (await teamRef.collection('tarif595_jobs').doc(b1.result?.jobId ?? 'x').get()).data()?.createdBy === UID)

  // 7c. THE MEMBER'S OWN COPY — a contact session (the Space's custom token),
  // exchanged for an id token at the Auth emulator.
  async function contactToken(contactId) {
    const custom = await admin.auth().createCustomToken(`contact:${contactId}`, { contactId, teamId: TEAM, sessionExpires: Date.now() + 3_600_000 })
    const res = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    })
    const body = await res.json()
    if (!body.idToken) throw new Error('no contact idToken: ' + JSON.stringify(body))
    return body.idToken
  }
  const managerToken = token
  token = await contactToken(CONTACT2)
  const mine = await call('listMyTarif595Receipts', { teamId: TEAM })
  check('listMyTarif595Receipts: enabled, exactly Bruno’s own receipt, a projection (no uid, no paths)', mine.result?.enabled === true && mine.result.receipts.length === 1 && mine.result.receipts[0].number === bruno?.number && !('created_by' in mine.result.receipts[0]) && !('files' in mine.result.receipts[0]), JSON.stringify(mine.error ?? mine.result))
  const own = await call('downloadTarif595Receipt', { teamId: TEAM, receiptId: brunoReceipts.docs[0]?.id, kind: 'pdf' })
  check('the contact downloads their OWN receipt through the contact door', !!own.result?.base64 && own.result.filename === `${bruno?.number}.pdf`, JSON.stringify(own.error))
  const notMine = await call('downloadTarif595Receipt', { teamId: TEAM, receiptId: i2.result?.receiptId, kind: 'pdf' })
  check('…and another member’s receipt answers not-found, exactly like a missing one', notMine.error?.status === 'NOT_FOUND', JSON.stringify(notMine.error ?? 'served!'))
  const wrongTeam = await call('listMyTarif595Receipts', { teamId: 'some-other-team' })
  check('a session for another team is refused', wrongTeam.error?.status === 'PERMISSION_DENIED', JSON.stringify(wrongTeam.error ?? wrongTeam.result))
  const asManager = await call('voidTarif595Receipt', { teamId: TEAM, receiptId: brunoReceipts.docs[0]?.id })
  check('a contact session holds no manager role (void refused)', !!asManager.error, JSON.stringify(asManager.result))
  token = managerToken

  // 7d. ANONYMIZATION: Carla asked for deletion and the window passed → the
  // sweep clears the identity AND deletes the insurer row; receipts are kept.
  await teamRef.collection('tarif595_contacts').doc(CONTACT3).set({ ahv_number: '7569217076985', insurer_name: 'CSS' })
  await db.collection('contacts').doc(CONTACT3).update({ deletion_requested_at: Timestamp.now(), deletion_scheduled_for: Timestamp.fromMillis(Date.now() - 1000) })
  const { anonymizeScheduledContacts } = await import('../dist/dailyTasks/anonymizeScheduledContacts.js')
  const swept = await anonymizeScheduledContacts()
  const carla = (await db.collection('contacts').doc(CONTACT3).get()).data()
  const carlaRow = await teamRef.collection('tarif595_contacts').doc(CONTACT3).get()
  check('the sweep anonymizes the contact and deletes the tarif595_contacts row', swept.anonymized >= 1 && carla?.firstname === 'Deleted' && !!carla?.anonymized_at && !carlaRow.exists, JSON.stringify({ swept, firstname: carla?.firstname, rowExists: carlaRow.exists }))
  check('…and Bruno’s receipt is untouched', (await teamRef.collection('tarif595_receipts').doc(brunoReceipts.docs[0]?.id ?? 'x').get()).data()?.status === 'issued')

  // 8. the AHV gate: blank it → preview refuses
  await teamRef.collection('tarif595_contacts').doc(CONTACT).update({ ahv_number: null })
  const pb = await call('previewTarif595Receipt', { ...subReq, from: '2028-01-15', to: '2029-01-14' })
  check('missing AHV number blocks (contact_ahv_missing)', pb.result?.ok === false && pb.result.blocking.some((b) => b.code === 'contact_ahv_missing'), JSON.stringify(pb.result?.blocking))

  // 9. the plugin gate: uninstall → issue refused, download still works
  await teamRef.collection('installed_plugins').doc('tarif-595').update({ status: 'disabled' })
  const gated = await call('previewTarif595Receipt', subReq)
  check('preview refused when the plugin is disabled', !!gated.error && /plugin/i.test(JSON.stringify(gated.error)), JSON.stringify(gated.error ?? gated.result))
  const still = await call('downloadTarif595Receipt', { teamId: TEAM, receiptId: i2.result?.receiptId, kind: 'xml' })
  check('download still works when the plugin is disabled (consumption is not gated)', !!still.result?.base64, JSON.stringify(still.error))
  const bulkGated = await call('startTarif595BulkIssue', { teamId: TEAM, from: '2027-01-01', to: '2027-12-31' })
  check('bulk refused when the plugin is disabled (creation)', !!bulkGated.error && /plugin/i.test(JSON.stringify(bulkGated.error)), JSON.stringify(bulkGated.error ?? bulkGated.result))
  token = await contactToken(CONTACT2)
  const mineAfter = await call('listMyTarif595Receipts', { teamId: TEAM })
  check('the member still lists their receipts, and `enabled` is now false', mineAfter.result?.enabled === false && mineAfter.result.receipts.length === 1, JSON.stringify(mineAfter.error ?? mineAfter.result))
  token = managerToken

  console.log('\n' + results.join('\n'))
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })

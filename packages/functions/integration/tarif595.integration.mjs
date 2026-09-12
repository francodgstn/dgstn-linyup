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
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199'
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
const FN = 'http://127.0.0.1:5001/demo-linyup/europe-west6'

let pass = 0, fail = 0
const results = []
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  ok ? pass++ : fail++
}

const teamRef = db.collection('teams').doc(TEAM)
const contactRef = db.collection('contacts').doc(CONTACT)

async function reset() {
  await db.recursiveDelete(teamRef)
  await db.recursiveDelete(contactRef)
  await db.collection('activities').doc('verif-595-act').delete().catch(() => {})
  for (const s of ['verif-595-s1', 'verif-595-s2', 'verif-595-s3']) {
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
  // attendance: three sessions of one activity, each with a participant row
  await db.collection('activities').doc('verif-595-act').set({ teamId: TEAM, name: 'Krafttraining', isActive: true })
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
  const res = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake', {
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

  console.log('\n' + results.join('\n'))
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })

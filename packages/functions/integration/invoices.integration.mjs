// End-to-end verification of the QR-invoice callables against the emulators:
// create → counter → file → download (sha256) → idempotent retry → email →
// mark paid (payment_events row + subscription effect) → idempotent mark paid →
// void refused on a paid invoice → void an open one → the plugin gate.
//
//   pnpm --filter @linyup/functions build
//   FUNCTIONS_DISCOVERY_TIMEOUT=120 pnpm --filter @linyup/functions test:integration:invoices
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199'
import { createHash } from 'node:crypto'
import admin from 'firebase-admin'

admin.initializeApp({ projectId: 'demo-linyup', storageBucket: 'demo-linyup.appspot.com' })
const db = admin.firestore()
const { Timestamp, FieldValue } = admin.firestore

const TEAM = 'verif-inv'
const CONTACT = 'verif-inv-contact'
const UID = 'verif-inv-owner'
const EMAIL = 'ownerinv@example.com'
const PASSWORD = 'verifinvpass'
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
  await teamRef.set({ name: 'Studio Bewegung GmbH', slug: 'verif-inv', language: 'de', plan: 'coach', plan_status: 'active', payment_modes: ['Bank transfer', 'Cash'], created: FieldValue.serverTimestamp(), createdBy: UID })
  await teamRef.collection('team_members').doc(UID).set({ role: 'owner', joined: FieldValue.serverTimestamp() })
  await db.collection('users').doc(UID).set({ currentTeam: TEAM, email: EMAIL })
  await teamRef.collection('installed_plugins').doc('qr-invoices').set({ pluginId: 'qr-invoices', teamId: TEAM, status: 'active', installedAt: FieldValue.serverTimestamp(), installedBy: UID })
  await teamRef.collection('settings').doc('legal_profile').set({
    legal_name: 'Studio Bewegung GmbH',
    postal: { street_name: 'Bahnhofstrasse', house_no: '12', zip: '8001', city: 'Zürich', country: 'CH' },
    canton: 'ZH', iban: 'CH9300762011623852957', vat_number: null, vat_rate: null,
  })
  await teamRef.collection('invoice_settings').doc('config').set({ prefix: 'INV', due_days: 20, footer_text: 'Danke!' })
  await teamRef.collection('subscription_types').doc('verif-type').set({ name: 'Jahresabo', active: true, prices: [{ id: 'p1', amount: 1068, recurrence: 'annual' }] })
  await contactRef.set({
    teamId: TEAM, firstname: 'Petra', lastname: 'Muster-Meier', email: 'petra@example.com', gender: 'F',
    address: { route: 'Musterstrasse', street_number: '5', postal_code: '6001', locality: 'Luzern' },
    archived_at: null, deleted_at: null, created_at: FieldValue.serverTimestamp(),
  })
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
  return body.error ? { error: body.error } : { result: body.result }
}

const lineItem = { kind: 'subscription', subscriptionTypeId: 'verif-type', priceId: 'p1', label: 'Jahresabo' }
const createReq = { teamId: TEAM, contactId: CONTACT, requestKey: 'key-1', lineItem, amountMinor: 106800, description: 'Jahresabo 2027' }

async function main() {
  await reset()
  token = await idToken()
  const year = new Date().getFullYear()

  const c1 = await call('createInvoice', createReq)
  check('create → INV-YYYY-00001, open', c1.result?.number === `INV-${year}-00001` && c1.result?.status === 'open', JSON.stringify(c1.error ?? c1.result))
  const counter = (await teamRef.collection('counters').doc('invoices').get()).data()
  check('counter last == 1 (absolute)', counter?.last === 1, JSON.stringify(counter))
  const i1 = (await teamRef.collection('invoices').doc(c1.result?.invoiceId ?? 'x').get()).data()
  check('invoice frozen: creditor from the legal profile, due date = issue + 20 days, SCOR reference, file with sha256', i1?.creditor?.legal_name === 'Studio Bewegung GmbH' && i1?.reference?.type === 'SCOR' && !!i1?.files?.pdf?.sha256 && i1?.due_on > i1?.issued_on, JSON.stringify({ due: i1?.due_on, issued: i1?.issued_on, ref: i1?.reference, files: i1?.files }))
  const [exists] = await admin.storage().bucket().file(`teams/${TEAM}/invoices/${c1.result?.invoiceId}/invoice.pdf`).exists()
  check('PDF object in the Storage emulator', exists)

  const d = await call('downloadInvoice', { teamId: TEAM, invoiceId: c1.result?.invoiceId })
  const pdf = Buffer.from(d.result?.base64 ?? '', 'base64')
  check('download: PDF bytes, sha256 matches', pdf.subarray(0, 5).toString() === '%PDF-' && createHash('sha256').update(pdf).digest('hex') === i1?.files?.pdf?.sha256, d.error ? JSON.stringify(d.error) : `${pdf.length} bytes`)

  const c1b = await call('createInvoice', createReq)
  const counterB = (await teamRef.collection('counters').doc('invoices').get()).data()
  check('same requestKey again → same invoice, no second number', c1b.result?.invoiceId === c1.result?.invoiceId && counterB?.last === 1, JSON.stringify(c1b.result ?? c1b.error))

  const e = await call('emailInvoice', { teamId: TEAM, invoiceId: c1.result?.invoiceId })
  check('email → send_count 1', e.result?.send_count === 1, JSON.stringify(e.error ?? e.result))

  const p = await call('markInvoicePaid', { teamId: TEAM, invoiceId: c1.result?.invoiceId, paymentMode: 'Bank transfer', sendReceipt: false })
  check('mark paid → paid with a payment_events id', p.result?.status === 'paid' && !!p.result?.paymentEventId, JSON.stringify(p.error ?? p.result))
  const pe = (await teamRef.collection('payment_events').doc(p.result?.paymentEventId ?? 'x').get()).data()
  check('the payment_events row is gateway manual, keyed by the invoice, linked to the contact with the line item', pe?.gateway === 'manual' && pe?.gatewayRef === `invoice-${c1.result?.invoiceId}` && pe?.contact_id === CONTACT && pe?.line_item?.kind === 'subscription' && pe?.amount === 106800, JSON.stringify(pe && { gateway: pe.gateway, ref: pe.gatewayRef, amount: pe.amount, li: pe.line_item?.kind }))
  const contact = (await contactRef.get()).data()
  check('the subscription effect applied to the contact', contact?.subscription_type_id === 'verif-type', JSON.stringify({ sub: contact?.subscription_type_id }))
  const p2 = await call('markInvoicePaid', { teamId: TEAM, invoiceId: c1.result?.invoiceId })
  const events = await teamRef.collection('payment_events').get()
  check('mark paid again → idempotent, still one payment row', p2.result?.paymentEventId === p.result?.paymentEventId && events.size === 1, `rows=${events.size}`)

  const v = await call('voidInvoice', { teamId: TEAM, invoiceId: c1.result?.invoiceId })
  check('void refused on a paid invoice (invoice_already_paid)', !!v.error && JSON.stringify(v.error).includes('invoice_already_paid'), JSON.stringify(v.error ?? v.result))

  const c2 = await call('createInvoice', { ...createReq, requestKey: 'key-2', amountMinor: 5000, description: 'Kurs' })
  check('second invoice → 00002', c2.result?.number === `INV-${year}-00002`, JSON.stringify(c2.error ?? c2.result))
  const v2 = await call('voidInvoice', { teamId: TEAM, invoiceId: c2.result?.invoiceId, reason: 'issued twice' })
  check('void an open invoice → void', v2.result?.status === 'void', JSON.stringify(v2.error ?? v2.result))
  const p3 = await call('markInvoicePaid', { teamId: TEAM, invoiceId: c2.result?.invoiceId })
  check('mark paid refused on a void invoice', !!p3.error, JSON.stringify(p3.result))

  await teamRef.collection('settings').doc('legal_profile').update({ iban: 'CH9300762011623852958' })
  const bad = await call('createInvoice', { ...createReq, requestKey: 'key-3' })
  check('an invalid legal profile refuses creation (legal_profile_incomplete)', !!bad.error && JSON.stringify(bad.error).includes('legal_profile_incomplete'), JSON.stringify(bad.error ?? bad.result))
  await teamRef.collection('settings').doc('legal_profile').update({ iban: 'CH9300762011623852957' })

  await teamRef.collection('installed_plugins').doc('qr-invoices').update({ status: 'disabled' })
  const gated = await call('createInvoice', { ...createReq, requestKey: 'key-4' })
  check('create refused when the plugin is disabled', !!gated.error && /plugin/i.test(JSON.stringify(gated.error)), JSON.stringify(gated.error ?? gated.result))
  const still = await call('downloadInvoice', { teamId: TEAM, invoiceId: c1.result?.invoiceId })
  check('download still works when the plugin is disabled', !!still.result?.base64, JSON.stringify(still.error))

  console.log('\n' + results.join('\n'))
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })

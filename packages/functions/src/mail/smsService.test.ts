import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FieldValue } from 'firebase-admin/firestore'
import { __clearPolicyCacheForTests } from './messagingPolicy'
import {
  __setSmsProviderForTests,
  normalizePhoneE164,
  phoneHash,
  sanitizeSmsSender,
  sendStudioSms,
} from './smsService'

describe('normalizePhoneE164', () => {
  it('keeps a valid E.164 number', () => {
    assert.equal(normalizePhoneE164('+41761234501'), '+41761234501')
  })

  it('strips separators', () => {
    assert.equal(normalizePhoneE164('+41 76 123 45 01'), '+41761234501')
    assert.equal(normalizePhoneE164('+41-76-123-45-01'), '+41761234501')
  })

  it('resolves 00 international prefix', () => {
    assert.equal(normalizePhoneE164('0041761234501'), '+41761234501')
  })

  it('assumes Switzerland for national 0-prefixed numbers', () => {
    assert.equal(normalizePhoneE164('076 123 45 01'), '+41761234501')
  })

  it('rejects garbage', () => {
    assert.equal(normalizePhoneE164('not a phone'), null)
    assert.equal(normalizePhoneE164(''), null)
    assert.equal(normalizePhoneE164(null), null)
    assert.equal(normalizePhoneE164('+0123'), null)
  })
})

describe('sanitizeSmsSender', () => {
  it('keeps a clean short name', () => {
    assert.equal(sanitizeSmsSender('SWIMLI'), 'SWIMLI')
  })

  it('strips non-alphanumerics and truncates to 11 chars', () => {
    assert.equal(sanitizeSmsSender('My Studio & Co. Zürich'), 'MyStudioCoZ')
  })

  it('falls back to Linyup when empty', () => {
    assert.equal(sanitizeSmsSender(''), 'Linyup')
    assert.equal(sanitizeSmsSender(null), 'Linyup')
    assert.equal(sanitizeSmsSender('!!!'), 'Linyup')
  })
})

// ─── sendStudioSms: the contact's opt-out, and the ledger row a drop leaves ───
//
// Run against an in-memory Firestore swapped onto `firebase-admin`, with the
// provider replaced, so what is pinned is the service's own decisions: whose
// "no SMS" it reads, that nothing reaches the provider afterwards, and that the
// drop is filed in `mail_sends` without spending the idempotency key.

type Doc = Record<string, unknown>

function fakeFirestore(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(Object.entries(seed))
  const reads: string[] = []
  let autoId = 0
  const collectionRef = (base: string) => ({
    doc: (id?: string) => docRef(`${base}/${id ?? `auto-${++autoId}`}`),
  })
  const docRef = (path: string): Record<string, unknown> => ({
    id: path.split('/').pop()!,
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    async get() {
      reads.push(path)
      const data = store.get(path)
      return { exists: data !== undefined, data: () => data }
    },
    async set(data: Doc, opts?: { merge?: boolean }) {
      store.set(path, opts?.merge ? { ...(store.get(path) ?? {}), ...data } : data)
    },
  })
  const db = { collection: collectionRef }
  return { db, store, reads }
}

describe('sendStudioSms — contact opt-out', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const adminModule = require('firebase-admin') as object
  // `firestore` is a prototype getter on the SDK namespace, so the fake is an
  // OWN property shadowing it, and deleting that property restores the real one.
  const stubFirestore = (db: unknown) =>
    Object.defineProperty(adminModule, 'firestore', { value: () => db, configurable: true })
  const envBefore = { ...process.env }
  let provided: string[] = []

  before(() => {
    __setSmsProviderForTests({
      async send(m) {
        provided.push(m.recipient)
        return { providerMessageId: `pm-${provided.length}` }
      },
    })
  })

  beforeEach(() => {
    provided = []
    __clearPolicyCacheForTests()
    process.env.SMS_ENABLED = 'true'
    process.env.TEST_MODE = 'false'
    process.env.MESSAGING_DEFAULT_MODE = 'live'
  })

  afterEach(() => {
    delete (adminModule as { firestore?: unknown }).firestore
    process.env = { ...envBefore }
  })

  function install(seed: Record<string, Doc>) {
    const fake = fakeFirestore(seed)
    stubFirestore(fake.db)
    return fake
  }

  const msg = (contactId: string | null, idempotencyKey?: string) => ({
    to: '+41761234501',
    contactId,
    content: 'Reminder: class at 18:00',
    tag: 'booking-reminder',
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })

  it('drops the send for a contact with sms_opt_out and files a suppressed row', async () => {
    const fake = install({ 'contacts/c-out': { sms_opt_out: true } })
    const outcome = await sendStudioSms('team-1', msg('c-out', 'sms-key-1'))

    assert.deepEqual(outcome, { skipped: true })
    assert.equal(provided.length, 0, 'nothing may reach the provider')
    assert.ok(fake.reads.includes('contacts/c-out'), 'the named contact is the one read')
    const row = fake.store.get('mail_sends/sms-key-1')!
    assert.equal(row.status, 'suppressed')
    assert.equal(row.suppress_reason, 'opt_out')
    assert.equal(row.channel, 'sms')
    assert.equal(row.stream, 'studio')
    assert.equal(row.team_id, 'team-1')
    assert.equal(row.recipient_count, 0)
    assert.equal(row.idempotency_key, 'sms-key-1')
    assert.ok(row.created_at && row.expires_at, 'a new row is stamped at creation')
  })

  it('the suppressed row does not spend the key — after opting back in, the same send goes out', async () => {
    const fake = install({ 'contacts/c-back': { sms_opt_out: true } })
    await sendStudioSms('team-1', msg('c-back', 'sms-key-2'))
    assert.equal(provided.length, 0)

    fake.store.set('contacts/c-back', { sms_opt_out: false })
    const outcome = await sendStudioSms('team-1', msg('c-back', 'sms-key-2'))

    assert.deepEqual(provided, ['+41761234501'])
    assert.equal(outcome.providerMessageId, 'pm-1')
    const row = fake.store.get('mail_sends/sms-key-2')!
    assert.equal(row.status, 'sent')
    assert.equal(row.recipient_count, 1)
    assert.ok(
      (row.suppress_reason as FieldValue).isEqual(FieldValue.delete()),
      'the old drop reason is cleared, not left beside the new status',
    )
  })

  it('sends when the contact has not opted out, has no preference, or no longer exists', async () => {
    install({ 'contacts/c-in': { sms_opt_out: false }, 'contacts/c-none': {} })
    await sendStudioSms('team-1', msg('c-in'))
    await sendStudioSms('team-1', msg('c-none'))
    await sendStudioSms('team-1', msg('c-missing'))
    assert.equal(provided.length, 3)
  })

  it('only an explicit true opts out', async () => {
    install({ 'contacts/c-str': { sms_opt_out: 'true' } })
    await sendStudioSms('team-1', msg('c-str'))
    assert.equal(provided.length, 1)
  })

  it('a send about no contact reads no contact', async () => {
    const fake = install({})
    await sendStudioSms('team-1', msg(null))
    assert.equal(provided.length, 1)
    assert.ok(!fake.reads.some((p) => p.startsWith('contacts/')))
  })

  it('is honoured under TEST_MODE too — the redirect shows what production would send', async () => {
    process.env.TEST_MODE = 'true'
    process.env.TEST_SMS_NUMBER = '+41790000000'
    const fake = install({ 'contacts/c-test': { sms_opt_out: true } })
    const outcome = await sendStudioSms('team-1', msg('c-test'))

    assert.deepEqual(outcome, { skipped: true })
    assert.equal(provided.length, 0)
    const rows = [...fake.store.entries()].filter(([p]) => p.startsWith('mail_sends/'))
    assert.equal(rows.length, 1, 'a keyless drop still leaves a row')
    assert.equal(rows[0][1].suppress_reason, 'opt_out')
  })

  it('a failed contact read throws rather than texting someone who may have said no', async () => {
    const fake = fakeFirestore({})
    stubFirestore({
      collection: (name: string) =>
        name === 'contacts'
          ? { doc: () => ({ get: () => Promise.reject(new Error('unavailable')) }) }
          : fake.db.collection(name),
    })
    await assert.rejects(sendStudioSms('team-1', msg('c-err', 'sms-key-err')), /unavailable/)
    assert.equal(provided.length, 0)
    assert.equal(fake.store.size, 0, 'no row: nothing was decided about this contact')
  })

  it('a send that already reached the provider stays an idempotent skip, not a new suppressed row', async () => {
    const fake = install({
      'contacts/c-late': { sms_opt_out: true },
      'mail_sends/sms-key-3': { status: 'delivered', provider_message_id: 'pm-old' },
    })
    const outcome = await sendStudioSms('team-1', msg('c-late', 'sms-key-3'))
    assert.deepEqual(outcome, { providerMessageId: 'pm-old', skipped: true })
    assert.equal(fake.store.get('mail_sends/sms-key-3')!.status, 'delivered')
  })

  it('the other drops on the recipient’s account are filed with their own reason', async () => {
    const fake = install({ 'messaging_policies/team-silent': { mode: 'silent' } })
    await sendStudioSms('team-silent', msg(null, 'sms-key-policy'))
    await sendStudioSms('team-1', { ...msg(null, 'sms-key-invalid'), to: 'not a phone' })
    fake.store.set(`sms_suppressions/${phoneHash('+41761234501')}`, { reason: 'manual' })
    await sendStudioSms('team-1', msg(null, 'sms-key-blocked'))

    assert.equal(provided.length, 0)
    assert.equal(fake.store.get('mail_sends/sms-key-policy')!.suppress_reason, 'policy_silent')
    assert.equal(fake.store.get('mail_sends/sms-key-invalid')!.suppress_reason, 'invalid_number')
    assert.equal(fake.store.get('mail_sends/sms-key-blocked')!.suppress_reason, 'suppressed_number')
  })

  it('the kill switch reads nothing and files nothing — it is a fact about the environment', async () => {
    process.env.SMS_ENABLED = 'false'
    const fake = install({ 'contacts/c-off': { sms_opt_out: true } })
    await sendStudioSms('team-1', msg('c-off', 'sms-key-off'))
    assert.equal(fake.reads.length, 0)
    assert.equal(fake.store.size, 1)
  })
})

describe('the SMS callers name the contact they are texting', () => {
  // `contactId` is required on the type, so a caller cannot omit it; these pin
  // that the value passed is the person rather than a placeholder `null`.
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

  it('booking reminders pass the booking’s contact', () => {
    assert.match(
      read('dailyTasks/sendBookingReminders.ts'),
      /sendSms\(\{[\s\S]*?contactId: \(booking\.contact as string\) \|\| null,/,
    )
  })

  it('waitlist offers pass the offered contact', () => {
    assert.match(read('booking/waitlist/notify.ts'), /sendSms\(\{[\s\S]*?contactId: offer\.contactId,/)
  })
})

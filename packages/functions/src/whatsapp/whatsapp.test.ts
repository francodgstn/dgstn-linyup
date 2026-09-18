import assert from 'node:assert/strict'
import * as crypto from 'crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Timestamp } from 'firebase-admin/firestore'
import {
  isWhatsAppStopMessage,
  resolveWhatsAppLanguage,
  whatsappConsentAllows,
  whatsappTemplateApproved,
} from '@linyup/shared'
import { ledgerStatusFor, parseWhatsAppWebhook, verifyMetaSignature } from './webhook'
import { suppressionBlocks } from './service'
import { whatsappReminderParams } from './reminder'
import { buildContactFieldPatch, WHATSAPP_OPT_IN_ANSWER_KEY } from '../booking/contactFields'

// docs/whatsapp-outbound.md → Verification.

describe('whatsapp — consent', () => {
  it('only an explicit opt-in allows a send', () => {
    assert.equal(whatsappConsentAllows(undefined), false)
    assert.equal(whatsappConsentAllows({}), false)
    assert.equal(whatsappConsentAllows({ whatsapp_consent: { status: 'opted_out' } }), false)
    assert.equal(whatsappConsentAllows({ whatsapp_consent: { status: 'opted_in' } }), true)
  })

  it('a STOP blocks only when it is newer than the opt-in', () => {
    const t = (ms: number) => Timestamp.fromMillis(ms)
    assert.equal(suppressionBlocks(t(2000), t(1000)), true)
    assert.equal(suppressionBlocks(t(1000), t(2000)), false)
    assert.equal(suppressionBlocks(t(1000), undefined), true)
  })

  it('a ticked box on a book form records an opt-in; an unticked one records nothing', () => {
    const ticked = buildContactFieldPatch({ fields: [], answers: { [WHATSAPP_OPT_IN_ANSWER_KEY]: true }, definitions: [] })
    assert.equal((ticked.whatsapp_consent as { status: string }).status, 'opted_in')
    assert.equal((ticked.whatsapp_consent as { source: string }).source, 'booking_form')
    for (const value of [false, 'true', undefined]) {
      const patch = buildContactFieldPatch({ fields: [], answers: { [WHATSAPP_OPT_IN_ANSWER_KEY]: value }, definitions: [] })
      assert.deepEqual(patch, {}, String(value))
    }
    const alreadyIn = buildContactFieldPatch({
      fields: [],
      answers: { [WHATSAPP_OPT_IN_ANSWER_KEY]: true },
      definitions: [],
      existing: { whatsapp_consent: { status: 'opted_in' } },
    })
    assert.deepEqual(alreadyIn, {})
  })
})

describe('whatsapp — STOP keywords', () => {
  it('reads a whole-message keyword in four languages, case- and accent-insensitive', () => {
    for (const text of ['STOP', 'stop', ' Stopp! ', 'Arrêt', 'ARRET', 'basta', 'Abmelden']) {
      assert.equal(isWhatsAppStopMessage(text), true, text)
    }
  })
  it('does not read a sentence containing the word as an opt-out', () => {
    for (const text of ['stop by later?', 'Can I stop my plan', '', null]) {
      assert.equal(isWhatsAppStopMessage(text), false, String(text))
    }
  })
})

describe('whatsapp — templates and language', () => {
  it('resolves regional codes and falls back to English', () => {
    assert.equal(resolveWhatsAppLanguage('de-CH'), 'de')
    assert.equal(resolveWhatsAppLanguage('pt'), 'en')
    assert.equal(resolveWhatsAppLanguage(undefined), 'en')
  })

  it('a template is usable only when connected and approved in that language', () => {
    const templates = { 'x:de': { status: 'APPROVED' as const } }
    assert.equal(whatsappTemplateApproved({ status: 'connected', templates }, 'x', 'de'), true)
    assert.equal(whatsappTemplateApproved({ status: 'connected', templates }, 'x', 'fr'), false)
    assert.equal(whatsappTemplateApproved({ status: 'disconnected', templates }, 'x', 'de'), false)
  })

  it('formats the reminder in the studio clock and language', () => {
    const { language, params } = whatsappReminderParams({
      firstname: ' Anna ',
      activityName: 'Yoga',
      teamName: 'Aare',
      // 16:30 UTC is 18:30 in Zurich in summer.
      sessionStart: new Date('2026-09-21T16:30:00Z'),
      lang: 'de',
    })
    assert.equal(language, 'de')
    assert.equal(params.first_name, 'Anna')
    assert.equal(params.time, '18:30')
    assert.match(params.date, /Montag/)
  })
})

describe('whatsapp — webhook', () => {
  const secret = 'app-secret'
  const sign = (body: Buffer) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`

  it('verifies the signature over the raw body, and refuses everything else', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}')
    assert.equal(verifyMetaSignature(body, sign(body), secret), true)
    assert.equal(verifyMetaSignature(Buffer.from('{"object":"x"}'), sign(body), secret), false)
    assert.equal(verifyMetaSignature(body, sign(body).replace('sha256=', ''), secret), false)
    assert.equal(verifyMetaSignature(body, undefined, secret), false)
    assert.equal(verifyMetaSignature(undefined, sign(body), secret), false)
    assert.equal(verifyMetaSignature(body, sign(body), ''), false)
  })

  it('parses statuses, inbound text and template reviews, and ignores the rest', () => {
    const events = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PN1' },
                statuses: [
                  {
                    id: 'wamid.1',
                    status: 'failed',
                    errors: [{ code: 131049 }],
                    pricing: { category: 'utility', billable: false },
                  },
                ],
                messages: [{ from: '41791234567', type: 'text', text: { body: 'STOP' } }],
              },
            },
            {
              field: 'message_template_status_update',
              value: { event: 'APPROVED', message_template_name: 'linyup_booking_reminder_v1', message_template_language: 'de', reason: 'NONE' },
            },
            { field: 'account_update', value: {} },
          ],
        },
      ],
    })
    assert.deepEqual(events, [
      { kind: 'status', phoneNumberId: 'PN1', messageId: 'wamid.1', status: 'failed', errorCode: 131049, category: 'utility', billable: false },
      { kind: 'inbound', phoneNumberId: 'PN1', from: '41791234567', text: 'STOP' },
      { kind: 'template_status', wabaId: 'WABA1', name: 'linyup_booking_reminder_v1', language: 'de', event: 'APPROVED', reason: null },
    ])
    assert.deepEqual(parseWhatsAppWebhook({ object: 'page', entry: [] }), [])
  })

  it('a delivery failure keeps the idempotency key spent', () => {
    assert.equal(ledgerStatusFor('failed'), 'undelivered')
    assert.equal(ledgerStatusFor('delivered'), 'delivered')
    assert.equal(ledgerStatusFor('deleted'), null)
  })
})

describe('whatsapp — source pins', () => {
  const src = join(__dirname, '..')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts') && !/\.(rules-)?test\.ts$/.test(path)) files.push(path)
    }
  }
  walk(src)
  const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

  it('only graph.ts calls the Graph API', () => {
    const callers = files.filter((f) => read(f).includes('graph.facebook.com')).map((f) => f.slice(src.length + 1))
    assert.deepEqual(callers, [join('whatsapp', 'graph.ts')])
  })

  it('only consentPatch.ts builds the consent record', () => {
    const writers = files
      .filter((f) => /whatsapp_consent:\s*\{/.test(read(f)))
      .map((f) => f.slice(src.length + 1))
    assert.deepEqual(writers, [join('whatsapp', 'consentPatch.ts')])
  })

  it('only the send rail sends a WhatsApp message', () => {
    const senders = files
      .filter((f) => /\.sendMessage\(/.test(read(f)))
      .map((f) => f.slice(src.length + 1))
    assert.deepEqual(senders, [join('whatsapp', 'service.ts')])
  })

  it('the rules deny whatsapp_consent to clients, on create and update', () => {
    const rules = read(join(__dirname, '..', '..', '..', '..', 'firestore.rules'))
    const contactsBlock = rules.slice(rules.indexOf('match /contacts/{contactId}'), rules.indexOf('match /subscription_history/'))
    assert.equal(contactsBlock.match(/'whatsapp_consent'/g)?.length, 2)
  })
})

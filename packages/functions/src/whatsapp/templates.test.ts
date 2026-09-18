import assert from 'node:assert/strict'
import { WHATSAPP_BOOKING_REMINDER_TEMPLATE as REMINDER, WHATSAPP_LANGUAGES } from '@linyup/shared'
import {
  buildTemplateCreatePayload,
  buildTemplateSendPayload,
  buttonSuffixFor,
  cleanTemplateParam,
  linyupTemplateStatuses,
  provisionLinyupTemplates,
} from './templates'
import type { WhatsAppGraph } from './graph'

describe('whatsapp templates', () => {
  it('every language body names exactly the declared parameters, and never starts or ends with one', () => {
    for (const lang of WHATSAPP_LANGUAGES) {
      const body = REMINDER.body[lang]
      const used = [...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
      assert.deepEqual(used, REMINDER.params.map((p) => p.name), lang)
      assert.ok(!/^\{\{/.test(body.trim()) && !/\}\}$/.test(body.trim()), lang)
    }
  })

  it('builds a named-parameter create payload with the button under the app origin', () => {
    const p = buildTemplateCreatePayload(REMINDER, 'de', 'https://app.linyup.com/') as any
    assert.equal(p.parameter_format, 'NAMED')
    assert.equal(p.category, 'UTILITY')
    assert.equal(p.components[0].example.body_text_named_params.length, REMINDER.params.length)
    assert.equal(p.components[1].buttons[0].url, 'https://app.linyup.com/{{1}}')
    assert.equal(p.components[1].buttons[0].text, 'Buchung verwalten')
  })

  it('builds a send payload: no plus sign, cleaned params, button suffix', () => {
    const p = buildTemplateSendPayload({
      toE164: '+41791234567',
      def: REMINDER,
      language: 'fr',
      params: { first_name: 'Anna\nMaria', class_name: '', studio_name: 'Aare', date: 'lundi', time: '18:30' },
      buttonSuffix: 'fr/public/aare/manage-booking?token=t',
    }) as any
    assert.equal(p.to, '41791234567')
    assert.equal(p.template.language.code, 'fr')
    const params = p.template.components[0].parameters
    assert.equal(params[0].text, 'Anna Maria')
    assert.equal(params[1].text, '-')
    assert.equal(p.template.components[1].parameters[0].text, 'fr/public/aare/manage-booking?token=t')
    assert.throws(() => buildTemplateSendPayload({ toE164: '+41', def: REMINDER, language: 'en', params: {} }))
  })

  it('cuts the button suffix off the app origin only', () => {
    assert.equal(buttonSuffixFor('https://app.linyup.com/de/x?t=1', 'https://app.linyup.com'), 'de/x?t=1')
    assert.equal(buttonSuffixFor('https://studio.ch/de/x', 'https://app.linyup.com'), null)
    assert.equal(buttonSuffixFor(null, 'https://app.linyup.com'), null)
    assert.equal(cleanTemplateParam('  a \t b  '), 'a b')
  })

  it('reads Linyup template statuses and marks absent ones MISSING', () => {
    const s = linyupTemplateStatuses([{ name: REMINDER.name, language: 'en', status: 'APPROVED' }])
    assert.equal(s[`${REMINDER.name}:en`].status, 'APPROVED')
    assert.equal(s[`${REMINDER.name}:de`].status, 'MISSING')
  })

  it('provisions only the missing templates and records a failed create', async () => {
    const created: string[] = []
    const graph = {
      listTemplates: async () => [{ name: REMINDER.name, language: 'en', status: 'APPROVED' }],
      createTemplate: async (_t: string, _w: string, payload: any) => {
        created.push(payload.language)
        if (payload.language === 'it') throw new Error('rejected by Meta')
        return { status: 'PENDING' }
      },
    } as unknown as WhatsAppGraph
    const statuses = await provisionLinyupTemplates(graph, 'tok', 'waba', 'https://app.linyup.com')
    assert.deepEqual(created, ['de', 'fr', 'it'])
    assert.equal(statuses[`${REMINDER.name}:de`].status, 'PENDING')
    assert.equal(statuses[`${REMINDER.name}:it`].reason, 'rejected by Meta')
  })
})

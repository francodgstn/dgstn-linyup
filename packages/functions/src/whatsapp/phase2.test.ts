import assert from 'node:assert/strict'
import {
  validateWhatsAppTemplateBody,
  whatsappConsentAllows,
  whatsappConsentKindFor,
  whatsappStudioTemplateSendable,
  whatsappTemplateForMeta,
  WHATSAPP_TEMPLATE_BODY_MAX,
} from '@linyup/shared'
import { buildSendPayload } from './templates'
import { buildStudioTemplateCreatePayload, newMetaTemplateName } from './studioTemplates'
import { whatsappConsentPatch, whatsappStopPatch } from './consentPatch'
import { heldTaskId, whatsappAutomationKey } from './automation'
import { monthStartZurich } from './usage'
import { META_STOPPED_PROMOTIONS, parseWhatsAppWebhook } from './webhook'
import {
  buildContactFieldPatch,
  WHATSAPP_MARKETING_OPT_IN_ANSWER_KEY,
  WHATSAPP_OPT_IN_ANSWER_KEY,
} from '../booking/contactFields'
import { hasResolvableActions, ruleSendsWhatsApp, type ResolvedActions } from '../utils/automationEngine'

// docs/whatsapp-outbound.md → "6. Phase 2".

describe('whatsapp phase 2 — two answers', () => {
  const both = {
    whatsapp_consent: { status: 'opted_in' },
    whatsapp_marketing_consent: { status: 'opted_out' },
  }

  it('reminders and news-and-offers are read independently', () => {
    assert.equal(whatsappConsentAllows(both, 'reminders'), true)
    assert.equal(whatsappConsentAllows(both, 'marketing'), false)
    assert.equal(whatsappConsentAllows(both), true, 'absent kind reads reminders, as every Phase 1 caller did')
  })

  it('a template asks the answer its category needs', () => {
    assert.equal(whatsappConsentKindFor('UTILITY'), 'reminders')
    assert.equal(whatsappConsentKindFor('MARKETING'), 'marketing')
    assert.equal(whatsappConsentKindFor(undefined), 'marketing', 'unknown is treated as the stricter one')
  })

  it('the builder writes the field of its kind, whole', () => {
    const patch = whatsappConsentPatch('marketing', true, 'staff', 'uid1')
    assert.deepEqual(Object.keys(patch), ['whatsapp_marketing_consent'])
    assert.equal(patch.whatsapp_marketing_consent.status, 'opted_in')
    assert.equal(patch.whatsapp_marketing_consent.recorded_by, 'uid1')
  })

  it('a STOP ends both answers', () => {
    const patch = whatsappStopPatch('reply_stop')
    assert.equal(patch.whatsapp_consent.status, 'opted_out')
    assert.equal(patch.whatsapp_marketing_consent.status, 'opted_out')
  })

  it('the book form records each box on its own', () => {
    const onlyNews = buildContactFieldPatch({
      fields: [],
      answers: { [WHATSAPP_MARKETING_OPT_IN_ANSWER_KEY]: true },
      definitions: [],
    })
    assert.deepEqual(Object.keys(onlyNews), ['whatsapp_marketing_consent'])
    const both = buildContactFieldPatch({
      fields: [],
      answers: { [WHATSAPP_OPT_IN_ANSWER_KEY]: true, [WHATSAPP_MARKETING_OPT_IN_ANSWER_KEY]: true },
      definitions: [],
    })
    assert.deepEqual(Object.keys(both).sort(), ['whatsapp_consent', 'whatsapp_marketing_consent'])
  })
})

describe('whatsapp phase 2 — templates written in Linyup', () => {
  it('accepts a normal message', () => {
    assert.deepEqual(validateWhatsAppTemplateBody('Hi {{firstname}}, we miss you at {{teamName}}. Book: {{bookingUrl}} !'), {
      problems: [],
      unknown: [],
    })
  })

  it('finds what Meta would refuse', () => {
    assert.deepEqual(validateWhatsAppTemplateBody('   ').problems, ['empty'])
    assert.ok(validateWhatsAppTemplateBody('{{firstname}}, hi there.').problems.includes('starts_with_token'))
    assert.ok(validateWhatsAppTemplateBody('See you, {{firstname}}').problems.includes('ends_with_token'))
    assert.ok(validateWhatsAppTemplateBody('Hi {{firstname}} {{lastname}} there.').problems.includes('adjacent_tokens'))
    const unknown = validateWhatsAppTemplateBody('Hi {{nickname}} there.')
    assert.ok(unknown.problems.includes('unknown_token'))
    assert.deepEqual(unknown.unknown, ['nickname'])
    assert.ok(validateWhatsAppTemplateBody(`Hi ${'x'.repeat(WHATSAPP_TEMPLATE_BODY_MAX)}`).problems.includes('too_long'))
  })

  it('renames tokens to named parameters, once each, with examples', () => {
    const { text, params } = whatsappTemplateForMeta('Hi {{firstname}}! {{ teamName }} misses {{firstname}}.')
    assert.equal(text, 'Hi {{first_name}}! {{studio_name}} misses {{first_name}}.')
    assert.deepEqual(
      params.map((p) => [p.token, p.name]),
      [
        ['firstname', 'first_name'],
        ['teamName', 'studio_name'],
      ],
    )
    assert.ok(params.every((p) => p.example))
  })

  it('builds the create payload, with examples only when there are parameters', () => {
    const withParams = buildStudioTemplateCreatePayload({
      metaName: 'lyp_x',
      language: 'de',
      category: 'MARKETING',
      body: 'Hallo {{firstname}}, bis bald.',
    }) as any
    assert.equal(withParams.parameter_format, 'NAMED')
    assert.equal(withParams.components[0].text, 'Hallo {{first_name}}, bis bald.')
    assert.equal(withParams.components[0].example.body_text_named_params[0].param_name, 'first_name')
    const plain = buildStudioTemplateCreatePayload({ metaName: 'lyp_y', language: 'en', category: 'UTILITY', body: 'Hello.' }) as any
    assert.equal(plain.components[0].example, undefined)
  })

  it('a Meta name is fresh, lowercase and never reused', () => {
    const a = newMetaTemplateName()
    assert.match(a, /^lyp_[0-9a-f]{12}$/)
    assert.notEqual(a, newMetaTemplateName())
  })

  it('sends only the live approved version', () => {
    const submission = { meta_name: 'lyp_a', category: 'MARKETING', body: 'x', reason: null } as any
    assert.equal(whatsappStudioTemplateSendable({ live: { ...submission, status: 'APPROVED' } }), true)
    assert.equal(whatsappStudioTemplateSendable({ live: { ...submission, status: 'PAUSED' } }), false)
    assert.equal(whatsappStudioTemplateSendable({ live: null }), false)
  })

  it('a template without parameters sends without a body component', () => {
    const p = buildSendPayload({ toE164: '+41790000000', name: 'lyp_a', language: 'de', bodyParams: [] }) as any
    assert.equal(p.template.components, undefined)
    assert.equal(p.to, '41790000000')
  })

  it('the webhook reads a category change', () => {
    const events = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA1',
          changes: [
            {
              field: 'template_category_update',
              value: { message_template_name: 'lyp_a', previous_category: 'UTILITY', new_category: 'MARKETING' },
            },
          ],
        },
      ],
    })
    assert.deepEqual(events, [{ kind: 'template_category', wabaId: 'WABA1', name: 'lyp_a', category: 'MARKETING' }])
    assert.equal(typeof META_STOPPED_PROMOTIONS, 'number')
  })
})

describe('whatsapp phase 2 — the automation action', () => {
  const resolved = (ids: string[]): ResolvedActions => ({
    template: null,
    alertPreset: null,
    language: 'en',
    activePlugins: new Set(),
    whatsappTemplateIds: new Set(ids),
  })

  it('a WhatsApp action is resolvable only with a sendable template', () => {
    const actions = [{ type: 'send_whatsapp' as const, templateId: 't1' }]
    assert.equal(hasResolvableActions(actions, resolved(['t1'])), true)
    assert.equal(hasResolvableActions(actions, resolved([])), false)
  })

  it('a rule that sends WhatsApp is not gated on email', () => {
    assert.equal(ruleSendsWhatsApp([{ type: 'send_whatsapp', templateId: 't1' }]), true)
    assert.equal(ruleSendsWhatsApp([{ type: 'send_email', templateId: 'e1' }]), false)
  })

  it('one message per rule, contact and studio day; a task id Cloud Tasks accepts', () => {
    // 23:30 UTC on the 21st is already the 22nd in Zurich.
    const key = whatsappAutomationKey('r1', 'c1', new Date('2026-09-21T23:30:00Z'))
    assert.equal(key, 'wa-auto-r1-c1-2026-09-22')
    assert.match(heldTaskId('wa-auto-r:1-c/1-2026-09-22'), /^[A-Za-z0-9_-]+$/)
  })

  it('the month starts at midnight in Zurich', () => {
    assert.equal(monthStartZurich(new Date('2026-09-18T10:00:00Z')).toISOString(), '2026-08-31T22:00:00.000Z')
    assert.equal(monthStartZurich(new Date('2026-12-05T10:00:00Z')).toISOString(), '2026-11-30T23:00:00.000Z')
  })
})

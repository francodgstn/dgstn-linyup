import assert from 'node:assert/strict'
import { extractSiteUnits, priceTermMonths, pricingTerms } from '@linyup/shared'
import type { WebsiteSection } from '@linyup/shared'
import { applyFormChecks, sanitizeSection } from './sanitize'

describe('form sections at publish', () => {
  const lists = (): WebsiteSection[][] => [
    [
      { id: 'hero', type: 'hero', headline: 'x' } as WebsiteSection,
      { id: 'ok', type: 'form', formId: 'f-ok', next: { kind: 'appointment', activityId: 'a-intro' } },
    ],
    [
      { id: 'draft', type: 'form', formId: 'f-draft' },
      { id: 'other', type: 'form', formId: 'f-other' },
      { id: 'gone', type: 'form', formId: 'f-gone' },
      { id: 'badnext', type: 'form', formId: 'f-ok', next: { kind: 'appointment', activityId: 'a-class' } },
    ],
  ]
  const facts = {
    forms: new Map([
      ['f-ok', { teamId: 't1', status: 'published' }],
      ['f-draft', { teamId: 't1', status: 'draft' }],
      ['f-other', { teamId: 't2', status: 'published' }],
    ]),
    activities: new Map([
      ['a-intro', { teamId: 't1', type: 'appointment' }],
      ['a-class', { teamId: 't1', type: 'class' }],
    ]),
  }

  it("keeps only this team's published forms, and a follow-up only to its appointment activities", () => {
    const l = lists()
    const removed = applyFormChecks(l, 't1', facts)
    assert.deepEqual(removed, ['draft', 'other', 'gone'])
    assert.deepEqual(l.map((list) => list.map((s) => s.id)), [['hero', 'ok'], ['badnext']])
    assert.deepEqual((l[0][1] as { next?: unknown }).next, { kind: 'appointment', activityId: 'a-intro' })
    assert.equal('next' in l[1][0], false)
  })
})

// Phase 4 of the website builder: people, forms and pricing by term.

describe('pricing terms', () => {
  it('reads the commitment off a price', () => {
    assert.equal(priceTermMonths({ recurrence: 'monthly' }), 1)
    assert.equal(priceTermMonths({ recurrence: 'monthly', included_months: 6 }), 6)
    assert.equal(priceTermMonths({ recurrence: 'annual' }), 12)
    assert.equal(priceTermMonths({ recurrence: 'quarterly' }), 3)
    assert.equal(priceTermMonths({ recurrence: 'one_time', included_months: 12 }), 12)
  })

  it('has no term for a credit pack, a per-class or weekly price, or a bare one-off', () => {
    assert.equal(priceTermMonths({ recurrence: 'one_time', included_months: 2, credits: 10 }), null)
    assert.equal(priceTermMonths({ recurrence: 'per_class' }), null)
    assert.equal(priceTermMonths({ recurrence: 'weekly' }), null)
    assert.equal(priceTermMonths({ recurrence: 'one_time' }), null)
  })

  it('lists the distinct terms across plans, shortest first', () => {
    const plans = [
      { prices: [{ recurrence: 'monthly', included_months: 12 }, { recurrence: 'monthly' }] },
      { prices: [{ recurrence: 'monthly', included_months: 6 }, { recurrence: 'monthly' }] },
      { prices: [{ recurrence: 'one_time', included_months: 2, credits: 10 }] },
      {},
    ]
    assert.deepEqual(pricingTerms(plans), [1, 6, 12])
  })
})

describe('team section', () => {
  it('keeps people with a name and drops the rest', () => {
    const out = sanitizeSection({
      id: 'team',
      type: 'team',
      columns: 4,
      layout: 'contact',
      items: [
        { name: 'Patrick', role: 'Head Coach', badge: 'CF-L3', bio: 'Seit 2014', imageUrl: 'https://x.ch/p.png', email: 'patrick@x.ch', phone: '+41 41 790 10 48' },
        { role: 'No name' },
        { name: 'Bad contact', email: 'not an email', imageUrl: 'javascript:alert(1)' },
      ],
    }) as unknown as { layout: string; items: Record<string, unknown>[] }
    assert.equal(out.layout, 'contact')
    assert.deepEqual(out.items.map((i) => i.name), ['Patrick', 'Bad contact'])
    assert.equal(out.items[0].email, 'patrick@x.ch')
    assert.equal(out.items[1].email, undefined)
    assert.equal(out.items[1].imageUrl, undefined)
  })

  it('is dropped with nobody in it', () => {
    assert.equal(sanitizeSection({ id: 'team', type: 'team', items: [{ role: 'x' }] }), null)
  })

  it('translates roles and bios, never names or badges', () => {
    const keys = extractSiteUnits({
      sections: [{ id: 't', type: 'team', columns: 3, items: [{ name: 'Patrick', role: 'Coach', badge: 'CF-L2', bio: 'Hi' }] }],
    }).map((u) => u.text)
    assert.ok(keys.includes('Coach'))
    assert.ok(keys.includes('Hi'))
    assert.ok(!keys.includes('Patrick'))
    assert.ok(!keys.includes('CF-L2'))
  })
})

describe('form section', () => {
  it('keeps the form and an appointment follow-up', () => {
    assert.deepEqual(
      sanitizeSection({ id: 'f', type: 'form', formId: 'form-1', heading: 'Intro', next: { kind: 'appointment', activityId: 'act-1' } }),
      { id: 'f', type: 'form', formId: 'form-1', heading: 'Intro', next: { kind: 'appointment', activityId: 'act-1' } }
    )
  })

  it('drops a section with no form, and a follow-up it does not know', () => {
    assert.equal(sanitizeSection({ id: 'f', type: 'form', heading: 'Intro' }), null)
    const out = sanitizeSection({ id: 'f', type: 'form', formId: 'form-1', next: { kind: 'url', url: 'https://x.ch' } })
    assert.equal((out as { next?: unknown }).next, undefined)
  })

  it('keeps a pricing section grouped by term', () => {
    const out = sanitizeSection({ id: 'p', type: 'pricing', groupBy: 'term' }) as { groupBy?: string }
    assert.equal(out.groupBy, 'term')
    assert.equal((sanitizeSection({ id: 'p', type: 'pricing', groupBy: 'size' }) as { groupBy?: string }).groupBy, undefined)
  })
})

import assert from 'node:assert/strict'
import { extractSiteUnits } from '@linyup/shared'
import { sanitizeMeta, sanitizeSection } from './sanitize'

// The two-column section, and the two look settings that came with it.

describe('split section', () => {
  const full = {
    id: 'crossfit',
    type: 'split',
    heading: 'Was dich bei *CrossFit* erwartet',
    subheading: 'Funktionelles Training',
    body: '<p>60 Minuten</p>',
    items: [
      { icon: 'Users', title: 'Coaching', text: 'In kleinen Klassen' },
      { title: 'Kein Titel? dann raus', text: 'x' },
    ],
    side: {
      heading: 'Gut zu wissen',
      text: 'Kostenlos starten',
      imageUrl: 'https://x.ch/side.jpg',
      facts: [{ label: 'Dauer', value: '60 Min.' }, { label: 'ohne Wert' }],
      cta: { label: 'Start', action: 'page', pageId: 'p-intro' },
    },
    sidePosition: 'left',
    sideSticky: true,
  }

  it('keeps both columns, and drops an item with no title or a fact with no value', () => {
    const out = sanitizeSection({ ...full, items: [full.items[0], { text: 'no title' }] }) as unknown as {
      items: unknown[]
      side: { facts: unknown[]; cta: unknown }
      sidePosition: string
      sideSticky: boolean
    }
    assert.deepEqual(out.items, [{ icon: 'Users', title: 'Coaching', text: 'In kleinen Klassen' }])
    assert.deepEqual(out.side.facts, [{ label: 'Dauer', value: '60 Min.' }])
    assert.deepEqual(out.side.cta, { label: 'Start', action: 'page', pageId: 'p-intro' })
    assert.equal(out.sidePosition, 'left')
    assert.equal(out.sideSticky, true)
  })

  it('refuses an unsafe panel image and a made-up side position', () => {
    const out = sanitizeSection({
      ...full,
      side: { ...full.side, imageUrl: 'javascript:alert(1)' },
      sidePosition: 'middle',
    }) as unknown as { side: { imageUrl?: string }; sidePosition?: string }
    assert.equal(out.side.imageUrl, undefined)
    assert.equal(out.sidePosition, undefined)
  })

  it('is dropped only when BOTH columns are empty', () => {
    assert.equal(sanitizeSection({ id: 's', type: 'split' }), null)
    assert.equal(sanitizeSection({ id: 's', type: 'split', items: [{ text: 'no title' }] }), null)
    assert.notEqual(sanitizeSection({ id: 's', type: 'split', heading: 'Nur eine Überschrift' }), null)
    assert.notEqual(sanitizeSection({ id: 's', type: 'split', side: { text: 'Nur ein Panel' } }), null)
  })

  it('translates both columns, the panel and its facts', () => {
    const keys = new Map(
      extractSiteUnits({ sections: [sanitizeSection(full) as never] }).map((u) => [u.key, u.text])
    )
    assert.equal(keys.get('s.crossfit.heading'), 'Was dich bei *CrossFit* erwartet')
    assert.equal(keys.get('s.crossfit.body'), '<p>60 Minuten</p>')
    assert.equal(keys.get('s.crossfit.item.0.title'), 'Coaching')
    assert.equal(keys.get('s.crossfit.side.heading'), 'Gut zu wissen')
    assert.equal(keys.get('s.crossfit.side.text'), 'Kostenlos starten')
    assert.equal(keys.get('s.crossfit.side.cta'), 'Start')
    assert.equal(keys.get('s.crossfit.side.fact.0.label'), 'Dauer')
    assert.equal(keys.get('s.crossfit.side.fact.0.value'), '60 Min.')
  })
})

describe('site look settings', () => {
  it('publishes a width and a nav case, and refuses anything else', () => {
    const meta = sanitizeMeta({ contentWidth: 'wide', navCase: 'uppercase' }, 'CFZ')
    assert.equal(meta.contentWidth, 'wide')
    assert.equal(meta.navCase, 'uppercase')
    const bad = sanitizeMeta({ contentWidth: 'enormous', navCase: 'shouty' }, 'CFZ')
    assert.equal(bad.contentWidth, undefined)
    assert.equal(bad.navCase, undefined)
  })
})

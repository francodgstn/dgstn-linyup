import assert from 'node:assert/strict'
import {
  SITE_PAGE_LIMITS,
  applySiteTranslations,
  deriveSiteMenu,
  extractSiteUnits,
  findSitePageByPath,
  isValidSitePagePath,
  normalizeSitePagePath,
  sitePageSegments,
  translationSourceHash,
  type SitePageRef,
} from '@linyup/shared'
import { dedupeSectionIds, sanitizeCta, sanitizeMenu, sanitizeMeta, sanitizePageRefs, sanitizeSection } from './sanitize'

// Multi-page sites. The path grammar is what every URL, custom domain and
// crawler sees, and the page index is world-readable once published — so both
// are validated here the same way the publish callable does.

describe('site pages — path grammar', () => {
  it('accepts plain lowercase paths up to three segments', () => {
    for (const path of ['angebot', 'angebot/crossfit', 'ueber-uns/team/coaches', 'faq-2026']) {
      assert.equal(isValidSitePagePath(path), true, path)
    }
  })

  it('refuses anything a URL, a proxy or a crawler would trip on', () => {
    for (const path of ['', '/angebot', 'angebot/', 'Angebot', 'über-uns', 'a b', 'file.html', 'a--b', '-a', 'a/b/c/d', 'x'.repeat(61)]) {
      assert.equal(isValidSitePagePath(path), false, JSON.stringify(path))
    }
  })

  it('normalises what a studio types', () => {
    assert.equal(normalizeSitePagePath('Über uns / Team'), 'ueber-uns/team')
    assert.equal(normalizeSitePagePath('  Preise & Abos!  '), 'preise-abos')
    assert.equal(normalizeSitePagePath('/a/b/c/d/'), 'a/b/c')
    assert.equal(normalizeSitePagePath('???'), '')
    assert.equal(isValidSitePagePath(normalizeSitePagePath('Crème Brûlée')), true)
  })

  it('resolves URL segments to a visible page only', () => {
    const pages = [
      { id: 'p1', path: 'angebot/crossfit' },
      { id: 'p2', path: 'geheim', hidden: true },
    ]
    assert.equal(findSitePageByPath(pages, sitePageSegments('angebot/crossfit'))?.id, 'p1')
    assert.equal(findSitePageByPath(pages, ['Angebot', 'CrossFit'])?.id, 'p1')
    assert.equal(findSitePageByPath(pages, ['geheim']), null)
    assert.equal(findSitePageByPath(pages, []), null)
  })
})

describe('site pages — publish sanitizer', () => {
  it('keeps valid refs whole', () => {
    const refs: SitePageRef[] = [
      { id: 'p1', path: 'angebot/crossfit', title: 'CrossFit', navLabel: 'CF', seo: { title: 't', description: 'd' } },
      { id: 'p2', path: 'preise', title: 'Preise', hidden: true },
    ]
    assert.deepEqual(sanitizePageRefs(structuredClone(refs)), refs)
  })

  it('drops refs with no id, no title, an invalid or duplicate path, and caps the list', () => {
    const out = sanitizePageRefs([
      { id: 'a', path: 'ok', title: 'Ok' },
      { path: 'no-id', title: 'x' },
      { id: 'b', path: 'no-title' },
      { id: 'c', path: 'Bad Path', title: 'x' },
      { id: 'd', path: 'ok', title: 'Duplicate path' },
      { id: 'a', path: 'dup-id', title: 'Duplicate id' },
    ])
    assert.deepEqual(out.map((p) => p.id), ['a'])
    const many = Array.from({ length: SITE_PAGE_LIMITS.maxPages + 5 }, (_, i) => ({ id: `p${i}`, path: `p-${i}`, title: `P${i}` }))
    assert.equal(sanitizePageRefs(many).length, SITE_PAGE_LIMITS.maxPages)
  })

  it('publishes a page menu target and a page CTA, and drops them without a page id', () => {
    assert.deepEqual(sanitizeMenu([{ id: 'm1', target: { kind: 'page', pageId: 'p1', sectionId: 's1' } }]), [
      { id: 'm1', target: { kind: 'page', pageId: 'p1', sectionId: 's1' } },
    ])
    assert.equal(sanitizeMenu([{ id: 'm2', target: { kind: 'page' } }]), undefined)
    assert.deepEqual(sanitizeCta({ label: 'Preise', action: 'page', pageId: 'p2' }), { label: 'Preise', action: 'page', pageId: 'p2' })
    assert.equal(sanitizeCta({ label: 'Preise', action: 'page' }), undefined)
  })

  it('makes section ids unique across the whole site — first occurrence wins', () => {
    const home = [{ id: 's1' }, { id: 's2' }]
    const pageA = [{ id: 's2' }, { id: 's3' }]
    const pageB = [{ id: 's3' }, { id: 's4' }]
    const { lists, dropped } = dedupeSectionIds([home, pageA, pageB])
    assert.deepEqual(lists.map((list) => list.map((s) => s.id)), [['s1', 's2'], ['s3'], ['s4']])
    assert.deepEqual(dropped, ['s2', 's3'])
  })
})

describe('site pages — menu and translations', () => {
  it('a derived menu lists visible pages after the home anchors', () => {
    const menu = deriveSiteMenu({
      sections: [{ id: 'hero', type: 'hero' }, { id: 'faq', type: 'faq' }],
      surfaceLinks: [{ surface: 'shop' }],
      pages: [{ id: 'p1' }, { id: 'p2', hidden: true }],
    })
    assert.deepEqual(menu.map((item) => item.id), ['section:faq', 'page:p1', 'surface:shop'])
  })

  it('page titles, nav labels and SEO extract under page.{id}.* and substitute back', () => {
    const pages: SitePageRef[] = [{ id: 'p1', path: 'preise', title: 'Prices', navLabel: 'Plans', seo: { title: 'Our prices', description: 'All plans' } }]
    const byKey = new Map(extractSiteUnits({ pages, sections: [] }).map((u) => [u.key, u.text]))
    assert.equal(byKey.get('page.p1.title'), 'Prices')
    assert.equal(byKey.get('page.p1.navLabel'), 'Plans')
    assert.equal(byKey.get('page.p1.seo.title'), 'Our prices')
    assert.equal(byKey.get('page.p1.seo.description'), 'All plans')
    // The path is a URL, never translated.
    assert.equal([...byKey.values()].includes('preise'), false)

    const out = applySiteTranslations(
      { pages, sections: [] },
      { 'page.p1.title': { text: 'Preise', srcHash: translationSourceHash('Prices') } }
    )
    assert.equal(out.pages?.[0].title, 'Preise')
    assert.equal(pages[0].title, 'Prices')
  })
})

describe('site pages — header button and card links', () => {
  it('publishes a header button that opens a page, and falls back to booking without one', () => {
    const toPage = sanitizeMeta({ header: { ctaLabel: 'Preise', ctaAction: 'page', ctaPageId: 'p-preise', ctaUrl: 'https://x.ch' } }, 'CFZ').header
    assert.equal(toPage.ctaAction, 'page')
    assert.equal(toPage.ctaPageId, 'p-preise')
    assert.equal(toPage.ctaUrl, undefined)
    const noPage = sanitizeMeta({ header: { ctaLabel: 'Preise', ctaAction: 'page' } }, 'CFZ').header
    assert.equal(noPage.ctaAction, 'booking')
    assert.equal(noPage.ctaPageId, undefined)
    const toUrl = sanitizeMeta({ header: { ctaAction: 'url', ctaUrl: 'https://x.ch', ctaPageId: 'p-preise' } }, 'CFZ').header
    assert.equal(toUrl.ctaPageId, undefined)
  })

  it('keeps a feature card link to a page', () => {
    const section = sanitizeSection({
      id: 'f',
      type: 'features',
      items: [{ title: 'CrossFit', linkLabel: 'Mehr', linkPageId: 'p-crossfit' }],
    }) as unknown as { items: { linkPageId?: string }[] }
    assert.equal(section.items[0].linkPageId, 'p-crossfit')
  })
})

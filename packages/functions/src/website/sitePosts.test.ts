import assert from 'node:assert/strict'
import {
  SITE_PAGE_LIMITS,
  deriveSiteMenu,
  extractSiteUnits,
  isValidSiteDate,
  sitePosts,
  type SitePageRef,
} from '@linyup/shared'
import { sanitizePageRefs, sanitizeSection } from './sanitize'

// Phase 5 of the website builder: a blog post is a page with `kind: 'post'`.

describe('site posts — the page index', () => {
  it('keeps post fields on posts and never on pages', () => {
    const out = sanitizePageRefs([
      {
        id: 'p1',
        path: 'blog/member-of-the-month',
        title: 'Member of the Month',
        kind: 'post',
        publishedOn: '2026-08-01',
        coverImageUrl: 'https://x.ch/cover.jpg',
        excerpt: 'Unser Mitglied im August.',
      },
      { id: 'p2', path: 'preise', title: 'Preise', publishedOn: '2026-08-01', excerpt: 'x', coverImageUrl: 'https://x.ch/c.jpg' },
    ])
    assert.deepEqual(out[0], {
      id: 'p1',
      path: 'blog/member-of-the-month',
      title: 'Member of the Month',
      kind: 'post',
      publishedOn: '2026-08-01',
      coverImageUrl: 'https://x.ch/cover.jpg',
      excerpt: 'Unser Mitglied im August.',
    })
    assert.deepEqual(out[1], { id: 'p2', path: 'preise', title: 'Preise' })
  })

  it('drops an invalid date and an unsafe cover, keeping the post', () => {
    const [post] = sanitizePageRefs([
      { id: 'p1', path: 'blog/a', title: 'A', kind: 'post', publishedOn: '1.8.2026', coverImageUrl: 'javascript:alert(1)' },
    ])
    assert.equal(post.kind, 'post')
    assert.equal(post.publishedOn, undefined)
    assert.equal(post.coverImageUrl, undefined)
  })

  it('caps pages and posts separately', () => {
    const pages = Array.from({ length: SITE_PAGE_LIMITS.maxPages + 3 }, (_, i) => ({ id: `page${i}`, path: `seite-${i}`, title: `S${i}` }))
    const posts = Array.from({ length: 5 }, (_, i) => ({ id: `post${i}`, path: `blog/post-${i}`, title: `P${i}`, kind: 'post' }))
    const out = sanitizePageRefs([...pages, ...posts])
    assert.equal(out.filter((r) => r.kind !== 'post').length, SITE_PAGE_LIMITS.maxPages)
    assert.equal(out.filter((r) => r.kind === 'post').length, 5)
  })

  it('validates post dates', () => {
    assert.equal(isValidSiteDate('2026-02-28'), true)
    for (const bad of ['2026-13-01', '2026-1-01', '26-01-01', '', null, 20260101]) assert.equal(isValidSiteDate(bad), false)
  })

  it('orders visible posts newest first, undated last, ties by title', () => {
    const refs: SitePageRef[] = [
      { id: 'a', path: 'blog/a', title: 'B post', kind: 'post', publishedOn: '2026-06-01' },
      { id: 'b', path: 'blog/b', title: 'A post', kind: 'post', publishedOn: '2026-06-01' },
      { id: 'c', path: 'blog/c', title: 'Newest', kind: 'post', publishedOn: '2026-08-01' },
      { id: 'd', path: 'blog/d', title: 'Undated', kind: 'post' },
      { id: 'e', path: 'blog/e', title: 'Hidden', kind: 'post', publishedOn: '2026-09-01', hidden: true },
      { id: 'f', path: 'preise', title: 'Page' },
    ]
    assert.deepEqual(sitePosts(refs).map((p) => p.id), ['c', 'b', 'a', 'd'])
  })

  it('leaves posts out of the derived menu', () => {
    const menu = deriveSiteMenu({
      sections: [],
      surfaceLinks: [],
      pages: [{ id: 'blog' }, { id: 'post1', kind: 'post' }],
    })
    assert.deepEqual(menu.map((item) => item.id), ['page:blog'])
  })

  it('translates a post excerpt with its title', () => {
    const units = new Map(
      extractSiteUnits({
        pages: [{ id: 'p1', path: 'blog/a', title: 'Title', kind: 'post', excerpt: 'Excerpt' }],
        sections: [],
      }).map((u) => [u.key, u.text])
    )
    assert.equal(units.get('page.p1.title'), 'Title')
    assert.equal(units.get('page.p1.excerpt'), 'Excerpt')
  })
})

describe('posts section', () => {
  it('defaults its limit and bounds it', () => {
    assert.equal((sanitizeSection({ id: 'posts', type: 'posts' }) as { limit?: number }).limit, 6)
    assert.equal((sanitizeSection({ id: 'posts', type: 'posts', limit: 500 }) as { limit?: number }).limit, 24)
    const list = sanitizeSection({ id: 'posts', type: 'posts', layout: 'list', columns: 2, heading: 'Blog' })
    assert.deepEqual(list, { id: 'posts', type: 'posts', heading: 'Blog', limit: 6, layout: 'list', columns: 2 })
  })
})

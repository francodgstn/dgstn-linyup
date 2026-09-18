import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT_SITE_PARTS, sitePartOffered } from '@linyup/shared'
import { sanitizeSection } from './sanitize'

// CLIENT-OWNED WEBSITE PARTS: offered only to their client, never withheld from
// a site that already uses them. Lives here for the same reason as
// web/selectItemLabels.test.ts — apps/web has no test runner.

const PLUGINS_DIR = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'src', 'plugins')

function manifestIds(): Set<string> {
  const ids = new Set<string>()
  for (const entry of readdirSync(PLUGINS_DIR)) {
    const file = join(PLUGINS_DIR, entry, 'manifest.ts')
    if (!existsSync(file)) continue
    const id = /\bid:\s*'([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1]
    if (id) ids.add(id)
  }
  return ids
}

function owners(): string[] {
  const styles = Object.values(CLIENT_SITE_PARTS.sectionStyles).flatMap((byStyle) => Object.values(byStyle ?? {}))
  return [
    ...Object.values(CLIENT_SITE_PARTS.sectionTypes),
    ...styles,
    ...Object.values(CLIENT_SITE_PARTS.themes),
  ].filter((id): id is string => !!id)
}

describe('client-owned website parts', () => {
  it('every owner is a real plugin manifest', () => {
    const ids = manifestIds()
    assert.ok(ids.size > 10, 'expected to find the plugin manifests')
    for (const owner of owners()) assert.ok(ids.has(owner), `CLIENT_SITE_PARTS names "${owner}", which has no manifest`)
  })

  it('offers a client part only to a tenant with its plugin, and a generic part to everyone', () => {
    const owner = CLIENT_SITE_PARTS.sectionTypes.split
    assert.ok(owner)
    assert.equal(sitePartOffered(owner, () => false), false)
    assert.equal(sitePartOffered(owner, undefined), false)
    assert.equal(sitePartOffered(owner, (id) => id === owner), true)
    assert.equal(sitePartOffered(undefined, undefined), true)
  })

  it('publishing never consults the plugin — a client section survives its removal', () => {
    // The sanitizer takes no tenant and no plugin list: a split section and the
    // panels styles publish for any site that already has them.
    const split = sanitizeSection({ id: 's', type: 'split', heading: 'CrossFit', items: [{ title: 'Coaching' }] })
    assert.equal(split?.type, 'split')
    const faq = sanitizeSection({ id: 'f', type: 'faq', style: 'panels', items: [{ question: 'q', answer: 'a' }] })
    assert.equal((faq as { style?: string } | null)?.style, 'panels')
  })
})

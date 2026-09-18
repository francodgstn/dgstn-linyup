import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readText, parseFrontmatter, AREAS } from '../../scripts/lib/docsMeta.mjs'

// LOCAL ONLY — this site is never deployed. docs/ carries open-defects.md
// (a register of unfixed bugs), security-audit-2026-07.md, product-strategy.md
// and test-accounts.md, none of which belongs on a public URL. CI builds it so
// it cannot silently break; nothing is hosted. See the plan in the commit that
// added this app for what hosting would take if it is ever wanted.

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '')
const DOCS = join(ROOT, 'docs')

const AREA_TITLE: Record<string, string> = {
  payments: 'Payments & finance',
  booking: 'Booking',
  contacts: 'Contacts & membership',
  content: 'Public content',
  platform: 'Platform & API',
  mobile: 'Member app',
  ops: 'Operations',
  product: 'Product & registers',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e)
    if (statSync(f).isDirectory()) walk(f, out)
    else if (e.endsWith('.md')) out.push(relative(DOCS, f).replaceAll('\\', '/'))
  }
  return out
}

// The sidebar is built from the SAME frontmatter the index generator reads, so
// the two can never disagree about which area a document belongs to.
type Entry = { slug: string; label: string; area: string; status: string }
const entries: Entry[] = []
for (const rel of walk(DOCS).sort()) {
  if (rel === 'README.md' || rel.endsWith('/README.md')) continue
  const { data } = parseFrontmatter(readText(join(DOCS, rel)))
  if (!data?.title) continue
  entries.push({
    slug: rel.replace(/\.md$/, ''),
    label: String(data.title),
    area: String(data.area),
    status: String(data.status),
  })
}

const live = entries.filter((e) => e.status === 'living' || e.status === 'plan')
const past = entries.filter((e) => e.status === 'record' || e.status === 'closed')

const sidebar = [
  ...AREAS.filter((a) => live.some((e) => e.area === a)).map((a) => ({
    label: AREA_TITLE[a] ?? a,
    items: live
      .filter((e) => e.area === a)
      .sort((x, y) => x.label.localeCompare(y.label))
      .map((e) => ({ label: e.label, slug: e.slug })),
  })),
  {
    label: 'Closed & point-in-time',
    collapsed: true,
    items: past
      .sort((x, y) => x.label.localeCompare(y.label))
      .map((e) => ({ label: e.label, slug: e.slug })),
  },
]

export default defineConfig({
  output: 'static',
  integrations: [
    starlight({
      title: 'Linyup engineering',
      description: 'Internal documentation. Not published.',
      sidebar,
      pagefind: true,
    }),
  ],
  vite: {
    server: {
      watch: {
        // `astro dev` never finished starting (30s+, no server ever bound) —
        // Vite's watcher crawls the whole workspace root by default, and this
        // repo keeps `.claude/worktrees/` INSIDE that root: ~16 full nested
        // copies of the monorepo, each with its own node_modules. Same
        // species of problem as apps/web's `turbopack.root` pin (Next.js
        // inferring too broad a root in the same layout) — Vite has no
        // automatic fix, so the watcher needs telling explicitly.
        ignored: ['**/.claude/worktrees/**'],
      },
    },
  },
})

import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readText,
  parseFrontmatter,
  AREAS,
  AREA_TITLE,
  byOrder,
  EXTERNAL_DOCS,
  claudeSections,
} from '../../scripts/lib/docsMeta.mjs'

// LOCAL ONLY — this site is never deployed. docs/ carries open-defects.md
// (a register of unfixed bugs), security-audit-2026-07.md, product-strategy.md
// and test-accounts.md, none of which belongs on a public URL. CI builds it so
// it cannot silently break; nothing is hosted. See the plan in the commit that
// added this app for what hosting would take if it is ever wanted.

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '')
const DOCS = join(ROOT, 'docs')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e)
    if (statSync(f).isDirectory()) walk(f, out)
    else if (e.endsWith('.md')) out.push(relative(DOCS, f).replaceAll('\\', '/'))
  }
  return out
}

// The sidebar is built from the SAME metadata the index generator and the home
// page read (docs frontmatter + docsMeta.mjs), so they can never disagree about
// where a page belongs. Every area is a collapsed group — the sidebar reads as a
// table of contents first; Starlight opens the group holding the current page.
type Entry = { slug: string; title: string; area: string; status: string; order?: number | string }
const entries: Entry[] = []
for (const rel of walk(DOCS).sort()) {
  if (rel === 'README.md' || rel.endsWith('/README.md')) continue
  const { data } = parseFrontmatter(readText(join(DOCS, rel)))
  if (!data?.title) continue
  entries.push({
    slug: rel.replace(/\.md$/, ''),
    title: String(data.title),
    area: String(data.area),
    status: String(data.status),
    order: data.order as string | undefined,
  })
}
for (const d of EXTERNAL_DOCS) entries.push({ slug: d.id, title: d.title, area: d.area, status: 'living', order: d.order })
for (const s of claudeSections(readText(join(ROOT, 'CLAUDE.md')))) {
  entries.push({ slug: s.id, title: s.title, area: s.area, status: 'living', order: s.order })
}

const item = (e: Entry) => ({
  label: e.title,
  slug: e.slug,
  ...(e.status === 'plan' ? { badge: { text: 'plan', variant: 'caution' as const } } : {}),
})
const current = entries.filter((e) => e.status === 'living' || e.status === 'plan')
const past = entries.filter((e) => e.status === 'record' || e.status === 'closed')

const sidebar = [
  ...AREAS.filter((a) => current.some((e) => e.area === a)).map((a) => ({
    label: AREA_TITLE[a] ?? a,
    collapsed: a !== 'start',
    items: current.filter((e) => e.area === a).sort(byOrder).map(item),
  })),
  {
    label: 'Records',
    collapsed: true,
    items: past.sort((x, y) => x.title.localeCompare(y.title)).map(item),
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
      customCss: ['./src/styles/brand.css', './src/styles/docs.css'],
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      favicon: '/favicon.svg',
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Fredoka:wght@700&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Sora:wght@700&display=swap',
          },
        },
      ],
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

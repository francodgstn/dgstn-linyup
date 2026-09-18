import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'
import { glob, type Loader } from 'astro/loaders'
import { docsSchema } from '@astrojs/starlight/schema'
import { join, posix, resolve } from 'node:path'
import { readText, EXTERNAL_DOCS, claudeSections } from '../../../scripts/lib/docsMeta.mjs'

// SINGLE SOURCE OF TRUTH: every page is read from where it already lives. No
// copy, no symlink — a second copy is a second thing to go stale, and the
// ~616 bare `docs/x.md` paths in .ts comments point at the real files.
//
// Three sources feed the one collection:
//   - docs/**           the documents, with their own frontmatter
//   - EXTERNAL_DOCS     READMEs and skills next to the code they describe
//   - CLAUDE.md         split into one page per section (CLAUDE_SECTIONS)
// The last two carry no frontmatter; their metadata lives in docsMeta.mjs.

const ROOT = resolve(process.cwd(), '../..')
const REPO_BLOB = 'https://github.com/francodgstn/dgstn-linyup/blob/main/'

/** Relative links in a file rendered away from its folder would break. A link
 *  into docs/ becomes that page's site slug; anything else goes to GitHub. */
function rewriteLinks(body: string, fromRel: string): string {
  const dir = posix.dirname(fromRel)
  return body.replace(/\]\(([^)\s]+)\)/g, (all, href: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(href)) return all
    const [path, hash] = href.split('#')
    const target = posix.normalize(posix.join(dir, path))
    if (target.startsWith('docs/') && target.endsWith('.md')) {
      return `](/${target.slice(5, -3).toLowerCase()}/${hash ? `#${hash}` : ''})`
    }
    return `](${REPO_BLOB}${target}${hash ? `#${hash}` : ''})`
  })
}

function stripHead(src: string): string {
  let s = src.replace(/^---\n[\s\S]*?\n---\n/, '') // a skill's own frontmatter
  s = s.replace(/^\s*#\s+.*\n/, '') // the H1: the site prints the title itself
  return s.trim()
}

type ExternalPage = { id: string; title: string; area: string; order: number; source: string; body: string }

function externalPages(): ExternalPage[] {
  const pages: ExternalPage[] = EXTERNAL_DOCS.map((d) => ({
    id: d.id,
    title: d.title,
    area: d.area,
    order: d.order,
    source: `\`${d.path}\``,
    body: rewriteLinks(stripHead(readText(join(ROOT, d.path))), d.path),
  }))
  for (const s of claudeSections(readText(join(ROOT, 'CLAUDE.md')))) {
    pages.push({
      id: s.id,
      title: s.title,
      area: s.area,
      order: s.order,
      source: `\`CLAUDE.md\` → "${s.heading.replace(/`/g, '')}"`,
      body: rewriteLinks(s.body, 'CLAUDE.md'),
    })
  }
  return pages
}

const docsGlob = glob({ pattern: ['**/*.md', '!**/README.md'], base: '../../docs' })

/** The same rewrite, applied to a docs/ page AFTER it is rendered: documents
 *  link each other as `./x.md` (right on GitHub and on disk), which the site
 *  must turn into `/x/`. Done on the HTML so it holds whichever Markdown
 *  processor Astro ships — the default one changed under us once already. */
function rewriteHtmlLinks(html: string, fromRel: string): string {
  return html.replace(/href="([^"]+)"/g, (all, href: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(href)) return all
    return `href="${rewriteLinks(`](${href})`, fromRel).slice(2, -1)}"`
  })
}

const loader: Loader = {
  name: 'linyup-docs',
  async load(ctx) {
    // Intercept what the glob loader stores, so a page re-rendered by the dev
    // watcher gets the rewrite too, not just the first load.
    const store = new Proxy(ctx.store, {
      get(target, prop, receiver) {
        if (prop !== 'set') return Reflect.get(target, prop, receiver)
        return (entry: Parameters<typeof target.set>[0]) => {
          if (entry.rendered?.html) {
            entry = { ...entry, rendered: { ...entry.rendered, html: rewriteHtmlLinks(entry.rendered.html, `docs/${entry.id}.md`) } }
          }
          return target.set(entry)
        }
      },
    })
    await docsGlob.load({ ...ctx, store })

    const sync = async () => {
      for (const p of externalPages()) {
        const body = `> Rendered from ${p.source}. Edit it there.\n\n${p.body}`
        const data = await ctx.parseData({
          id: p.id,
          data: { title: p.title, status: 'living', area: p.area, order: p.order },
        })
        ctx.store.set({
          id: p.id,
          data,
          body,
          digest: ctx.generateDigest(body),
          rendered: await ctx.renderMarkdown(body),
        })
      }
    }
    await sync()

    const watched = [join(ROOT, 'CLAUDE.md'), ...EXTERNAL_DOCS.map((d) => join(ROOT, d.path))]
    for (const f of watched) ctx.watcher?.add(f)
    ctx.watcher?.on('change', (f) => {
      if (watched.some((w) => resolve(w) === resolve(f))) void sync()
    })
  },
}

export const collections = {
  docs: defineCollection({
    loader,
    // status, area and order are ours; Starlight's schema is strict without `extend`.
    schema: docsSchema({
      extend: z.object({
        status: z.enum(['living', 'plan', 'record', 'closed']),
        area: z.string(),
        order: z.number().optional(),
      }),
    }),
  }),
}

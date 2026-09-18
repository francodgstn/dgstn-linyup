import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

// PUBLIC product documentation — docs.linyup.com. The opposite of apps/docs
// (internal, never deployed): everything under src/content/docs/ is meant to be
// read by studios and integrators. Never import or link from the repo's docs/.
//
// Pages with `draft: true` in their frontmatter are outlines: they show in
// `pnpm dev:help` and are left out of `astro build`, so an unfinished page can
// never reach the public site.

export default defineConfig({
  site: 'https://docs.linyup.com',
  output: 'static',
  integrations: [
    starlight({
      title: 'Linyup Docs',
      description: 'How to run your studio on Linyup — setup, pricing, scheduling, and the developer API.',
      // English only for now, at the root. Adding de/fr/it later is additive:
      // `locales: { root: { label: 'English', lang: 'en' }, de: {...}, ... }`
      // puts them under /de/ etc. and leaves every English URL where it is.
      locales: { root: { label: 'English', lang: 'en' } },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Getting started', items: [{ autogenerate: { directory: 'getting-started' } }] },
        { label: 'Running your studio', items: [{ autogenerate: { directory: 'studio' } }] },
        { label: 'For coaches', items: [{ autogenerate: { directory: 'coaches' } }] },
        { label: 'Developers', items: [{ autogenerate: { directory: 'developers' } }] },
        'faq',
      ],
    }),
  ],
  vite: {
    server: {
      // Same fix as apps/docs: Vite's watcher otherwise crawls the ~16 nested
      // monorepo copies under .claude/worktrees/ and the dev server never binds.
      watch: { ignored: ['**/.claude/worktrees/**'] },
    },
  },
})

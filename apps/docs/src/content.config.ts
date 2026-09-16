import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

// SINGLE SOURCE OF TRUTH: the loader is based on the repo's own docs/ tree.
// No copy, no symlink — a second copy is a second thing to go stale, and the
// ~616 bare `docs/x.md` paths in .ts comments point at the real files.
export const collections = {
  docs: defineCollection({
    // README.md files are entry points (the generated index, the folder
    // banners), not documents — they carry no frontmatter by design.
    loader: glob({ pattern: ['**/*.md', '!**/README.md'], base: '../../docs' }),
    // status and area are ours; Starlight's schema is strict without `extend`.
    schema: docsSchema({
      extend: z.object({
        status: z.enum(['living', 'plan', 'record', 'closed']),
        area: z.string(),
      }),
    }),
  }),
}

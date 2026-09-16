#!/usr/bin/env node
/**
 * One-time, idempotent: give every docs/*.md a frontmatter block.
 *
 * Re-runnable by design — it never overwrites a field a human has set, so it
 * can be run again after new docs land and only fill what is missing.
 *
 * WHAT IT DERIVES: `title` from the first H1 (51 of 54 files have one within
 * five lines; the three that do not are in docs/archive/, which open with the
 * CLOSED banner instead, and are listed in TITLE_OVERRIDES).
 *
 * WHAT IT CANNOT DERIVE: `area` and, for most files, `status`. Both are
 * judgement, so both are stated in the tables below rather than guessed from
 * the filename — a wrong `status` is exactly the failure docs/archive/README.md
 * describes: "a reader finds a plan written in the imperative, cannot tell it
 * was completed months ago, and funds work that was already done."
 *
 * The prose status banners already in twelve files are NOT touched. An agent
 * grepping into the middle of a 130 KB file never sees frontmatter; it needs
 * the banner. Frontmatter carries the enum, the banner carries the sentence.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, AREAS, STATUSES } from './lib/docsMeta.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const DOCS = join(ROOT, 'docs')

/** area per doc. Anything unlisted falls back to 'platform' and is reported. */
const AREA = {
  'accounting.md': 'payments', 'automations-money-triggers.md': 'payments',
  'finance-accrual.md': 'payments', 'finance-reports.md': 'payments',
  'multi-plan-holdings.md': 'payments', 'payment-contact-studio.md': 'payments',
  'payment-studio-linyup.md': 'payments', 'promo-codes.md': 'payments',
  'stripe-catalog.md': 'payments', 'tarif-595.md': 'payments',
  'appointments.md': 'booking', 'embed-booking.md': 'booking',
  'event-program.md': 'booking', 'waitlist.md': 'booking', 'waivers.md': 'booking',
  'contact-summary.md': 'contacts', 'org-contact-visibility.md': 'contacts',
  'rank-scale-decoupling.md': 'contacts', 'studio-independent-contacts.md': 'contacts',
  'site-translations.md': 'content',
  'app-check-rollout.md': 'platform', 'custom-domains.md': 'platform',
  'email-inbound.md': 'platform', 'org-navigation.md': 'platform',
  'plugins.md': 'platform', 'public-api.md': 'platform',
  'scalability-2026-09.md': 'platform', 'security-audit-2026-07.md': 'platform',
  'app-store-insights.md': 'mobile', 'mobile-eas-setup.md': 'mobile',
  'mobile-roadmap-2026-09.md': 'mobile', 'mobile-store-setup.md': 'mobile',
  'migration-checklist.md': 'ops', 'seed-truth-2026-08.md': 'ops',
  'test-accounts.md': 'ops',
  'fareharbor-analysis.md': 'product', 'in-app-feedback.md': 'product',
  'open-defects.md': 'product', 'product-strategy.md': 'product',
  'ux-review-open-decisions.md': 'product',
}

/** status where it is not `living`. archive/ is forced to `closed` below. */
const STATUS = {
  'finance-accrual.md': 'plan', 'rank-scale-decoupling.md': 'plan',
  'multi-plan-holdings.md': 'plan',
  'security-audit-2026-07.md': 'record', 'seed-truth-2026-08.md': 'record',
  'scalability-2026-09.md': 'record', 'mobile-roadmap-2026-09.md': 'record',
  'fareharbor-analysis.md': 'record',
}

const TITLE_OVERRIDES = {
  'archive/wave3-handover.md': 'Wave 3 — branch handover',
  'archive/ux-review-2026-08.md': 'UX review, August 2026',
  'archive/seed-alignment-plan.md': 'Seed alignment — Phase 1 audit',
}

const walk = (d, out = []) => {
  for (const e of readdirSync(d)) {
    const f = join(d, e)
    if (statSync(f).isDirectory()) walk(f, out)
    else if (e.endsWith('.md')) out.push(relative(DOCS, f).replaceAll('\\', '/'))
  }
  return out
}

const q = (s) => (/[:#"'{}[\],&*?|<>=!%@`]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)

let wrote = 0, skipped = 0
const unmapped = []

for (const rel of walk(DOCS).sort()) {
  if (rel === 'README.md' || rel.endsWith('/README.md')) { skipped++; continue }
  const abs = join(DOCS, rel)
  const src = readFileSync(abs, 'utf8')
  const { data } = parseFrontmatter(src)
  if (data && data.title && data.status && data.area) { skipped++; continue }

  const base = rel.split('/').pop()
  const h1 = /^#\s+(.+)$/m.exec(src.split('\n').slice(0, 6).join('\n'))
  const title = data?.title ?? TITLE_OVERRIDES[rel] ?? h1?.[1]?.trim()
  if (!title) { console.error(`  no title derivable: docs/${rel}`); continue }

  const status = data?.status ?? (rel.startsWith('archive/') ? 'closed' : (STATUS[base] ?? 'living'))
  let area = data?.area ?? AREA[base]
  if (!area) { area = rel.startsWith('launch/') || rel.startsWith('archive/') ? 'ops' : 'platform'; unmapped.push(rel) }

  if (!STATUSES.includes(status)) throw new Error(`bad status ${status} for ${rel}`)
  if (!AREAS.includes(area)) throw new Error(`bad area ${area} for ${rel}`)

  const block = ['---', `title: ${q(title)}`, `status: ${status}`, `area: ${area}`, '---', ''].join('\n')
  const body = data ? src.slice(src.indexOf('\n---', 3) + 5).replace(/^\n/, '') : src
  writeFileSync(abs, block + body)
  wrote++
}

console.log(`docs-frontmatter: wrote ${wrote}, left ${skipped} alone`)
if (unmapped.length) {
  console.log('  fell back on area (add to AREA if wrong):')
  for (const u of unmapped) console.log(`    docs/${u}`)
}

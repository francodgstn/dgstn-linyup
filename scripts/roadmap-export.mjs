#!/usr/bin/env node
/**
 * Exports the PUBLIC slice of the roadmap board into the landing site.
 *
 *   board (GitHub project francodgstn #2, private)
 *     └─ In progress + Next cards ──▶ apps/landing/src/data/roadmap.json ──▶ /roadmap page
 *
 * The board stays private; this file is the only thing that leaves it, and it
 * only ever leaves through a reviewed PR. Backlog and "In review" (undecided)
 * never leave, and neither does Done (that is what the feature pages are for).
 *
 * WHY THE OUTPUT IS DETERMINISTIC. The weekly routine opens a PR only when
 * `git diff` on this file is non-empty, so an unchanged board MUST reproduce the
 * file byte-for-byte. Two things make that true:
 *   - cards keep the board's order, keys are written in a fixed order, and
 *     there is no timestamp in the file;
 *   - a translation carries `srcHash`, the hash of the English title + body it
 *     was made from, and is kept verbatim while that hash still matches. Only a
 *     card whose English changed loses its translations — so nothing is
 *     re-translated (and re-worded) just because the routine ran again.
 *
 * Translations are not made here. A missing or stale one is left out and listed;
 * the caller writes them to a JSON file and passes it back with --translations:
 *
 *   { "<card id>": { "de": { "title": "…", "body": "…" }, "fr": {…}, "it": {…} } }
 *
 * The script stamps srcHash itself, so a translator never computes one.
 *
 * Usage:
 *   node scripts/roadmap-export.mjs                       # refresh from the board
 *   node scripts/roadmap-export.mjs --translations t.json # … and merge translations
 *   node scripts/roadmap-export.mjs --check               # exit 1 if any translation is missing
 *
 * Needs `gh` authenticated with the `project` scope.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'apps/landing/src/data/roadmap.json')
const OWNER = 'francodgstn'
const PROJECT = '2'
const LOCALES = ['de', 'fr', 'it']
// Board status → page section. Order here is the order on the page.
const SECTIONS = [
  ['In progress', 'inProgress'],
  ['Next', 'next'],
]

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const hash = (title, body) =>
  createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 12)

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Board bodies may end with a `Tracking: #411` line for Franco — never public. */
const publicBody = (body) =>
  (body ?? '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*tracking:/i.test(l))
    .join('\n')
    .trim()

function readBoard() {
  const raw = execFileSync(
    'gh',
    ['project', 'item-list', PROJECT, '--owner', OWNER, '--format', 'json', '--limit', '500'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  )
  return JSON.parse(raw).items
}

function readExisting() {
  if (!existsSync(OUT)) return new Map()
  const data = JSON.parse(readFileSync(OUT, 'utf8'))
  const byId = new Map()
  for (const cards of Object.values(data.sections ?? {})) for (const c of cards) byId.set(c.id, c)
  return byId
}

function build(board, existing, incoming) {
  const missing = []
  const sections = {}
  for (const [status, key] of SECTIONS) {
    sections[key] = board
      .filter((i) => i.status === status && i.content?.type === 'DraftIssue')
      .map((i) => {
        const id = i.content.id
        const title = i.content.title.trim()
        const body = publicBody(i.content.body)
        const srcHash = hash(title, body)
        const prev = existing.get(id)
        const card = { id, area: i.area ? { key: slug(i.area), label: i.area } : null, en: { title, body } }
        for (const l of LOCALES) {
          const given = incoming?.[id]?.[l]
          const kept = prev?.[l]
          if (given?.title && given?.body != null) {
            card[l] = { title: given.title.trim(), body: given.body.trim(), srcHash }
          } else if (kept && kept.srcHash === srcHash) {
            card[l] = { title: kept.title, body: kept.body, srcHash: kept.srcHash }
          } else {
            missing.push({ id, locale: l, en: { title, body } })
          }
        }
        return card
      })
  }
  return { sections, missing }
}

const board = readBoard()
const skipped = board.filter(
  (i) => SECTIONS.some(([s]) => s === i.status) && i.content?.type !== 'DraftIssue'
)
const incoming = opt('--translations')
  ? JSON.parse(readFileSync(opt('--translations'), 'utf8'))
  : undefined
const { sections, missing } = build(board, readExisting(), incoming)

const file = {
  _generated:
    'By scripts/roadmap-export.mjs from the roadmap board (In progress + Next). Do not edit by hand — change the board and re-export.',
  sections,
}
writeFileSync(OUT, JSON.stringify(file, null, 2) + '\n')

const count = Object.values(sections).reduce((n, s) => n + s.length, 0)
console.log(`roadmap.json: ${count} cards (${SECTIONS.map(([s, k]) => `${s} ${sections[k].length}`).join(', ')})`)
for (const i of skipped)
  console.warn(`skipped (not a draft item — never published): ${i.title}`)
if (missing.length) {
  // Grouped by card, in the exact shape --translations accepts.
  const todo = {}
  for (const m of missing) (todo[m.id] ??= { en: m.en, need: [] }).need.push(m.locale)
  console.log(`MISSING translations for ${Object.keys(todo).length} card(s):`)
  console.log(JSON.stringify(todo, null, 2))
  if (flag('--check')) process.exit(1)
} else {
  console.log('translations: complete')
}

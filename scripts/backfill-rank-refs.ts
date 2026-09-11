/**
 * THE PHASE 2 DATA FLIP — every stored rank NUMBER becomes the level's ID.
 * docs/rank-scale-decoupling.md, run on YOUR timing against the mobile release.
 *
 *   pnpm backfill:rank-refs --target staging --dry-run
 *   pnpm backfill:rank-refs --target staging
 *
 * ── WHAT IT CONVERTS ────────────────────────────────────────────────────────
 *
 *   Contact.ranks[systemId]                 the belt held
 *   checkins.checkin_data.disciplines[sys]  the graded level on an exam
 *   teams/{id}/contact_filters/{id}               saved presets: rankFilter mirrors and
 *                                           rankRanges bounds
 *   teams/{id}/contact_groups/{id}.rule           dynamic group rules, same two fields
 *   organizations/{id}/rank_progressions/{id}     bands a HUMAN edited (`updated_by`
 *                                           set), which the seed reconciler
 *                                           refuses to touch by design
 *
 * A number is resolved by `value` against the EFFECTIVE ladder of the record's
 * tenant and rewritten as that level's `id`. A number the ladder does not carry
 * is left as it is and counted — it was already an orphan, and turning it into
 * nothing would hide that. A ref that is already a string is never touched, so
 * the script is re-runnable.
 *
 * NOT converted, deliberately: event-category `min_rank`/`max_rank` (the cup
 * plugin). Those are numbers by schema and every reader resolves them by value
 * on the ladder; they convert when `value` is dropped in Phase 4, not before.
 *
 * ── PRECONDITIONS IT CHECKS ─────────────────────────────────────────────────
 *
 *   1. Every effective ranking system carries level ids (Phase 1 backfill ran).
 *      Refuses otherwise — converting against an id-less ladder writes nothing
 *      useful and there is no way back.
 *   2. `snapshot:ranks` has been applied: a sample of ranked contacts carries
 *      `ranks_legacy`. WARNS rather than refuses, because a fresh migration
 *      writes ids directly and never needed the snapshot.
 *
 * ── WHY THE MOBILE TIMING MATTERS ───────────────────────────────────────────
 *
 * An installed member app resolves the belt by matching `ranks[systemId]`
 * against `levels[].value`. After this runs those records hold ids, and that
 * app shows NO BELT until it updates to a build that resolves ids (any build
 * carrying @linyup/shared from Phase 2 on). Run it after that build is in the
 * stores, not before.
 */
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { effectiveRankingSystems, findRankLevel, rankLevelKey } from '@linyup/shared'
import type { RankingSystem, RankRef } from '@linyup/shared'

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
})

const TARGETS: Record<string, { projectId: string; emulator: boolean }> = {
  emulator: { projectId: 'demo-linyup', emulator: true },
  staging: { projectId: 'linyup-staging', emulator: false },
  production: { projectId: 'linyup-prod', emulator: false },
}
const target = TARGETS[values.target ?? '']
if (!target) {
  console.error(`❌ --target must be one of: ${Object.keys(TARGETS).join(' | ')}`)
  process.exit(1)
}
if (target.emulator) {
  const slot = Number(process.env.LINYUP_SLOT ?? 0) || 0
  process.env.FIRESTORE_EMULATOR_HOST ??= `localhost:${8080 + slot * 10000}`
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('❌ Refusing to run against a cloud project with FIRESTORE_EMULATOR_HOST set.')
  process.exit(1)
}
admin.initializeApp(
  target.emulator
    ? { projectId: target.projectId }
    : { credential: applicationDefault(), projectId: target.projectId },
)
const db = admin.firestore()
const dryRun = values['dry-run'] ?? false

const stats = {
  contacts: 0, contactsConverted: 0, contactsOrphans: 0,
  checkins: 0, checkinsConverted: 0, checkinsOrphans: 0,
  filters: 0, filtersConverted: 0,
  groups: 0, groupsConverted: 0,
  progressions: 0, progressionsConverted: 0,
}

/** A number → the level's id on `ladder`; a string, or an unknown number, unchanged. */
function convert(ladder: RankingSystem[] | undefined, systemId: string, ref: RankRef): { ref: RankRef; changed: boolean; orphan: boolean } {
  if (typeof ref !== 'number') return { ref, changed: false, orphan: false }
  const level = findRankLevel(ladder?.find((s) => s.id === systemId)?.levels, ref)
  if (!level || !level.id) return { ref, changed: false, orphan: true }
  return { ref: rankLevelKey(level), changed: true, orphan: false }
}

function convertMap(ladder: RankingSystem[] | undefined, map: Record<string, RankRef>): { map: Record<string, RankRef>; changed: boolean; orphans: number } {
  const out: Record<string, RankRef> = {}
  let changed = false
  let orphans = 0
  for (const [systemId, ref] of Object.entries(map)) {
    const c = convert(ladder, systemId, ref)
    out[systemId] = c.ref
    changed ||= c.changed
    if (c.orphan) orphans++
  }
  return { map: out, changed, orphans }
}

/** rankFilter / rankRanges on a filter-shaped object; returns the patch or null. */
function convertFilter(ladder: RankingSystem[] | undefined, f: Record<string, unknown>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  const rf = f.rankFilter as Record<string, RankRef[]> | null | undefined
  if (rf && typeof rf === 'object') {
    let changed = false
    const next: Record<string, RankRef[]> = {}
    for (const [systemId, refs] of Object.entries(rf)) {
      next[systemId] = (refs ?? []).map((r) => { const c = convert(ladder, systemId, r); changed ||= c.changed; return c.ref })
    }
    if (changed) patch.rankFilter = next
  }
  const rr = f.rankRanges as Record<string, { min: RankRef | null; max: RankRef | null }> | null | undefined
  if (rr && typeof rr === 'object') {
    let changed = false
    const next: Record<string, { min: RankRef | null; max: RankRef | null }> = {}
    for (const [systemId, range] of Object.entries(rr)) {
      const lo = range?.min == null ? null : convert(ladder, systemId, range.min)
      const hi = range?.max == null ? null : convert(ladder, systemId, range.max)
      changed ||= !!(lo?.changed || hi?.changed)
      next[systemId] = { min: lo ? lo.ref : null, max: hi ? hi.ref : null }
    }
    if (changed) patch.rankRanges = next
  }
  return Object.keys(patch).length ? patch : null
}

async function main() {
  console.log(`Rank ref backfill — ${target.projectId}${dryRun ? ' (dry run)' : ''}`)

  // ── ladders, and precondition 1 ────────────────────────────────────────────
  const orgSystems = new Map<string, RankingSystem[]>()
  for (const doc of (await db.collection('organizations').get()).docs) {
    orgSystems.set(doc.id, (doc.data().ranking_systems as RankingSystem[] | undefined) ?? [])
  }
  const teamLadder = new Map<string, RankingSystem[]>()
  const teamOrg = new Map<string, string | undefined>()
  const idless: string[] = []
  for (const doc of (await db.collection('teams').get()).docs) {
    const data = doc.data()
    const orgId = data.org_id as string | undefined
    const eff = effectiveRankingSystems(data.ranking_systems as RankingSystem[] | undefined, orgId ? orgSystems.get(orgId) : [])
    teamLadder.set(doc.id, eff)
    teamOrg.set(doc.id, orgId)
    for (const s of eff) if ((s.levels ?? []).some((l) => !l.id)) idless.push(`${doc.id}/${s.id}`)
  }
  if (idless.length) {
    console.error(`❌ ${idless.length} ranking system(s) still have levels without ids — run backfill:rank-level-ids first:\n   ${idless.slice(0, 10).join('\n   ')}`)
    process.exit(1)
  }

  if (!dryRun && !values.yes && !target.emulator) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\nType '${target.projectId}' to write: `)
    rl.close()
    if (answer.trim() !== target.projectId) { console.error('Aborted.'); process.exit(1) }
  }

  let batch = db.batch()
  let ops = 0
  const write = async (ref: FirebaseFirestore.DocumentReference, patch: Record<string, unknown>) => {
    if (dryRun) return
    batch.set(ref, patch, { merge: true })
    if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0 }
  }

  // ── contacts, and precondition 2 ───────────────────────────────────────────
  let ranked = 0
  let snapshotted = 0
  for (const doc of (await db.collection('contacts').get()).docs) {
    const data = doc.data()
    const ranks = data.ranks as Record<string, RankRef> | undefined
    if (!ranks || !Object.keys(ranks).length) continue
    stats.contacts++
    ranked++
    if (data.ranks_legacy) snapshotted++
    const ladder = teamLadder.get(data.teamId as string)
    const c = convertMap(ladder, ranks)
    stats.contactsOrphans += c.orphans
    if (!c.changed) continue
    stats.contactsConverted++
    await write(doc.ref, { ranks: c.map })
  }
  if (ranked > 0 && snapshotted / ranked < 0.5) {
    console.warn(`⚠ only ${snapshotted} of ${ranked} ranked contacts carry ranks_legacy — snapshot:ranks may not have run. Safe for a fresh migration (it writes ids directly); NOT safe if these numbers are the only record of the old belts.`)
  }

  // ── exam check-ins ─────────────────────────────────────────────────────────
  for (const doc of (await db.collection('checkins').get()).docs) {
    const data = doc.data()
    const disc = (data.checkin_data as { disciplines?: Record<string, RankRef> } | undefined)?.disciplines
    if (!disc || !Object.keys(disc).length) continue
    stats.checkins++
    const teamId = (data.teamId as string | undefined) ?? (data.team as { id?: string } | undefined)?.id
    const ladder = teamId ? teamLadder.get(teamId) : undefined
    const c = convertMap(ladder, disc)
    stats.checkinsOrphans += c.orphans
    if (!c.changed) continue
    stats.checkinsConverted++
    await write(doc.ref, { checkin_data: { disciplines: c.map } })
  }

  // ── saved filters and dynamic group rules, per team ────────────────────────
  for (const [teamId, ladder] of teamLadder) {
    const filters = await db.collection('teams').doc(teamId).collection('contact_filters').get()
    for (const doc of filters.docs) {
      const f = doc.data().filter as Record<string, unknown> | undefined
      if (!f) continue
      stats.filters++
      const patch = convertFilter(ladder, f)
      if (!patch) continue
      stats.filtersConverted++
      await write(doc.ref, { filter: { ...f, ...patch } })
    }
    const groups = await db.collection('teams').doc(teamId).collection('contact_groups').get()
    for (const doc of groups.docs) {
      const rule = doc.data().rule as Record<string, unknown> | undefined
      if (!rule) continue
      stats.groups++
      const patch = convertFilter(ladder, rule)
      if (!patch) continue
      stats.groupsConverted++
      await write(doc.ref, { rule: { ...rule, ...patch } })
    }
  }

  // ── human-edited progressions ──────────────────────────────────────────────
  for (const [orgId, systems] of orgSystems) {
    const progs = await db.collection('organizations').doc(orgId).collection('rank_progressions').get()
    for (const doc of progs.docs) {
      const data = doc.data()
      if (!data.updated_by) continue // the seed reconciler re-seeds these itself
      stats.progressions++
      const rules = (data.rules as Array<{ from: RankRef; to: RankRef }> | undefined) ?? []
      let changed = false
      const next = rules.map((r) => {
        const lo = convert(systems, doc.id, r.from)
        const hi = convert(systems, doc.id, r.to)
        changed ||= lo.changed || hi.changed
        return { ...r, from: lo.ref, to: hi.ref }
      })
      if (!changed) continue
      stats.progressionsConverted++
      console.log(`  organizations/${orgId}/rank_progressions/${doc.id}: human-edited bands converted`)
      await write(doc.ref, { rules: next })
    }
  }

  if (!dryRun && ops > 0) await batch.commit()
  const v = dryRun ? 'would convert' : 'converted'
  console.log(`\ncontacts        ${stats.contactsConverted}/${stats.contacts} ${v}, ${stats.contactsOrphans} orphan number(s) left as they are`)
  console.log(`exam check-ins  ${stats.checkinsConverted}/${stats.checkins} ${v}, ${stats.checkinsOrphans} orphan(s)`)
  console.log(`saved filters   ${stats.filtersConverted}/${stats.filters} ${v}`)
  console.log(`group rules     ${stats.groupsConverted}/${stats.groups} ${v}`)
  console.log(`edited bands    ${stats.progressionsConverted}/${stats.progressions} ${v}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

/**
 * THE DATA FLIP — every stored rank NUMBER becomes the level's ID.
 * docs/rank-scale-decoupling.md, run on YOUR timing against the mobile release.
 *
 *   pnpm backfill:rank-refs --target staging --dry-run
 *   pnpm backfill:rank-refs --target staging
 *   pnpm backfill:rank-refs --target staging --strip-values    # Phase 4b, see below
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
 *   events/{id}/categories/{id}             a cup category's min_rank / max_rank
 *                                           on its ranking_system_id (Phase 4)
 *
 * A number is resolved against the `value` the EFFECTIVE ladder of the
 * record's tenant still carries (`legacyRankValue` — `RankLevel` itself no
 * longer declares the field) and rewritten as that level's `id`. A number the
 * ladder does not carry is left as it is and counted — it was already an
 * orphan, and turning it into nothing would hide that. A ref that is already a
 * string is never touched, so the script is re-runnable.
 *
 * ── --strip-values: PHASE 4b, THE FIELD LEAVES THE LADDERS ─────────────────
 *
 * Once every record above holds an id, the `value` still sitting on each
 * ladder level is dead weight — and the one thing that would let a stray
 * number resolve again by accident. `--strip-values` removes it from every
 * `ranking_systems[].levels[]` on organisations and teams, and rewrites each
 * team's public mirror, AFTER the conversion in the same run. It REFUSES when
 * that run left any orphan number behind: with the values gone those records
 * could never be resolved, so they are fixed or accepted first. Run it once
 * per environment, after the flip; it is a no-op on a ladder that carries no
 * values. An installed member app that still writes numbers is unaffected —
 * it reads the mirror, and the mirror has resolved by id since Phase 2.
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
    'strip-values': { type: 'boolean', default: false },
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
  categories: 0, categoriesConverted: 0, categoriesOrphans: 0,
  laddersStripped: 0, mirrorsRefreshed: 0,
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
  // The precondition is checked on the STORED documents, before anything is
  // resolved through `effectiveRankingSystems` — which mints a missing id on
  // read (Phase 4) and would otherwise make this check pass on a ladder that
  // has never been backfilled. The org ladders are then normalised the same
  // way the team ladders are, so an org-scoped record (a cup event with no
  // team) resolves against levels that carry ids; before this, every bound on
  // staging's 971 categories came back an "orphan" for exactly that reason.
  const idless: string[] = []
  const idlessIn = (owner: string, systems: RankingSystem[]) => {
    for (const s of systems) if ((s.levels ?? []).some((l) => !l.id)) idless.push(`${owner}/${s.id}`)
  }
  const orgSystems = new Map<string, RankingSystem[]>()
  for (const doc of (await db.collection('organizations').get()).docs) {
    const raw = (doc.data().ranking_systems as RankingSystem[] | undefined) ?? []
    idlessIn(`organizations/${doc.id}`, raw)
    orgSystems.set(doc.id, effectiveRankingSystems(undefined, raw))
  }
  const teamLadder = new Map<string, RankingSystem[]>()
  const teamOrg = new Map<string, string | undefined>()
  for (const doc of (await db.collection('teams').get()).docs) {
    const data = doc.data()
    const orgId = data.org_id as string | undefined
    const own = (data.ranking_systems as RankingSystem[] | undefined) ?? []
    idlessIn(`teams/${doc.id}`, own)
    teamLadder.set(doc.id, effectiveRankingSystems(own, orgId ? orgSystems.get(orgId) : []))
    teamOrg.set(doc.id, orgId)
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

  // ── cup categories ─────────────────────────────────────────────────────────
  // `events/{id}/categories/{id}` — the root `categories` collection is
  // something else and is skipped by its parent. The ladder is the event's
  // tenant's: a team event resolves through its team, an org-scoped one
  // (teamId null) through the organisation's own systems.
  const eventLadder = new Map<string, RankingSystem[] | undefined>()
  for (const doc of (await db.collectionGroup('categories').get()).docs) {
    const eventRef = doc.ref.parent.parent
    if (!eventRef || eventRef.parent.id !== 'events') continue
    const data = doc.data()
    const systemId = data.ranking_system_id as string | undefined
    if (!systemId || (data.min_rank == null && data.max_rank == null)) continue
    stats.categories++
    if (!eventLadder.has(eventRef.id)) {
      const ev = (await eventRef.get()).data()
      const teamId = ev?.teamId as string | null | undefined
      const orgId = ev?.orgId as string | null | undefined
      eventLadder.set(eventRef.id, teamId ? teamLadder.get(teamId) : orgId ? orgSystems.get(orgId) : undefined)
    }
    const ladder = eventLadder.get(eventRef.id)
    const patch: Record<string, unknown> = {}
    for (const key of ['min_rank', 'max_rank'] as const) {
      const ref = data[key] as RankRef | undefined
      if (ref == null) continue
      const c = convert(ladder, systemId, ref)
      if (c.orphan) stats.categoriesOrphans++
      if (c.changed) patch[key] = c.ref
    }
    if (!Object.keys(patch).length) continue
    stats.categoriesConverted++
    await write(doc.ref, patch)
  }

  if (!dryRun && ops > 0) await batch.commit()

  // ── --strip-values ─────────────────────────────────────────────────────────
  if (values['strip-values']) {
    const remaining = stats.contactsOrphans + stats.checkinsOrphans + stats.categoriesOrphans
    if (remaining > 0) {
      console.error(`\n❌ --strip-values refused: ${remaining} record(s) still hold a number no level carries. Once the values are gone they could never be resolved — fix or accept them first.`)
      process.exit(1)
    }
    type StoredLevel = RankingSystem['levels'][number] & { value?: unknown }
    const carriesValues = (systems: RankingSystem[]) => systems.some((s) => (s.levels ?? []).some((l) => 'value' in (l as StoredLevel)))
    const strip = (systems: RankingSystem[]): RankingSystem[] =>
      systems.map((s) => ({ ...s, levels: (s.levels ?? []).map((l) => { const { value: _gone, ...rest } = l as StoredLevel; return rest }) }))
    const stripped = new Map<string, RankingSystem[]>()
    for (const doc of (await db.collection('organizations').get()).docs) {
      const systems = (doc.data().ranking_systems as RankingSystem[] | undefined) ?? []
      if (!carriesValues(systems)) continue
      stats.laddersStripped++
      stripped.set(`org:${doc.id}`, strip(systems))
      if (!dryRun) await doc.ref.update({ ranking_systems: strip(systems) })
    }
    for (const doc of (await db.collection('teams').get()).docs) {
      const data = doc.data()
      const own = (data.ranking_systems as RankingSystem[] | undefined) ?? []
      const orgId = data.org_id as string | undefined
      const ownStripped = carriesValues(own) ? strip(own) : own
      if (carriesValues(own)) {
        stats.laddersStripped++
        if (!dryRun) await doc.ref.update({ ranking_systems: ownStripped })
      }
      const orgStripped = orgId ? (stripped.get(`org:${orgId}`) ?? orgSystems.get(orgId) ?? []) : []
      // The mirror the public pages and the member app read — rewritten whole,
      // through the one resolver, exactly as backfill:rank-level-ids does.
      const effective = effectiveRankingSystems(ownStripped, orgStripped)
      if (!effective.length) continue
      stats.mirrorsRefreshed++
      if (!dryRun) await db.collection('teams').doc(doc.id).collection('public_profile').doc(doc.id).set({ ranking_systems: effective }, { merge: true })
    }
  }

  const v = dryRun ? 'would convert' : 'converted'
  console.log(`\ncontacts        ${stats.contactsConverted}/${stats.contacts} ${v}, ${stats.contactsOrphans} orphan number(s) left as they are`)
  console.log(`exam check-ins  ${stats.checkinsConverted}/${stats.checkins} ${v}, ${stats.checkinsOrphans} orphan(s)`)
  console.log(`saved filters   ${stats.filtersConverted}/${stats.filters} ${v}`)
  console.log(`group rules     ${stats.groupsConverted}/${stats.groups} ${v}`)
  console.log(`edited bands    ${stats.progressionsConverted}/${stats.progressions} ${v}`)
  console.log(`cup categories  ${stats.categoriesConverted}/${stats.categories} ${v}, ${stats.categoriesOrphans} orphan bound(s)`)
  if (values['strip-values']) {
    console.log(`ladders         ${stats.laddersStripped} ${dryRun ? 'would lose' : 'lost'} their level values, ${stats.mirrorsRefreshed} public mirror(s) ${dryRun ? 'would be refreshed' : 'refreshed'}`)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

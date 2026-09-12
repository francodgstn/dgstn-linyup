/**
 * THE BELT REASSIGNMENT — Phase 6 of docs/rank-scale-decoupling.md, the one
 * step of HMD's scale change that is a claim about PEOPLE rather than an edit
 * to a ladder. Adding the two belts is a ladder edit (the migration writes
 * them; an existing org adds them in the ranking editor). Saying that today's
 * Yellow holders are now Yellow/Orange is a statement about what real people
 * have earned, and it wants the federation's decision attached to it.
 *
 *   pnpm backfill:rank-reassign --target staging --dry-run     # always allowed
 *   pnpm backfill:rank-reassign --target staging               # needs the decision
 *
 * ── THE DECISION IS DATA, AND IT GATES THE WRITE ─────────────────────────────
 *
 * `HMD_BELT_REASSIGNMENT` in scripts/migration/config.ts carries the old→new
 * map AND who at HMD confirmed it, when. This script refuses to write while
 * `decidedBy` / `decidedOn` are null: a dry run shows the holders the map
 * would move, and nothing else happens until the answer is recorded next to
 * the map — never guessed here.
 *
 * ── WHAT IT MOVES, on the org's teams only ──────────────────────────────────
 *
 *   Contact.ranks[system]                     the belt held
 *   checkins.checkin_data.disciplines[system] the graded level on an exam —
 *                                             the exam recorded the belt the
 *                                             federation now calls by the new
 *                                             name, so history moves with it
 *   teams/{id}/contact_filters + contact_groups.rule   rankFilter mirrors and
 *                                             rankRanges bounds
 *   organizations/{org}/rank_progressions     bands a HUMAN edited (`updated_by`)
 *   events/{id}/categories                    min_rank / max_rank on those systems
 *
 * A ref equal to a map SOURCE becomes the map TARGET; anything else is left as
 * it is. Every id in the map must exist on the org's ladder — the script refuses
 * otherwise, because a target that is not on the ladder would orphan everyone.
 *
 * ── AUDITABLE, AND ONE-TIME ─────────────────────────────────────────────────
 *
 * Each moved contact gets `ranks_reassigned[system] = { from, to, at, decided_by,
 * decided_on }`, and the run itself is recorded at
 * `organizations/{org}/rank_reassignments/{runId}` with the map, the decision
 * and the counts — which is also what makes it reversible: the inverse map is
 * right there. It is ONE-TIME by design: once applied, the old id is a real
 * belt again (a newcomer graded Yellow next month holds `yellow`), so a second
 * run with the same map would move people who never held the old belt. The
 * script refuses to apply a map that a recorded run already applied unless
 * `--again` says you mean it.
 *
 * Run `snapshot:ranks --apply` first: it captures each contact's belts by LABEL
 * under `ranks_legacy`, which is the record of what everybody held before any
 * of this. The script warns when most contacts lack it.
 */
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { createHash } from 'node:crypto'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { HMD_BELT_REASSIGNMENT, ORG_ID } from './migration/config'

type RankRef = string | number
interface Level { id?: string; label?: string }
interface System { id: string; levels?: Level[] }

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    again: { type: 'boolean', default: false },
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
const decision = HMD_BELT_REASSIGNMENT
const decided = !!decision.decidedBy && !!decision.decidedOn
const mapHash = createHash('sha1').update(JSON.stringify({ map: decision.map, systems: decision.systems })).digest('hex').slice(0, 12)

const stats = {
  contacts: 0, contactsMoved: 0,
  checkins: 0, checkinsMoved: 0,
  filters: 0, filtersMoved: 0,
  groups: 0, groupsMoved: 0,
  progressions: 0, progressionsMoved: 0,
  categories: 0, categoriesMoved: 0,
}

/** The ref after the map: a source id becomes its target; anything else is untouched. */
function remap(systemId: string, ref: RankRef | null | undefined): { ref: RankRef | null | undefined; moved: boolean } {
  if (typeof ref !== 'string' || !decision.systems.includes(systemId)) return { ref, moved: false }
  const to = decision.map[ref]
  return to ? { ref: to, moved: true } : { ref, moved: false }
}

function remapMap(map: Record<string, RankRef>): { map: Record<string, RankRef>; moved: Array<{ system: string; from: string; to: string }> } {
  const out: Record<string, RankRef> = {}
  const moved: Array<{ system: string; from: string; to: string }> = []
  for (const [systemId, ref] of Object.entries(map)) {
    const r = remap(systemId, ref)
    out[systemId] = r.ref as RankRef
    if (r.moved) moved.push({ system: systemId, from: ref as string, to: r.ref as string })
  }
  return { map: out, moved }
}

function remapFilter(f: Record<string, unknown>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  const rf = f.rankFilter as Record<string, RankRef[]> | null | undefined
  if (rf && typeof rf === 'object') {
    let moved = false
    const next: Record<string, RankRef[]> = {}
    for (const [systemId, refs] of Object.entries(rf)) {
      next[systemId] = (refs ?? []).map((r) => { const m = remap(systemId, r); moved ||= m.moved; return m.ref as RankRef })
    }
    if (moved) patch.rankFilter = next
  }
  const rr = f.rankRanges as Record<string, { min: RankRef | null; max: RankRef | null }> | null | undefined
  if (rr && typeof rr === 'object') {
    let moved = false
    const next: Record<string, { min: RankRef | null; max: RankRef | null }> = {}
    for (const [systemId, range] of Object.entries(rr)) {
      const lo = remap(systemId, range?.min)
      const hi = remap(systemId, range?.max)
      moved ||= lo.moved || hi.moved
      next[systemId] = { min: (lo.ref ?? null) as RankRef | null, max: (hi.ref ?? null) as RankRef | null }
    }
    if (moved) patch.rankRanges = next
  }
  return Object.keys(patch).length ? patch : null
}

async function main() {
  console.log(`Belt reassignment — ${target.projectId}${dryRun ? ' (dry run)' : ''}`)
  console.log(`  organisation ${ORG_ID}, systems ${decision.systems.join(', ')}`)
  for (const [from, to] of Object.entries(decision.map)) console.log(`  ${from} → ${to}`)
  console.log(
    decided
      ? `  decided by ${decision.decidedBy} on ${decision.decidedOn}`
      : `  NOT YET DECIDED — HMD_BELT_REASSIGNMENT.decidedBy / decidedOn are null; only a dry run is allowed`,
  )
  if (!Object.keys(decision.map).length) { console.error('❌ the map is empty — nothing to do'); process.exit(1) }
  if (!dryRun && !decided) { console.error('\n❌ Refusing to write: record who at HMD decided this, and when, in HMD_BELT_REASSIGNMENT first.'); process.exit(1) }

  // ── the ladder, and every id the map names on it ───────────────────────────
  const orgRef = db.collection('organizations').doc(ORG_ID)
  const orgSnap = await orgRef.get()
  if (!orgSnap.exists) { console.error(`❌ organizations/${ORG_ID} does not exist on ${target.projectId}`); process.exit(1) }
  const systems = ((orgSnap.data()?.ranking_systems as System[] | undefined) ?? []).filter((s) => decision.systems.includes(s.id))
  // The STORED ladder must carry ids — this script names levels by them and
  // writes them onto people. A ladder that predates Phase 1 is not "missing
  // Yellow"; it is missing every id, and the fix is the id backfill.
  const idless = systems.filter((s) => (s.levels ?? []).some((l) => !l.id)).map((s) => s.id)
  if (idless.length) {
    console.error(`❌ ${idless.join(', ')}: levels without ids on organizations/${ORG_ID} — run backfill:rank-level-ids --target ${values.target} first`)
    process.exit(1)
  }
  const labelOf = new Map<string, Map<string, string>>()
  for (const s of systems) {
    const ids = new Set((s.levels ?? []).map((l) => l.id).filter((id): id is string => !!id))
    labelOf.set(s.id, new Map((s.levels ?? []).filter((l) => l.id).map((l) => [l.id!, l.label ?? l.id!])))
    for (const [from, to] of Object.entries(decision.map)) {
      if (!ids.has(from)) { console.error(`❌ ${s.id}: the ladder has no level '${from}' to move from`); process.exit(1) }
      if (!ids.has(to)) { console.error(`❌ ${s.id}: the ladder has no level '${to}' to move to — add it in the ranking editor (or re-run the migration) first`); process.exit(1) }
    }
  }
  if (systems.length !== decision.systems.length) {
    console.error(`❌ expected the org to carry ${decision.systems.join(', ')}; found ${systems.map((s) => s.id).join(', ') || 'none'}`)
    process.exit(1)
  }

  // ── one-time guard ─────────────────────────────────────────────────────────
  const prior = await orgRef.collection('rank_reassignments').where('map_hash', '==', mapHash).limit(1).get()
  if (!prior.empty && !values.again) {
    const p = prior.docs[0].data()
    console.error(`\n❌ This exact map was already applied on ${target.projectId} (run ${prior.docs[0].id}, ${p.applied_at?.toDate?.()?.toISOString?.() ?? '?'}). A second pass would move people who were graded '${Object.keys(decision.map).join("', '")}' AFTER the change. Pass --again only if you mean that.`)
    process.exit(1)
  }

  // ── the org's teams ────────────────────────────────────────────────────────
  const teamIds = (await db.collection('teams').where('org_id', '==', ORG_ID).get()).docs.map((d) => d.id)
  if (!teamIds.length) { console.error(`❌ no teams belong to organizations/${ORG_ID}`); process.exit(1) }
  const teamSet = new Set(teamIds)

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
  const stamp = {
    at: admin.firestore.FieldValue.serverTimestamp(),
    decided_by: decision.decidedBy,
    decided_on: decision.decidedOn,
  }

  // ── contacts ───────────────────────────────────────────────────────────────
  let ranked = 0
  let snapshotted = 0
  const perLevel = new Map<string, number>()
  for (const teamId of teamIds) {
    for (const doc of (await db.collection('contacts').where('teamId', '==', teamId).get()).docs) {
      const data = doc.data()
      const ranks = data.ranks as Record<string, RankRef> | undefined
      if (!ranks || !Object.keys(ranks).length) continue
      stats.contacts++
      ranked++
      if (data.ranks_legacy) snapshotted++
      const r = remapMap(ranks)
      if (!r.moved.length) continue
      stats.contactsMoved++
      const audit: Record<string, unknown> = {}
      for (const m of r.moved) {
        perLevel.set(`${m.system}:${m.from}`, (perLevel.get(`${m.system}:${m.from}`) ?? 0) + 1)
        audit[m.system] = {
          from: m.from,
          from_label: labelOf.get(m.system)?.get(m.from) ?? null,
          to: m.to,
          to_label: labelOf.get(m.system)?.get(m.to) ?? null,
          ...stamp,
        }
      }
      await write(doc.ref, { ranks: r.map, ranks_reassigned: audit })
    }
  }
  if (ranked > 0 && snapshotted / ranked < 0.5) {
    console.warn(`⚠ only ${snapshotted} of ${ranked} ranked contacts carry ranks_legacy — run snapshot:ranks --apply first so what everybody held before the change is on record by label.`)
  }

  // ── exam check-ins ─────────────────────────────────────────────────────────
  for (const doc of (await db.collection('checkins').get()).docs) {
    const data = doc.data()
    const teamId = (data.teamId as string | undefined) ?? (data.team as { id?: string } | undefined)?.id
    if (!teamId || !teamSet.has(teamId)) continue
    const disc = (data.checkin_data as { disciplines?: Record<string, RankRef> } | undefined)?.disciplines
    if (!disc || !Object.keys(disc).length) continue
    stats.checkins++
    const r = remapMap(disc)
    if (!r.moved.length) continue
    stats.checkinsMoved++
    await write(doc.ref, { checkin_data: { disciplines: r.map } })
  }

  // ── saved filters and dynamic group rules ──────────────────────────────────
  for (const teamId of teamIds) {
    for (const doc of (await db.collection('teams').doc(teamId).collection('contact_filters').get()).docs) {
      const f = doc.data().filter as Record<string, unknown> | undefined
      if (!f) continue
      stats.filters++
      const patch = remapFilter(f)
      if (!patch) continue
      stats.filtersMoved++
      await write(doc.ref, { filter: { ...f, ...patch } })
    }
    for (const doc of (await db.collection('teams').doc(teamId).collection('contact_groups').get()).docs) {
      const rule = doc.data().rule as Record<string, unknown> | undefined
      if (!rule) continue
      stats.groups++
      const patch = remapFilter(rule)
      if (!patch) continue
      stats.groupsMoved++
      await write(doc.ref, { rule: { ...rule, ...patch } })
    }
  }

  // ── human-edited progressions ──────────────────────────────────────────────
  for (const doc of (await orgRef.collection('rank_progressions').get()).docs) {
    const data = doc.data()
    if (!data.updated_by) continue // seeded bands are the plugin's, re-seeded by it
    stats.progressions++
    const rules = (data.rules as Array<{ from: RankRef; to: RankRef }> | undefined) ?? []
    let moved = false
    const next = rules.map((r) => {
      const lo = remap(doc.id, r.from)
      const hi = remap(doc.id, r.to)
      moved ||= lo.moved || hi.moved
      return { ...r, from: lo.ref as RankRef, to: hi.ref as RankRef }
    })
    if (!moved) continue
    stats.progressionsMoved++
    await write(doc.ref, { rules: next })
  }

  // ── cup categories on the org's events ─────────────────────────────────────
  for (const doc of (await db.collectionGroup('categories').get()).docs) {
    const eventRef = doc.ref.parent.parent
    if (!eventRef || eventRef.parent.id !== 'events') continue
    const data = doc.data()
    const systemId = data.ranking_system_id as string | undefined
    if (!systemId || !decision.systems.includes(systemId)) continue
    if (data.min_rank == null && data.max_rank == null) continue
    const ev = (await eventRef.get()).data()
    const teamId = ev?.teamId as string | null | undefined
    const orgId = ev?.orgId as string | null | undefined
    if (!(teamId && teamSet.has(teamId)) && orgId !== ORG_ID) continue
    stats.categories++
    const patch: Record<string, unknown> = {}
    for (const key of ['min_rank', 'max_rank'] as const) {
      const m = remap(systemId, data[key] as RankRef | undefined)
      if (m.moved) patch[key] = m.ref
    }
    if (!Object.keys(patch).length) continue
    stats.categoriesMoved++
    await write(doc.ref, patch)
  }

  // ── the run record ─────────────────────────────────────────────────────────
  if (!dryRun) {
    const runRef = orgRef.collection('rank_reassignments').doc()
    batch.set(runRef, {
      map: decision.map,
      systems: decision.systems,
      map_hash: mapHash,
      decided_by: decision.decidedBy,
      decided_on: decision.decidedOn,
      applied_at: admin.firestore.FieldValue.serverTimestamp(),
      target: target.projectId,
      counts: { ...stats, per_level: Object.fromEntries(perLevel) },
    })
    ops++
    if (ops > 0) await batch.commit()
    console.log(`\nrun recorded at organizations/${ORG_ID}/rank_reassignments/${runRef.id}`)
  }

  const v = dryRun ? 'would move' : 'moved'
  console.log(`\ncontacts        ${stats.contactsMoved}/${stats.contacts} ${v}`)
  for (const [key, n] of perLevel) console.log(`                  ${key} → ${decision.map[key.split(':')[1]]}: ${n}`)
  console.log(`exam check-ins  ${stats.checkinsMoved}/${stats.checkins} ${v}`)
  console.log(`saved filters   ${stats.filtersMoved}/${stats.filters} ${v}`)
  console.log(`group rules     ${stats.groupsMoved}/${stats.groups} ${v}`)
  console.log(`edited bands    ${stats.progressionsMoved}/${stats.progressions} ${v}`)
  console.log(`cup categories  ${stats.categoriesMoved}/${stats.categories} ${v}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

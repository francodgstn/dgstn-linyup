import { createConnection } from 'node:net'
import type { App } from 'firebase-admin/app'
import { initializeApp, cert } from 'firebase-admin/app'
import type { CollectionReference, CollectionGroup, DocumentReference, Firestore } from 'firebase-admin/firestore'
import { getFirestore } from 'firebase-admin/firestore'
import type { Auth } from 'firebase-admin/auth'
import { getAuth } from 'firebase-admin/auth'

export const ORG_ID = 'hmd'
export const ORG_NAME = 'HMD'

/**
 * THE FEDERATION'S OTHER ADMINS — people who run HMD itself, beyond whoever
 * ran the migration (`--org-admin-email`, the org's `createdBy`).
 *
 * A standing fact about the organisation, not a property of a run: these people
 * are org admins whoever launches the import and however often it is re-run, so
 * it belongs here with the other HMD facts rather than on the command line
 * where it could be forgotten on the wave that matters.
 *
 * Resolved the same way the primary admin is — the TARGET's login first (see
 * migration/orgAdmin.ts) — and written idempotently: an existing `org_members`
 * row is never overwritten, so a role changed in the app survives a re-run.
 */
export const ADDITIONAL_ORG_ADMIN_EMAILS: string[] = [
  'mcmxc@hotmail.it', // Ardovini — studio owner AND an HMD org admin (Franco, 2026-09-11)
]

// Ranking system IDs used in dgstn-lineup
export const RANKING_HMD = 'hmd'   // Hwal Moo Do
export const RANKING_KD  = 'kd'    // Korean Dragon

// Belt levels — same scale for both HMD and KD disciplines (hardcoded in hmd-lineup)
const HMD_BELT_LEVELS = [
  { value:  0, label: 'No belt',       color: '#AAAAAA' },
  { value:  1, label: 'White',         color: '#DDDDDD' },
  { value:  2, label: 'Yellow',        color: '#FFDC00' },
  { value:  3, label: 'Orange',        color: '#FF851B' },
  { value:  4, label: 'Orange/Green',  color: '#FF851B', secondColor: '#1c9c2b' },
  { value:  5, label: 'Green',         color: '#1c9c2b' },
  { value:  6, label: 'Green/Blue',    color: '#1c9c2b', secondColor: '#0074D9' },
  { value:  7, label: 'Blue',          color: '#0074D9' },
  { value:  8, label: 'Blue/Red',      color: '#0074D9', secondColor: '#d41010' },
  { value:  9, label: 'Red',           color: '#d41010' },
  { value: 10, label: 'Red/Black',     color: '#d41010', secondColor: '#111111' },
  { value: 11, label: 'Black I Dan',   color: '#111111' },
  { value: 12, label: 'Black II Dan',  color: '#111111' },
  { value: 13, label: 'Black III Dan', color: '#111111' },
  { value: 14, label: 'Master',        color: '#111111' },
]

// Ranking systems to write to organizations/hmd — hardcoded because hmd-lineup
// never persisted these to Firestore; they lived only in the JS app config.
/**
 * The members the `hmd` plugin container is expected to materialize at
 * `organizations/hmd/installed_plugins/*`.
 *
 * A COPY of `PLUGIN_BUNDLES.hmd` (@linyup/shared), and deliberately so: the
 * migration scripts run under tsconfig.scripts.json, which cannot import the
 * shared package — the same reason the path constants above are re-declared.
 * It is used only to CHECK the reconciler's work, never to write anything, so
 * drifting out of date makes the migration warn about a member that no longer
 * exists rather than write a wrong document.
 */
export const EXPECTED_HMD_MODULES = ['hmd-fighting-cup', 'hmd-belts'] as const

/**
 * Source clubs the migration deliberately does NOT copy.
 *
 * By ID, not by name: "Test Team" is a name a real club could plausibly take,
 * and a name-matched exclusion would silently drop it. The id is exact and the
 * migration preserves ids, so the same constant answers for source and target.
 *
 * `jtTJcfqxDkvjfDQz9JTM` — "This is a dummy team to be used only for demo and
 * testing", per its own description. Franco's scratch club in hmd-lineup
 * (2026-09-05: "we can actually ignore completely that one"). It carried 3
 * contacts and 176 sessions of manual-test data into staging, which is noise in
 * every count anyone reads and a studio nobody can explain on the roster.
 *
 * An excluded club is skipped WHOLE — no team document, and therefore no
 * contacts, sessions or check-ins either, because every downstream pass is
 * scoped by the ids pass 2 returns.
 */
export const EXCLUDED_SOURCE_TEAMS: string[] = ['jtTJcfqxDkvjfDQz9JTM']

/**
 * Clubs whose classes are MEMBERS-ONLY: every plan the club has is linked to
 * every class, and `trialEnabled` is the public way in — "public booking is
 * done by enabling the trial, only trials can book free" (Franco, 2026-09-08).
 *
 * ── WHY THIS IS A LIST AND NOT THE DEFAULT ──────────────────────────────────
 * Because the gate is only as good as the plan data behind it. A club whose
 * members hold no plan, gated on plans, is a club where NOBODY CAN BOOK: the
 * canonical plans are seeded into every team, so `subscriptionTypeIds` would be
 * non-empty and every member would be refused `no_subscription` — with no
 * drop-in price to buy in through, and one trial per person as the only door.
 *
 * That is not hypothetical, and the counter-example is the instructive one: HMD
 * Team Ardovini has 6 activities, 129 contacts and 0 holding a plan. It looks
 * like a club ready to be gated and it is the opposite — Ardovini "was just
 * trying to set up the plans, but never really got it fully done" (Franco,
 * 2026-09-08). Activities without plan-holders is what a HALF-FINISHED setup
 * looks like, so the shape that most invites the gate is the one it would hurt.
 *
 * The other clubs barely used hmd-lineup at all, and that is expected to change
 * on Linyup rather than stay true. So the answer is not "never" — it is "when
 * the plans are real".
 *
 * So a club joins this list when its plans are real. Everything else keeps the
 * shape it had before: no `accessRule`, which reads as legacy `open`.
 */
export const PLAN_GATED_TEAMS: string[] = [
  'DVyzKM5DXAarcUuJ5SnXD5kIgT43', // HMD Basel
]

// `hmd-belts` joined the bundle on 2026-09-05 and this copy did not, which is
// the drift direction the comment above does NOT cover: an EXTRA member the
// list does not know about is not warned about — it is simply never checked, so
// the migration would have reported a healthy container while the belt ladder
// silently failed to materialise. A stale entry is loud; a missing one is not.

/**
 * hmd-lineup event type → Linyup event type.
 *
 * WHY THIS EXISTS AT ALL. `transformEvent` used to pass the source `type`
 * straight through, and hmd-lineup stores `'fighting_cup'`
 * (`src/utils/hmdLineUp.js`, its `eventTypes` list) while the Linyup plugin
 * declares `eventType.id = 'hmd_fighting_cup'`. Plugin resolution is an exact
 * match on that id, so every migrated cup resolved to NO plugin: no Categories
 * tab, no cup check-in form, no CSV export. It degraded quietly, because the
 * generic form renders and the completion predicate happens to sniff for a
 * `categories` key regardless of type — so the screen looked plausible and was
 * missing its whole reason for existing. It also stranded pass 9's
 * reconstructed categories in a tab that never renders.
 *
 * A REMAP, NOT A RUNTIME ALIAS. The alternative was to teach the app that the
 * two slugs mean one thing, which buys a permanent second spelling to keep in
 * step across every reader. Migrated data becomes ordinary Linyup data instead,
 * and the alias lives only here, only during the migration.
 *
 * NOT MAPPED, deliberately: `traditional_cup`. Linyup has no equivalent — it is
 * neither a built-in nor a plugin type — and collapsing it into `competition`
 * would silently merge two things HMD tells apart. It migrates unchanged and
 * renders as a plain custom type, which is honest and reversible; giving it a
 * home is a product decision, not a migration one.
 */
export const SOURCE_EVENT_TYPE_MAP: Record<string, string> = {
  fighting_cup: 'hmd_fighting_cup',
}

/**
 * The source's own "no type chosen" entry is the EMPTY STRING (its `eventTypes`
 * list ends `{ type: '', label: 'Event' }`), which `?? 'competition'` does not
 * catch — `'' ?? x` is `''`. An event typed `''` matches no built-in, no custom
 * type and no plugin, so it renders as a type-less row forever.
 */
export function mapSourceEventType(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return 'competition'
  return SOURCE_EVENT_TYPE_MAP[value] ?? value
}

export const HMD_ORG_RANKING_SYSTEMS = [
  { id: RANKING_HMD, name: 'Hwal Moo Do',    is_primary: true,  levels: HMD_BELT_LEVELS },
  { id: RANKING_KD,  name: 'Korean Dragon',  is_primary: false, levels: HMD_BELT_LEVELS },
]

/**
 * The level values a migrated rank may legitimately hold on a given ranking
 * system — derived from HMD_ORG_RANKING_SYSTEMS so the belt scale has ONE
 * definition here rather than a copy that can drift from what the migration
 * actually writes to organizations/hmd.
 *
 * Returns null for a system this migration does not create, which is a
 * different answer from "no such level" and is reported differently.
 *
 * Why it exists: a rank the scale does not contain still WRITES — the contact
 * simply renders a floor-matched belt, or none — so the only way anybody learns
 * about one is if the migration says so. See transforms/contacts.ts.
 */
const levelValueCache = new Map<string, Set<number>>()

export function rankingSystemLevelValues(systemId: string): Set<number> | null {
  const cached = levelValueCache.get(systemId)
  if (cached) return cached
  const system = HMD_ORG_RANKING_SYSTEMS.find((s) => s.id === systemId)
  if (!system) return null
  const values = new Set(system.levels.map((l) => l.value))
  levelValueCache.set(systemId, values)
  return values
}

/**
 * Does this club belong to the requested sample?
 *
 * Matches an id EXACTLY, or a name case-insensitively after collapsing
 * whitespace — HMD's club names are typed by people ("M  Marzella", "M
 * Marzella") and a sample selector that misses on a double space is a selector
 * nobody trusts. Absent selector ⇒ everything, so every existing invocation is
 * unchanged.
 *
 * Substring, not equality, on the name: "Basel" should find "HMD Basel" without
 * anyone having to reproduce the club's full registered name from memory.
 */
export function matchesTeamSample(
  sample: string[] | undefined,
  teamId: string,
  teamName: string
): boolean {
  if (!sample?.length) return true
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ')
  const name = norm(teamName)
  return sample.some((want) => {
    const w = norm(want)
    return teamId === want.trim() || name === w || name.includes(w)
  })
}

// WHICH emulator `--target-emulator` means.
//
// Slot 0's ports by default — the main checkout — plus `LINYUP_SLOT` for a
// worktree, which runs its own suite on every port + N x 10000 (see
// .claude/skills/local-env). These were hardcoded, so `--target-emulator` from a
// worktree reported the emulators as "not running" while that worktree's own
// suite sat there listening.
//
// ── AND IT IS DELIBERATELY *NOT* `FIRESTORE_EMULATOR_HOST` ──────────────────
// Every other script in the repo reads that variable, and this one must not:
// firebase-admin reads it too, globally, for every app. `initApps` depends on it
// being UNSET while the SOURCE app is created — the moment it is set, the source
// is the emulator as well, the migration reads an empty database, and it reports
// "0 clubs available" as though the customer's Firestore were empty. A silent
// wrong answer, reachable by following the documented `local-env env`
// incantation, which is why `initApps` now CLEARS the variables rather than
// trusting them to be absent.
const SLOT = Number(process.env.LINYUP_SLOT ?? 0) || 0
const slotPort = (base: number) => base + SLOT * 10000

export const EMULATOR_FIRESTORE_HOST = `localhost:${slotPort(8080)}`
export const EMULATOR_AUTH_HOST = `localhost:${slotPort(9099)}`
export const EMULATOR_PROJECT_ID     = 'demo-linyup'

export const DEFAULT_ORG_ADMIN_EMAIL = 'franco.dgstn@gmail.com'

export interface MigrationConfig {
  sourceCredsPath: string
  targetCredsPath?: string   // omitted when targetEmulator is true
  targetEmulator: boolean
  dryRun: boolean
  only?: string
  /**
   * Import only these clubs — by NAME (case-insensitive, trimmed) or by id.
   *
   * A full HMD run copies sixteen clubs and sixteen hundred contacts, which is
   * minutes of waiting for anyone changing a transform and wanting to see what
   * it did. Three clubs is the same shapes at a hundredth of the cost.
   *
   * It is a SAMPLE, and the difference matters when reading the result: an
   * unlisted club's contacts, sessions and check-ins are absent, so a
   * cross-club count will not tie out and `verify` compares only what was
   * asked for. Never use it for a real target.
   *
   * Absent ⇒ every club, which is the behaviour every existing invocation gets.
   */
  teams?: string[]
  /**
   * Re-apply the CURRENT transforms to documents that already exist on the
   * target, instead of skipping them.
   *
   * WHY IT EXISTS. Every pass is skip-if-exists, which makes the migration an
   * INSERT-MISSING tool rather than an APPLY-TRANSFORMS one. Re-running it over
   * a populated target therefore delivers none of the transform fixes shipped
   * since that target was first migrated — silently, because `verify` compares
   * COUNTS and the counts still match. That is how staging kept 23 events typed
   * `fighting_cup` (and 1947 check-ins stamped with it) through a full re-run
   * that reported "All counts OK".
   *
   * WHAT IT DOES NOT TOUCH, deliberately. Some documents stay guarded even under
   * --overwrite, because their target state is authored locally rather than
   * derived from the source, so re-writing them destroys work the source cannot
   * give back.
   *
   * THE CENSUS LIVES IN scripts/MIGRATE-HMD.md — "Re-running over a populated
   * target". It is not repeated here: two copies of one list disagree the moment
   * a guard is added, and these two already did (one said three, the other four,
   * for the same five documents). Each guarded pass also says so at the branch
   * that guards it, which is where a reader working in that file will look.
   *
   * It DOES overwrite migrated source documents — contacts, sessions'
   * subcollections, activities, series, events, check-ins, referrals, team
   * subcollections and places — so any edit made to one of those THROUGH THE APP
   * is replaced by the source's version. That is the point, and it is why this
   * is a flag rather than the default.
   */
  overwrite: boolean
  fromTeam?: string
  orgAdminEmail: string      // email of the user who becomes org creator + org_admin
  /**
   * THE ACTIVATION LIST — which clubs go live on this target, by name or id
   * (same matcher as `teams`). Everything is imported either way; this decides
   * who can act on it:
   *
   *   auth-users   imports only the members of a live club (plus the org
   *                admin). A dormant club's owner has no login on the target
   *                until their wave, so nothing they might edit can later be
   *                clobbered by that wave's `--overwrite` catch-up.
   *   activation   writes a messaging policy per club — `live` for these,
   *                `silent` for every other club, `live` for the org — so a
   *                seeded automation cannot email thirteen clubs' worth of
   *                people who have never heard of Linyup.
   *
   * REQUIRED for a full run into a real project. CUMULATIVE: each wave names
   * every club that is live by then, because `activation` sets the rest silent.
   */
  live?: string[]
}

// ─── read-only source type ────────────────────────────────────────────────────
// Exposes only the Firestore query surface — no batch, no runTransaction, no writes.
// This makes misuse a compile-time error and ensures no accidental writes to source.

export interface ReadonlyFirestore {
  collection(path: string): CollectionReference
  collectionGroup(id: string): CollectionGroup
  doc(path: string): DocumentReference
  getAll(...refs: DocumentReference[]): Promise<FirebaseFirestore.DocumentSnapshot[]>
}

const WRITE_METHODS = ['batch', 'bulkWriter', 'runTransaction', 'recursiveDelete'] as const

function asReadonly(db: Firestore): ReadonlyFirestore {
  return new Proxy(db, {
    get(target, prop) {
      if (WRITE_METHODS.includes(prop as typeof WRITE_METHODS[number])) {
        throw new Error(`[source] write operation '${String(prop)}' is not allowed on the source database`)
      }
      const value = target[prop as keyof Firestore]
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as ReadonlyFirestore
}

// ─── app init ─────────────────────────────────────────────────────────────────
// Auth and Firestore instances are cached eagerly at init time.
// Source instances MUST be obtained before emulator env vars are set — the
// Admin SDK reads those vars lazily (on first connection), so setting them
// first would silently route source reads to the local emulator.

let _sourceDb:   ReadonlyFirestore
let _targetDb:   Firestore
let _sourceAuth: Auth
let _targetAuth: Auth

export function initApps(cfg: MigrationConfig) {
  // 1. Init source app and immediately lock in its Firestore + Auth instances
  //    while emulator env vars are still unset.
  // THE SOURCE IS NEVER AN EMULATOR. firebase-admin resolves these variables
  // globally, so an ambient value — `local-env env` exports both, and it is the
  // documented way to point a script at a worktree's slot — would silently make
  // the customer's production database resolve to localhost. The migration then
  // reads nothing, and says so in the language of a successful run.
  //
  // Cleared here rather than merely "expected to be unset", because the comment
  // that expected it was true right up until somebody exported them.
  delete process.env.FIRESTORE_EMULATOR_HOST
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST

  const sourceApp = initializeApp({ credential: cert(cfg.sourceCredsPath) }, 'source')
  _sourceDb   = asReadonly(getFirestore(sourceApp))
  _sourceAuth = getAuth(sourceApp)

  // 2. Set emulator env vars, then init the target app.
  if (cfg.targetEmulator) {
    process.env.FIRESTORE_EMULATOR_HOST  = EMULATOR_FIRESTORE_HOST
    process.env.FIREBASE_AUTH_EMULATOR_HOST = EMULATOR_AUTH_HOST
    const targetApp = initializeApp({ projectId: EMULATOR_PROJECT_ID }, 'target')
    _targetDb   = getFirestore(targetApp)
    _targetAuth = getAuth(targetApp)
    console.log(`Target: emulator — Firestore ${EMULATOR_FIRESTORE_HOST}, Auth ${EMULATOR_AUTH_HOST}`)
  } else {
    const targetApp = initializeApp({ credential: cert(cfg.targetCredsPath!) }, 'target')
    _targetDb   = getFirestore(targetApp)
    _targetAuth = getAuth(targetApp)
  }

  // Silently drop undefined fields from source docs rather than throwing.
  _targetDb.settings({ ignoreUndefinedProperties: true })
}

export function sourceDb():   ReadonlyFirestore { return _sourceDb }
export function targetDb():   Firestore         { return _targetDb }
export function sourceAuth(): Auth              { return _sourceAuth }
export function targetAuth(): Auth              { return _targetAuth }

// ─── emulator preflight ─────────────────────────────────────────────────────────
// One-shot TCP probe so `--target-emulator` fails fast with a clear message when the
// emulators aren't running — instead of a confusing gRPC ECONNREFUSED mid-migration.

function probePort(hostPort: string, timeoutMs = 1500): Promise<boolean> {
  const [host, portStr] = hostPort.split(':')
  return new Promise((resolve) => {
    const sock = createConnection({ host, port: Number(portStr) })
    const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(timeoutMs, () => done(false))
  })
}

/** Exit with a helpful message if the local Firestore/Auth emulators aren't up. */
export async function assertTargetEmulatorReachable(): Promise<void> {
  const targets: [string, string][] = [
    ['Firestore', EMULATOR_FIRESTORE_HOST],
    ['Auth', EMULATOR_AUTH_HOST],
  ]
  const down = (await Promise.all(targets.map(([, hp]) => probePort(hp))))
    .map((ok, i) => (ok ? null : `${targets[i][0]} (${targets[i][1]})`))
    .filter((x): x is string => x !== null)

  if (down.length > 0) {
    console.error(
      `\n✖ Cannot reach the local emulator(s): ${down.join(', ')}.\n` +
        `  --target-emulator writes to the local Firebase emulators, but they don't appear\n` +
        `  to be running. Start them first in another terminal, then re-run:\n\n` +
        `    pnpm emulators:start\n`
    )
    process.exit(1)
  }
}

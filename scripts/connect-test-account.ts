/**
 * Wire a Stripe **test** connected account to a team for the "pay with Linyup"
 * (Stripe Connect, member → studio) flow — WITHOUT re-doing the hosted onboarding
 * every time.
 *
 * The friction this removes: the Connect onboarding (Settings → Payments) writes
 * two Firestore docs — teams/{teamId}.payments and connect_accounts/{acct} — that
 * are wiped on every emulator reseed / fresh team, even though the underlying
 * Stripe TEST account still exists and is already onboarded. This script re-writes
 * that wiring in one command, so you onboard ONCE and re-attach forever.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * One-time setup (do this once, in the browser):
 *   Open the studio → Settings → Payments → connect, and complete Stripe's TEST
 *   onboarding (test data: bank 000123456789 / routing 110000000, any test
 *   identity). Copy the account id (acct_…) Stripe shows, then reuse it below.
 *   Tip: export it so you can omit --account:  export STRIPE_CONNECT_TEST_ACCOUNT=acct_…
 *
 * Usage:
 *   # Don't know the acct_ id? List the ones on your Stripe test platform:
 *   pnpm connect:test-account --list
 *
 *   # Re-attach a known onboarded test account to a team (the common case):
 *   pnpm connect:test-account --team <teamId> --account acct_xxx --target emulator
 *
 *   # With STRIPE_CONNECT_TEST_ACCOUNT exported, --account is optional:
 *   pnpm connect:test-account --team <teamId> --target emulator
 *
 *   # Pull the REAL live status from Stripe instead of assuming 'enabled'
 *   # (needs STRIPE_SECRET_KEY; falls back to functions/.env.local):
 *   pnpm connect:test-account --team <teamId> --account acct_xxx --refresh --target emulator
 *
 *   # Clear a team's payments wiring (test the disconnected state):
 *   pnpm connect:test-account --team <teamId> --disable --target emulator
 *
 * Targets (mirrors seed-lead.ts): `--target emulator` (default) points at the
 * local emulators (demo-linyup); `--target staging` targets linyup-staging via
 * ADC. Production is refused.
 *
 * NOTE: a Stripe account maps to exactly ONE team (connect_accounts/{acct}.teamId
 * is what the webhook reads to route events). Attaching the same acct to a second
 * team steals the mapping from the first — use one test account per team, or
 * accept that only the most-recently-linked team receives its webhooks.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import {
  TEAMS_COLLECTION,
  CONNECT_ACCOUNTS_COLLECTION,
  type ConnectOnboardingModel,
} from '@linyup/shared'
import { linkConnectAccount, ASSUMED_ENABLED, type ConnectStatus } from './lib/connect'

// ── CLI ──────────────────────────────────────────────────────────────────────

const { values: cli } = parseArgs({
  options: {
    team: { type: 'string' },
    account: { type: 'string' },
    model: { type: 'string' }, // byo | managed (default managed)
    target: { type: 'string' }, // emulator (default) | staging
    refresh: { type: 'boolean', default: false }, // pull live status from Stripe
    disable: { type: 'boolean', default: false }, // clear the payments wiring
    list: { type: 'boolean', default: false }, // list this Stripe (test) account's acct_ ids
  },
})

// --list just queries Stripe (no team needed); everything else needs --team.
const TEAM_ID = cli.team ?? process.env.CONNECT_TEAM
if (!TEAM_ID && !cli.list) {
  console.error('❌ Missing --team <teamId>. Example: pnpm connect:test-account --team demo-studio --account acct_123 --target emulator')
  console.error("   (or run `pnpm connect:test-account --list` to see the acct_ ids in your Stripe test account)")
  process.exit(1)
}

const MODEL = (cli.model ?? 'managed') as ConnectOnboardingModel
if (!['byo', 'managed'].includes(MODEL)) {
  console.error(`❌ Invalid --model '${MODEL}'. Use 'byo' or 'managed'.`)
  process.exit(1)
}

// ── Target resolution (mirrors seed-lead.ts) ─────────────────────────────────
const TARGET = (cli.target ?? process.env.CONNECT_TARGET ?? 'emulator').toLowerCase()
if (!['emulator', 'emulators', 'staging'].includes(TARGET)) {
  console.error(`❌ Invalid --target '${TARGET}'. Use 'emulator' or 'staging'. (production is refused)`)
  process.exit(1)
}
if (TARGET === 'emulator' || TARGET === 'emulators') {
  process.env.FIRESTORE_EMULATOR_HOST ??= 'localhost:8080'
}
const USE_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST
const PROJECT_ID = USE_EMULATOR ? process.env.GCLOUD_PROJECT || 'demo-linyup' : 'linyup-staging'

// Guard: never touch a project other than the emulator or staging.
const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
if (!USE_EMULATOR && envProject && envProject !== PROJECT_ID) {
  console.error(`❌ Refusing to run: ambient project '${envProject}' != '${PROJECT_ID}'.`)
  process.exit(1)
}

admin.initializeApp(
  USE_EMULATOR ? { projectId: PROJECT_ID } : { credential: applicationDefault(), projectId: PROJECT_ID }
)
const db = admin.firestore()
db.settings({ ignoreUndefinedProperties: true })

// ── Stripe secret (only for --refresh) ───────────────────────────────────────
// Prefer the env var; else read STRIPE_SECRET_KEY from packages/functions/.env.local
// (the same file the Functions emulator loads).
function stripeSecret(): string | null {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY
  const envPath = path.resolve(__dirname, '../packages/functions/.env.local')
  try {
    const line = fs
      .readFileSync(envPath, 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('STRIPE_SECRET_KEY='))
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
  } catch {
    /* no .env.local — fall through */
  }
  return null
}

// Shared Stripe client from the test key (env or functions/.env.local). Returns
// null (with a warning) when the key or SDK can't be loaded.
// THE TYPE IS DERIVED FROM THE LOADER, not written out. `stripe` uses
// `export =`, so `typeof import('stripe').default` is not a type this tsconfig
// can resolve, while the same `.default` on the VALUE side is synthesized by
// esModuleInterop and works at runtime. Writing the shape a second time is what
// let the two disagree; deriving it from the expression the runtime actually
// evaluates means they cannot.
//
// It went unnoticed because `scripts/` was typechecked against a hand-maintained
// list that did not name this file — fixed in the same change (tsconfig.seedcheck
// .json now globs).
async function loadStripeCtor() {
  return (await import('stripe')).default
}
type StripeClient = InstanceType<Awaited<ReturnType<typeof loadStripeCtor>>>

async function getStripeClient(): Promise<StripeClient | null> {
  const key = stripeSecret()
  if (!key) {
    console.warn('⚠️  No Stripe test key found (STRIPE_SECRET_KEY or packages/functions/.env.local).')
    return null
  }
  try {
    const Stripe = await loadStripeCtor()
    return new Stripe(key)
  } catch {
    console.warn("⚠️  Couldn't load the 'stripe' SDK from here.")
    return null
  }
}

// List the connected accounts on this Stripe (test) platform, so you can grab the
// acct_ id to pass to --account. Reads Stripe directly (survives emulator reseeds).
async function listAccounts(): Promise<void> {
  const stripe = await getStripeClient()
  if (!stripe) {
    console.error('❌ Need a Stripe test key to list accounts. Set STRIPE_SECRET_KEY or add it to packages/functions/.env.local.')
    process.exit(1)
  }
  // v2 list caps `limit` at 20 per page; ApiListPromise auto-paginates via `for await`.
  const accounts: Array<{ id: string; display_name?: string | null; metadata?: Record<string, string> | null }> = []
  for await (const a of stripe.v2.core.accounts.list({ limit: 20 })) {
    accounts.push(a as (typeof accounts)[number])
    if (accounts.length >= 200) break // safety cap
  }
  if (!accounts.length) {
    console.log('No connected accounts yet on this Stripe test platform.')
    console.log('→ Onboard one once: open the studio → Settings → Payments → connect, complete Stripe TEST onboarding.')
    return
  }
  console.log(`Connected accounts (Stripe TEST mode) — copy an acct_ id:\n`)
  for (const a of accounts) {
    const team = a.metadata?.teamId ? `  teamId=${a.metadata.teamId}` : ''
    console.log(`  ${a.id}   ${a.display_name ?? '(no name)'}${team}`)
  }
  console.log('\nThen link it:')
  console.log('  pnpm connect:test-account --team <teamId> --account <acct_…> --target emulator')
}

// Derive the flat, chargeable status from a v2 account (mirrors normalizeAccount
// in packages/functions/src/utils/connect/client.ts — kept minimal here).
async function fetchLiveStatus(accountId: string): Promise<ConnectStatus | null> {
  const stripe = await getStripeClient()
  if (!stripe) {
    console.warn('⚠️  --refresh needs a Stripe test key — assuming enabled.')
    return null
  }
  try {
    const account = (await stripe.v2.core.accounts.retrieve(accountId, {
      include: ['configuration.merchant', 'requirements'],
    })) as unknown as {
      closed?: boolean
      configuration?: { merchant?: { capabilities?: Record<string, { status?: string } | undefined> } }
      requirements?: { entries?: Array<{ awaiting_action_from?: string; description?: string; minimum_deadline?: { status?: string } }> }
    }
    const caps: Record<string, string> = {}
    for (const [name, cap] of Object.entries(account.configuration?.merchant?.capabilities ?? {})) {
      if (cap && typeof cap.status === 'string') caps[name] = cap.status
    }
    const due: string[] = []
    for (const e of account.requirements?.entries ?? []) {
      const s = e.minimum_deadline?.status
      if (e.awaiting_action_from === 'user' && (s === 'currently_due' || s === 'past_due') && e.description) due.push(e.description)
    }
    const cardActive = caps['card_payments'] === 'active'
    const payouts = cardActive && due.length === 0
    const status = account.closed ? 'rejected' : cardActive && payouts ? 'enabled' : due.length ? 'restricted' : 'pending'
    return { status, charges_enabled: cardActive, payouts_enabled: payouts, details_submitted: due.length === 0, capabilities: caps, requirements_currently_due: due }
  } catch (err) {
    console.warn(`⚠️  Stripe status fetch failed (${(err as Error).message}) — assuming enabled.`)
    return null
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // --list: just enumerate the Stripe test platform's connected accounts, no team.
  if (cli.list) {
    await listAccounts()
    return
  }

  const teamRef = db.collection(TEAMS_COLLECTION).doc(TEAM_ID as string)
  const teamSnap = await teamRef.get()
  if (!teamSnap.exists) {
    console.error(`❌ Team '${TEAM_ID}' not found in ${USE_EMULATOR ? 'the emulator' : PROJECT_ID}.`)
    process.exit(1)
  }

  // ── Disable: clear the wiring so the studio reads as "not connected". ──
  if (cli.disable) {
    const existing = teamSnap.data()?.payments?.connectAccountId as string | undefined
    await teamRef.set({ payments: { connectEnabled: false, connectAccountId: null, connectStatus: null } }, { merge: true })
    if (existing) await db.collection(CONNECT_ACCOUNTS_COLLECTION).doc(existing).delete().catch(() => {})
    console.log(`✅ Cleared Connect wiring for team '${TEAM_ID}'.`)
    return
  }

  const accountId = cli.account ?? process.env.STRIPE_CONNECT_TEST_ACCOUNT
  if (!accountId || !accountId.startsWith('acct_')) {
    console.error(
      '❌ Missing --account acct_… (or STRIPE_CONNECT_TEST_ACCOUNT env).\n' +
        '   Onboard one test account once via Settings → Payments, then reuse its acct_ id here.'
    )
    process.exit(1)
  }

  // Real status when asked (and reachable); otherwise trust that the provided
  // account is already onboarded and mark it chargeable.
  const status = (cli.refresh ? await fetchLiveStatus(accountId) : null) ?? ASSUMED_ENABLED
  await linkConnectAccount({ db, teamId: TEAM_ID as string, accountId, model: MODEL, status })

  console.log(
    `✅ Linked ${accountId} → team '${TEAM_ID}' (${USE_EMULATOR ? 'emulator' : PROJECT_ID}), status=${status.status}, charges=${status.charges_enabled}.`
  )
  if (status.status !== 'enabled') {
    console.log('   ⚠️  Not fully enabled — finish onboarding for this account, then --refresh, or omit --refresh to force-enable for local testing.')
  }
  console.log('   The "pay with Linyup" flow (/public/{slug}/shop) is now wired for this team.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

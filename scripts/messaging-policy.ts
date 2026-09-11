/**
 * messaging-policy — inspect/set a tenant's outbound-delivery policy
 * (messaging_policies/{entityId}; OPERATOR-only, resolved by the mail/SMS
 * services). See packages/functions/src/mail/README.md → "Per-tenant delivery
 * policy" for the model.
 *
 * Usage (cloud targets linyup-sandbox via ADC, like seed-lead):
 *   pnpm messaging:policy --team lead-swimli --show
 *   pnpm messaging:policy --team lead-swimli --mode allowlist \
 *     --allow hello@swimliclub.com --allow franco.dgstn@gmail.com \
 *     --allow-phone +41761234501 --note "founder demo"
 *   pnpm messaging:policy --team sandbox-yoga --mode silent
 *   pnpm messaging:policy --team e2e-team --mode redirect --redirect capture@linyup.com
 *   pnpm messaging:policy --team lead-swimli --delete       # fall back to env default
 *   pnpm messaging:policy --team lead-swimli --show --target emulator
 *
 * entityId is a teamId, an orgId, or the literal 'system' (Linyup system mail).
 */
import * as admin from 'firebase-admin'
import { applicationDefault } from 'firebase-admin/app'
import { parseArgs } from 'node:util'

const { values: cli } = parseArgs({
  options: {
    team: { type: 'string' },
    show: { type: 'boolean', default: false },
    delete: { type: 'boolean', default: false },
    mode: { type: 'string' },
    allow: { type: 'string', multiple: true },
    'allow-phone': { type: 'string', multiple: true },
    redirect: { type: 'string' },
    'redirect-phone': { type: 'string' },
    note: { type: 'string' },
    'ignore-test-mode': { type: 'boolean', default: false },
    target: { type: 'string' },
  },
})

const ENTITY = cli.team
if (!ENTITY || !/^[a-zA-Z0-9_-]+$/.test(ENTITY)) {
  console.error('❌ Missing/invalid --team <teamId|orgId|system>.')
  process.exit(1)
}

const MODES = ['live', 'allowlist', 'redirect', 'silent']
if (cli.mode && !MODES.includes(cli.mode)) {
  console.error(`❌ Invalid --mode '${cli.mode}'. Use ${MODES.join(' | ')}.`)
  process.exit(1)
}

// Target resolution — same convention as seed-lead.ts.
const TARGET = (cli.target ?? '').toLowerCase()
if (TARGET === 'emulator' || TARGET === 'emulators') {
  process.env.FIRESTORE_EMULATOR_HOST ??= 'localhost:8080'
}
const USE_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST
const PROJECT_ID = USE_EMULATOR ? process.env.GCLOUD_PROJECT || 'demo-linyup' : 'linyup-sandbox'
const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
if (!USE_EMULATOR && envProject && envProject !== PROJECT_ID) {
  console.error(`❌ Refusing to run: ambient project '${envProject}' != '${PROJECT_ID}'.`)
  process.exit(1)
}

admin.initializeApp(
  USE_EMULATOR
    ? { projectId: PROJECT_ID }
    : { credential: applicationDefault(), projectId: PROJECT_ID }
)
const db = admin.firestore()
db.settings({ ignoreUndefinedProperties: true })

async function main() {
  const ref = db.collection('messaging_policies').doc(ENTITY!)
  const target = USE_EMULATOR ? 'emulator' : PROJECT_ID

  if (cli.delete) {
    await ref.delete()
    console.log(`🗑  ${target}: messaging_policies/${ENTITY} deleted — env default applies.`)
    return
  }

  if (cli.mode) {
    if (cli.mode === 'redirect' && !cli.redirect && !cli['redirect-phone']) {
      console.error('❌ --mode redirect needs --redirect <email> (and/or --redirect-phone).')
      process.exit(1)
    }
    await ref.set(
      {
        entityId: ENTITY,
        mode: cli.mode,
        ...(cli.allow ? { allowEmails: cli.allow.map((e) => e.toLowerCase()) } : {}),
        ...(cli['allow-phone'] ? { allowPhones: cli['allow-phone'] } : {}),
        ...(cli.redirect ? { redirectEmail: cli.redirect } : {}),
        ...(cli['redirect-phone'] ? { redirectPhone: cli['redirect-phone'] } : {}),
        ...(cli['ignore-test-mode'] ? { ignoreTestMode: true } : {}),
        ...(cli.note ? { note: cli.note } : {}),
        updated_at: admin.firestore.Timestamp.now(),
        updated_by: 'messaging-policy-cli',
      },
      // Full replace on mode change — stale allowlists from a previous mode must
      // not linger. Use --show first when unsure.
      { merge: false }
    )
    console.log(`✅ ${target}: messaging_policies/${ENTITY} ← mode '${cli.mode}'.`)
  }

  const snap = await ref.get()
  if (!snap.exists) {
    console.log(`ℹ️  ${target}: no policy for '${ENTITY}' — the MESSAGING_DEFAULT_MODE env param applies.`)
    return
  }
  const d = snap.data()!
  console.log(`\nmessaging_policies/${ENTITY} (${target}):`)
  console.log(`  mode:          ${d.mode}`)
  if (d.allowEmails?.length) console.log(`  allowEmails:   ${d.allowEmails.join(', ')}`)
  if (d.allowPhones?.length) console.log(`  allowPhones:   ${d.allowPhones.join(', ')}`)
  if (d.redirectEmail) console.log(`  redirectEmail: ${d.redirectEmail}`)
  if (d.redirectPhone) console.log(`  redirectPhone: ${d.redirectPhone}`)
  if (d.ignoreTestMode) console.log(`  ignoreTestMode: true — EXEMPT from the environment's TEST_MODE redirect`)
  if (d.note) console.log(`  note:          ${d.note}`)
  if (d.updated_by) console.log(`  updated_by:    ${d.updated_by}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ messaging-policy failed:', err)
    process.exit(1)
  })

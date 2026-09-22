/**
 * Tarif 595 seeding — the Swiss health-insurance receipt plugin, set up far
 * enough that a prospect can issue one in the demo (docs/tarif-595.md).
 *
 * WHY IT IS SEEDED AT ALL: the plugin's whole pitch is "your members get money
 * back from their supplementary insurance, and you press one button". Opening
 * `/plugins/tarif-595` on a tenant with no identifiers, no position mappings
 * and no member insurance data shows a wall of "incomplete" instead — the
 * empty-shell problem this repo's other fixtures already name.
 *
 * WHAT IS DELIBERATELY NOT SEEDED: receipts. A receipt is issued by
 * `issueTarif595Receipt`, which allocates a number, freezes a snapshot and
 * renders a PDF + XML; writing rows that look like its output but never went
 * through it would put documents in front of a prospect that the void, download
 * and e-mail paths cannot act on. The seed sets the table; the demo presses the
 * button.
 *
 * WHAT THIS FIXTURE DOES NOT OWN: the CONTACT side of the same last click.
 * `buildReceiptDraft` refuses unless the member carries a birthdate, a gender
 * and a postal address, and none of those belong to this plugin — they are the
 * roster's, written by whichever seeder built it. The address was the one that
 * was missing everywhere, so a seeded receipt previewed and then died on
 * `contact_address_incomplete`; scripts/lib/address.ts is where it comes from
 * now, and its header owns why the locality is the studio's own.
 *
 * Every identifier is COMPUTED (scripts/lib/tarif595.ts) — a GLN or an AHVN13
 * with a wrong check digit fails at the issue call, which is the one moment a
 * demo must not break. `modus` stays 'test' so nothing here resembles a real
 * claim.
 */

import admin from 'firebase-admin'
import {
  buildTarif595Config,
  buildTarif595ContactRow,
  type SeedTarif595Contact,
  type SeedTarif595Mapping,
} from '../tarif595'

const TEAMS_COLLECTION = 'teams'
const INSTALLED_PLUGINS_SUBCOLLECTION = 'installed_plugins'
const TEAM_SETTINGS_SUBCOLLECTION = 'settings'
const LEGAL_PROFILE_SETTINGS_DOC_ID = 'legal_profile'
const TARIF595_SETTINGS_SUBCOLLECTION = 'tarif595_settings'
const TARIF595_SETTINGS_DOC = 'config'
const TARIF595_CONTACTS_SUBCOLLECTION = 'tarif595_contacts'
const TARIF595_PLUGIN_ID = 'tarif-595'

/** The creditor identity on a receipt — SHARED with the qr-invoices plugin
 *  (`types/legalProfile.ts`), which is why it is written here rather than
 *  inside the config: seeding one plugin must not stamp the other's data as
 *  belonging to it. Skipped when the tenant already has one. */
export async function seedTeamLegalProfile(opts: {
  teamId: string
  uid: string
  legalName: string
  postal: { street_name: string; house_no: string; zip: string; city: string }
  canton: string
  /** A structurally valid CH IBAN (mod-97). The demo one below is the standard
   *  CH93 example, which validates and belongs to nobody. */
  iban?: string
  vatNumber?: string | null
  phone?: string | null
  email?: string | null
}): Promise<{ written: boolean }> {
  const db = admin.firestore()
  const ref = db
    .collection(TEAMS_COLLECTION)
    .doc(opts.teamId)
    .collection(TEAM_SETTINGS_SUBCOLLECTION)
    .doc(LEGAL_PROFILE_SETTINGS_DOC_ID)
  const existing = await ref.get()
  if (existing.exists) return { written: false }
  await ref.set({
    legal_name: opts.legalName,
    postal: { ...opts.postal, country: 'CH' },
    canton: opts.canton,
    iban: opts.iban ?? 'CH9300762011623852957',
    qr_iban: null,
    vat_number: opts.vatNumber ?? null,
    vat_rate: opts.vatNumber ? 8.1 : null,
    phone: opts.phone ?? null,
    email: opts.email ?? null,
    updated_at: admin.firestore.Timestamp.now(),
    updated_by: opts.uid,
  })
  return { written: true }
}

/**
 * Install the plugin, write the config and give a handful of members their
 * insurance data. Returns what was seeded, for the run summary.
 *
 * IT READS THE TEAM'S OWN CATALOGUE rather than being handed ids. Every seeder
 * builds its activities and plans differently and holds those ids in a
 * different scope, so passing them in meant this block could only live where
 * that scope reached — which is how the first attempt landed in the wrong
 * function in two seeders. Reading them back asks Firestore the same question
 * the settings screen asks, so a seeded mapping covers exactly the offerings a
 * prospect will see listed there.
 *
 * `overrides` are keyed `activity:{slug}` / `subscription:{docId or key
 * suffix}` — what a LEAD profile names, because only the lead knows which
 * tariff position its offering really is. Anything unnamed falls back to the
 * free-text 9999 carrying the offering's own title: always valid, never a
 * billing claim the seeder invented.
 */
export async function seedTeamTarif595(opts: {
  teamId: string
  uid: string
  prefix: string
  overrides?: Record<string, SeedTarif595Mapping>
  /** Absent ⇒ the team's first few contacts, in roster order. */
  contacts?: SeedTarif595Contact[]
  language?: 'de' | 'fr' | 'it'
  installedDaysAgo?: number
}): Promise<{ offerings: number; contacts: number }> {
  const db = admin.firestore()
  const overrides = opts.overrides ?? {}
  const offerings: Record<string, SeedTarif595Mapping> = {}

  const activitySnap = await db.collection('activities').where('teamId', '==', opts.teamId).get()
  for (const doc of activitySnap.docs) {
    const a = doc.data() as { name?: string; slug?: string; type?: string }
    const named = a.slug ? overrides[`activity:${a.slug}`] : undefined
    offerings[`activity:${doc.id}`] = named ?? {
      position: '9999',
      unit: 'lesson',
      customName: a.name ?? doc.id,
    }
  }

  const planSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(opts.teamId)
    .collection('subscription_types')
    .get()
  for (const doc of planSnap.docs) {
    // A lead profile keys its plans by the short key its ids end with
    // (`{teamId}-sub-{key}`), so match on either.
    const keySuffix = doc.id.split('-sub-')[1]
    const named = overrides[`subscription:${doc.id}`] ?? (keySuffix ? overrides[`subscription:${keySuffix}`] : undefined)
    const p = doc.data() as { name?: string; prices?: { credits?: number | null }[] }
    const credits = p.prices?.find((x) => typeof x?.credits === 'number')?.credits ?? null
    offerings[`subscription:${doc.id}`] =
      named ??
      (credits
        ? { position: '9999', unit: 'entry', entries: credits, customName: p.name ?? doc.id }
        : { position: '9999', unit: 'month', customName: p.name ?? doc.id })
  }

  let contacts = opts.contacts
  if (!contacts) {
    const roster = await db.collection('contacts').where('teamId', '==', opts.teamId).limit(6).get()
    contacts = roster.docs.map((d, n) => ({ contactId: d.id, ahvSeed: 300000 + n * 6421, insurerIndex: n }))
  }
  const installedAt = new Date()
  installedAt.setDate(installedAt.getDate() - (opts.installedDaysAgo ?? 120))
  const team = db.collection(TEAMS_COLLECTION).doc(opts.teamId)

  await team.collection(INSTALLED_PLUGINS_SUBCOLLECTION).doc(TARIF595_PLUGIN_ID).set({
    pluginId: TARIF595_PLUGIN_ID,
    teamId: opts.teamId,
    installedAt: admin.firestore.Timestamp.fromDate(installedAt),
    installedBy: opts.uid,
    status: 'active',
    config: {},
    updated_at: admin.firestore.Timestamp.fromDate(installedAt),
  })

  await team
    .collection(TARIF595_SETTINGS_SUBCOLLECTION)
    .doc(TARIF595_SETTINGS_DOC)
    .set({
      ...buildTarif595Config({
        prefix: opts.prefix,
        identitySeed: opts.teamId,
        offerings,
        contacts,
        language: opts.language,
      }),
      updated_at: admin.firestore.Timestamp.fromDate(installedAt),
      updated_by: opts.uid,
    })

  for (const c of contacts) {
    await team
      .collection(TARIF595_CONTACTS_SUBCOLLECTION)
      .doc(c.contactId)
      .set({
        ...buildTarif595ContactRow(c),
        updated_at: admin.firestore.Timestamp.fromDate(installedAt),
        updated_by: opts.uid,
      })
  }

  return { offerings: Object.keys(offerings).length, contacts: contacts.length }
}

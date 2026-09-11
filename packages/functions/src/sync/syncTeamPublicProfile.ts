// Keeps teams/{teamId}/public_profile/{teamId} in sync when a team document changes
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import {
  TEAMS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  SITE_PUBLISHED_COLLECTION,
  FORMS_COLLECTION,
  DOCUMENTS_COLLECTION,
  ACTIVITIES_COLLECTION,
  AVAILABILITY_COLLECTION,
  TEAM_SETTINGS_SUBCOLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  DOCUMENTS_SETTINGS_DOC_ID,
  WAIVER_POLICY_SUBCOLLECTION,
  WAIVER_POLICY_DOC_ID,
  publicPagesIndexable,
  resolveNoShowPolicy,
  resolveSignupDocumentIds,
  resolveSystemLinkTarget,
  toKioskPublicConfig,
  normalizeKioskConfig,
  resolveAppointmentDurations,
  resolveDurationSale,
  effectiveRankingSystems,
  pickPublicGamificationSettings,
  PUBLIC_LOCALES,
  type CustomFieldDefinition,
} from '@linyup/shared'
import type {
  Activity,
  PublicSurface,
  ActivePublicSurfaces,
  DocumentKind,
  KioskConfig,
  GiftCardSettings,
  PublicRequiredWaiver,
  RequiredWaiverEntry,
  RankingSystem,
  SaasPlan,
  UiLanguage,
} from '@linyup/shared'
import { rebuildTeamPublicCoaches } from './syncTeamCoachesPublicProfile'
import { resolveActivePluginInstalls } from '../utils/plugins'

/** How many published forms the liveness probe looks at before giving up.
 *  One would do while nothing archives a form; a small page keeps the answer
 *  right if archiving is added and a studio's most recent published forms are
 *  all archived. */
const PUBLISHED_FORM_PROBE = 10

export const syncTeamPublicProfile = onDocumentWritten('teams/{teamId}', async (event) => {
  const { teamId } = event.params
  const afterRef = event.data!.after.ref

  if (!event.data!.after.exists) {
    await afterRef.collection('public_profile').doc(teamId).delete()
    return
  }

  const data = event.data!.after.data()!
  const db = admin.firestore()

  // ── active_public_surfaces computation ──────────────────────────────────────
  // Each check uses limit(1) to avoid full scans.

  // ── THE PLUGIN PROBES ARE ORG-AWARE ─────────────────────────────────────────
  //
  // All three read the TEAM path only, which made an org-level install invisible
  // to the one computation that decides what the PUBLIC sees. A federation that
  // installed `website` for its studios had already granted them the feature —
  // `publishWebsite`, the kiosk callable and every other server gate honour that
  // through `pluginIsActive` — but this flag alone disagreed, so a member studio
  // could publish a site that its own public profile then advertised as absent.
  //
  // WHY THIS IS SAFE TO FLIP. Two of the three surfaces are ALSO gated on
  // published content — `site` on a published site document, `forms` on a
  // published form — so no studio can begin advertising something it never
  // created. `kiosk` has no such second condition, and correctly so: an org
  // install IS the grant, and the kiosk callable already resolves it that way.
  //
  // EVENTUALLY CONSISTENT, deliberately. Nothing fans an org install out to its
  // member teams; each studio's surfaces recompute on its own next team write.
  // The alternative — a trigger on org installs touching every member team — is
  // a write amplification this flag does not justify, and the previous behaviour
  // was not "later" but "never".
  //
  // Batched with the team's `org_id`, which this trigger is standing on: two
  // round trips for three plugins rather than nine reads. See
  // `resolveActivePluginInstalls`.
  const orgId = (data.org_id as string | undefined) ?? null

  const [pluginInstalls, sitePublishedSnap, orgSnap] = await Promise.all([
    resolveActivePluginInstalls(teamId, orgId, [
      'website',
      'kiosk',
      'custom-forms',
      'gift-cards',
      'gamification',
    ]),
    db.doc(`${SITE_PUBLISHED_COLLECTION}/${teamId}`).get(),
    // Read with the admin SDK: the org doc is members-only under
    // firestore.rules, but this trigger runs server-side and only ever copies
    // the two PUBLIC-safe fields below onto the mirror. NOTE: an org-only
    // write (ranking_systems/affiliation_term edited with no team write) does
    // NOT re-trigger this sync — see the comment on the mirrored fields below
    // and TeamPublicProfile.ranking_systems' doc comment.
    orgId ? db.doc(`${ORGANIZATIONS_COLLECTION}/${orgId}`).get() : Promise.resolve(null),
  ])
  const orgData = orgSnap?.exists ? orgSnap.data() : undefined

  // site: website plugin active AND a published site exists
  // kiosk: entrance-tablet surface — live whenever the plugin install is active.
  const siteActive = pluginInstalls.get('website') !== null && sitePublishedSnap.exists
  const kioskActive = pluginInstalls.get('kiosk') !== null

  // Portal (stored under the stable `space` key): the contact's PERSONAL member
  // portal — membership, bookings, profile, and the courses they can open. Decoupled
  // from the course catalogue (that lives in the shop), so it's a BASE surface,
  // available to every team's contacts → always live, plugin-free.
  const spaceActive = true

  // forms: custom-forms plugin active AND ≥1 published, non-archived form.
  //
  // THE ARCHIVED TEST IS IN MEMORY, and that is a fix rather than a style
  // choice. It was a `where('archived_at', '==', null)` clause, which matches an
  // EXPLICIT null and NOT a missing field — and no form document has ever
  // carried the field: `Form.archived_at` is declared optional, `createForm`
  // does not write it, and nothing archives a form at all. So the clause matched
  // nothing, `formsActive` was false for every studio, and a published form
  // never appeared in `active_public_surfaces` — which is what the public tenant
  // root and the site menu read to decide a surface is live.
  //
  // Same trap as `teams where archived_at == null` (see utils/tenantFanOut.ts,
  // and the monthly finance reports it silently emptied). Asked in memory, an
  // absent marker correctly reads as "not archived", and the test keeps working
  // if archiving is ever added.
  let formsActive = false
  if (pluginInstalls.get('custom-forms') !== null) {
    const publishedFormSnap = await db
      .collection(FORMS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('status', '==', 'published')
      .limit(PUBLISHED_FORM_PROBE)
      .get()
    formsActive = publishedFormSnap.docs.some((d) => d.data()?.archived_at == null)
  }

  // documents: NO PLUGIN PROBE — Documents is a default feature on every plan.
  //
  // The liveness test is the existence of a public_profile MIRROR, not of a
  // published document, and the difference is the whole point. A team that
  // trialed on Studio, published documents and was then downgraded still HAS
  // those documents: the old teardown deleted their mirrors and nothing else. A
  // probe over the root `documents` collection would therefore flip this surface
  // live again on the next unrelated team write, and /public-page would advertise
  // it — and offer it as a default landing surface — over a page that renders the
  // empty state, because the mirror backfill is opt-in per team and may never
  // have been run for them. Probing the mirrors makes this flag agree with what a
  // visitor would actually see.
  //
  // Same shape and cost as the forms check above (one limit(1) query), over the
  // collection that actually backs the page. No new index: the public documents
  // index page already runs this exact teamId + type query.
  const documentMirrorSnap = await db
    .collectionGroup('public_profile')
    .where('teamId', '==', teamId)
    .where('type', '==', 'document')
    .limit(1)
    .get()
  const documentsActive = !documentMirrorSnap.empty

  // signup_documents: the published + public documents the studio attached to the
  // signup consent checkbox. Denormalized here so the anonymous signup form reads
  // consent links from one world-readable doc. Read each referenced document's
  // public_profile summary — an id whose summary is missing (unpublished /
  // unshared) is silently skipped, which is right for a display list of links and
  // is exactly why the booking gate reads the waiver POLICY instead.
  //
  // DUAL READ, in ONE place (resolveSignupDocumentIds): the new
  // `teams/{id}/settings/documents` home, falling back to the retired plugin
  // config for teams the backfill has not reached. The panel that writes it reads
  // through the same helper, so a studio's save and this recompute can never
  // disagree about which location wins.
  const [documentsSettingsSnap, legacyDocumentsPluginSnap] = await Promise.all([
    db.doc(`${TEAMS_COLLECTION}/${teamId}/${TEAM_SETTINGS_SUBCOLLECTION}/${DOCUMENTS_SETTINGS_DOC_ID}`).get(),
    db.doc(`${TEAMS_COLLECTION}/${teamId}/${INSTALLED_PLUGINS_SUBCOLLECTION}/documents`).get(),
  ])
  const idList = resolveSignupDocumentIds({
    settings: documentsSettingsSnap.data() as { signupDocumentIds?: string[] } | undefined,
    legacyPluginConfig: legacyDocumentsPluginSnap.data()?.config as
      | { signupDocumentIds?: unknown }
      | undefined,
  })
  let signupDocuments: Array<{
    documentId: string
    slug: string
    title: string
    kind: DocumentKind
    version: number | null
  }> = []
  if (idList.length > 0) {
    const summaries = await Promise.all(
      idList.map((id) => db.doc(`${DOCUMENTS_COLLECTION}/${id}/public_profile/${id}`).get())
    )
    signupDocuments = summaries
      .filter((s) => s.exists)
      .map((s) => {
        const d = s.data()!
        return {
          // The id, so the signup form can echo WHICH document it showed and
          // completeSignup can write a ledger row without trusting a
          // client-supplied slug. The mirror doc id IS the document id.
          documentId: s.id,
          slug: d.slug as string,
          title: (d.title as string) || '',
          kind: (d.kind as DocumentKind) || 'other',
          // The version the visitor will actually be shown. null for a document
          // that predates versioning and has not been backfilled — the form
          // renders it, the ledger skips it, and nothing pretends otherwise.
          version: typeof d.version === 'number' ? (d.version as number) : null,
        }
      })
  }

  // required_waivers: the SUMMARY of the team's required waivers, read from the
  // server-written policy document — never from the `documents` collection, and
  // never carrying a body. It is a RENDERING HINT: the public surface calls
  // resolveWaiverRequirement if and only if this list is non-empty, so a tenant
  // with no waiver pays zero extra round-trips on the acquisition path, while
  // AUTHORIZATION always reads the policy document itself (which fails closed).
  //
  // A briefly-stale empty list therefore degrades to a server refusal the
  // surface can act on, never to a compliance hole — and every policy writer
  // touches the team document in the same transaction, so it is never stale by
  // more than one sync.
  const waiverPolicySnap = await db
    .doc(`${TEAMS_COLLECTION}/${teamId}/${WAIVER_POLICY_SUBCOLLECTION}/${WAIVER_POLICY_DOC_ID}`)
    .get()
  const requiredWaivers: PublicRequiredWaiver[] = (
    (waiverPolicySnap.data()?.required as RequiredWaiverEntry[] | undefined) ?? []
  ).map((e) => ({
    documentId: e.documentId,
    slug: e.slug,
    title: e.title,
    version: e.current_version,
    mayIncludeMinors: e.mayIncludeMinors === true,
  }))

  // booking: base feature — available whenever booking settings have been configured
  // (bookingSettings lands on the public_profile via syncBookingSettings; here we
  // mirror the same signal used elsewhere: the settings sub-doc existence / field).
  // Default to true — booking works on every plan, plugin-free.
  const bookingActive = true

  const giftCardsPluginActive = pluginInstalls.get('gift-cards') !== null
  // Gamification: the Space's Gamification tab is gated on the plugin install
  // alone — the DATA it shows (the contact's own score/streak/badges, and
  // teams/{id}/leaderboard/current) is already readable by a contact session
  // under firestore.rules without any mirror. See
  // TeamPublicProfile.gamificationEnabled.
  const gamificationEnabled = pluginInstalls.get('gamification') !== null
  // CAN THIS STUDIO BE PAID? Both halves of the server-side answer, read from
  // the same two fields `loadEnabledTeam` + `requireChargeableAccount` enforce
  // (connect/access.ts): the operator kill-switch must not be down, and the
  // connected account must be chargeable. Mirrored below as `payments_enabled`
  // so public surfaces can ask the question without reading teams/.
  const payments = data.payments as
    | { connectStatus?: string; connectEnabled?: boolean }
    | undefined
  const paymentsEnabled = payments?.connectEnabled !== false && payments?.connectStatus === 'enabled'
  // shop: EVERY shop item — memberships, products, courses, gift cards — is
  // bought through Stripe Connect, so the surface is live only when the studio
  // can actually take the money. A products plugin without a chargeable account
  // used to light this up, which put a page full of buy buttons in front of
  // visitors and refused every one of them at the callable (UX-33). The plugins
  // decide WHAT is on the shelves; this decides whether there is a till.
  const shopActive = paymentsEnabled

  // events: base feature, no plugin. Probed over the MIRRORS for the same reason
  // documents is (see above): the flag must agree with what a visitor would
  // actually see, and only a published event HAS a mirror. Events are private by
  // default, so this is false for most studios.
  //
  // Deliberately the team's OWN events only. A studio whose sole published events
  // are inherited from its parent org does not get to advertise this as a landing
  // surface — /public/{slug}/events still lists them, but "this studio published
  // something" stays an honest claim.
  //
  // No new index: the public events index page already runs this exact
  // type + teamId query.
  const eventMirrorSnap = await db
    .collectionGroup('public_profile')
    .where('teamId', '==', teamId)
    .where('type', '==', 'event')
    .limit(1)
    .get()
  const eventsActive = !eventMirrorSnap.empty

  // signup is a base surface (the subscription sign-up form) — available on every
  // plan, so always live. Denormalized here so the public root can redirect to it
  // when it's chosen as the default landing.
  const signupActive = true

  // appointments: THE CONTENT HALF of the appointment picker's liveness — see
  // `ActivePublicSurfaces.appointments` for why the studio's own
  // `bookingSettings.appointmentsEnabled` toggle is deliberately NOT folded in
  // here, and `appointmentPickerLive` for the one place the two are combined.
  // (The toggle is enforced against VISITORS in `listAvailability`, which is a
  // different question from whether there is content behind the door.)
  const appointmentsActive = await appointmentContentExists(db, teamId)

  // The partner apps this studio accepts, by name — see
  // TeamPublicProfile.partner_apps and resolveTeamPartnerApps below.
  const partnerApps = await resolveTeamPartnerApps(db, teamId)

  const active_public_surfaces: ActivePublicSurfaces = {
    site: siteActive,
    space: spaceActive,
    booking: bookingActive,
    signup: signupActive,
    shop: shopActive,
    forms: formsActive,
    documents: documentsActive,
    kiosk: kioskActive,
    events: eventsActive,
    appointments: appointmentsActive,
  }

  // ── default_public_surface ───────────────────────────────────────────────────
  // Copy only when set (never write undefined to Firestore).
  const defaultSurface = data.default_public_surface as PublicSurface | undefined

  const publicProfile: Record<string, unknown> = {
    type: 'team',
    name: data.name || '',
    description: data.description || '',
    slug: data.slug || '',
    // Which organisation this studio belongs to. Public surfaces need it to show
    // the parent org's published events alongside the studio's own — an org
    // event has no teamId, so it cannot be found by a teamId query.
    org_id: data.org_id || null,
    // The studio's AUTHORING language — an honest mirror, not a resolved one:
    // null when `teams/{id}.language` is unset or not a supported locale.
    // Public surfaces default the absence themselves, through
    // `resolveSiteSourceLocale` (utils/siteTranslation.ts) — never here.
    language: ((PUBLIC_LOCALES as readonly string[]).includes(data.language as string)
      ? (data.language as UiLanguage)
      : null),
    // How the studio renders dates and times — display settings, nothing
    // private; the public surfaces' `usePublicFormat` reads them. Mirrored as
    // stored (a Firestore map never carries `undefined`), null when unset.
    regional: (data.regional as Record<string, unknown> | undefined) ?? null,
    sport_type: data.sport_type || null,
    profileImage: data.profileImage || null,
    heroImage: data.heroImage || null,
    // The preset WINS over the two legacy fields when present, but all three
    // are mirrored: the renderer falls back to them for a bio-link authored
    // before presets, so dropping them here would blank those pages.
    bioLinkThemePreset: data.bioLinkThemePreset || null,
    bioLinkTheme: data.bioLinkTheme || 'light',
    bioLinkAccentColor: data.bioLinkAccentColor || null,
    bioLinkBackground: data.bioLinkBackground || null,
    socialLinks: (data.socialLinks || []).map((s: Record<string, unknown>) => ({
      platform: s.platform,
      url: s.url,
    })),
    links: (data.links || []).map((link: Record<string, unknown>) => ({
      label: link.label,
      description: link.description || null,
      url: link.url || null,
      iconName: link.iconName || null,
      showInBioLink: link.showInBioLink !== false,
      // 'page link' to one of the team's public surfaces; null for custom links.
      // resolveSystemLinkTarget also maps pre-refactor boolean flags.
      target: resolveSystemLinkTarget(link) || null,
    })),
    // OPT-IN ONLY. A custom field definition is a studio's private annotation
    // shape; the public book form can render one only when the studio ticked
    // `publicOnBookingForm` on it. Everything else stays on the team document,
    // which is members-only. Label/type/options are all the form needs — a
    // stored VALUE is never mirrored here.
    publicCustomFields: ((data.custom_field_definitions ?? []) as CustomFieldDefinition[])
      .filter((f) => f?.publicOnBookingForm === true)
      .map((f) => ({
        id: f.id,
        label: f.label,
        type: f.type,
        ...(f.options?.length ? { options: f.options } : {}),
      })),
    // The two coaching vocabularies — check-in axes and goal categories, which
    // are separate lists answering separate questions (see the header of
    // packages/shared/src/types/goal.ts). Both mirrored because the Space runs
    // on a contact session, which cannot read `teams/{id}` at all; without this
    // a studio that customises either one never reaches the member filling in
    // the form, who silently gets the defaults instead. Null when never
    // configured, which `resolveCoachingDimensions` / `resolveGoalCategories`
    // already read as "use the defaults".
    performance_indicators: data.performance_indicators ?? null,
    goal_categories: data.goal_categories ?? null,
    membershipRequiredFields: data.membershipRequiredFields || null,
    membershipOptionalFields: data.membershipOptionalFields || null,
    referralEnabled: !!data.settings?.referral?.enabled,
    gamificationEnabled,
    // The EFFECTIVE ranking systems — team's own, unless the org has
    // configured any, in which case the org's list wins for every member team
    // (`effectiveRankingSystems`, the ONE rule). See
    // TeamPublicProfile.ranking_systems for the staleness limitation.
    ranking_systems: effectiveRankingSystems(
      data.ranking_systems as RankingSystem[] | undefined,
      orgData?.ranking_systems as RankingSystem[] | undefined
    ),
    // The org's affiliation-concept label, or null when independent / unset —
    // see TeamPublicProfile.affiliation_term.
    affiliation_term:
      (orgData?.affiliation_term as Partial<Record<'en' | 'de' | 'fr' | 'it', string>> | undefined) ?? null,
    // The studio's own badge thresholds + coach badges — ONLY those two: the
    // stored bag also holds the scoring configuration, which stays private.
    // See pickPublicGamificationSettings and TeamPublicProfile.gamification_settings.
    gamification_settings: pickPublicGamificationSettings(data.settings?.gamification),
    // Free-plan bio-links carry a "Powered by Linyup" badge. Denormalized here
    // because bio-link pages only ever read public_profile, never teams/.
    showBranding: (data.plan ?? 'free') === 'free',
    // Whether this team's public pages may be crawled. Denormalized for the same
    // reason as showBranding — the pages that need it read public_profile alone —
    // but it is DELIBERATELY NOT the same boolean: showBranding asks "is this the
    // free tier", while indexability also refuses a trial, which is the tier every
    // throwaway signup lands on. See publicPagesIndexable.
    public_pages_indexable: publicPagesIndexable({
      plan: data.plan as SaasPlan | undefined,
      plan_status: data.plan_status as string | undefined,
    }),
    // Whether a priced door may be OFFERED at all — see
    // TeamPublicProfile.payments_enabled. Written on every sync, so switching
    // the kill-switch or finishing Connect onboarding (both touch the team doc)
    // takes the priced doors down or puts them up on the next write.
    payments_enabled: paymentsEnabled,
    // Billing currency for the website pricing table (bio-link/website never read teams/).
    default_currency: (data.default_currency as string | undefined) || null,
    // Team-wide cancellation policy default (activity-level override lives on
    // Activity.cancellationPolicy). Public because it's shown BEFORE booking,
    // not just emailed after — see bookingConfirmationInstructions for the
    // email-only sibling this deliberately does NOT reuse.
    bookingCancellationPolicy:
      (data.settings as { bookingCancellationPolicy?: string } | undefined)
        ?.bookingCancellationPolicy || null,
    // The team-wide "how do I get it?" default for product sales (UX-79). Same
    // home, same shape and the same reason for being public as the line above:
    // it is stated BEFORE the buyer pays, on a surface that reads public_profile
    // alone. The per-product override rides on the mirrored product entry.
    productCollectionNote:
      (data.settings as { productCollectionNote?: string } | undefined)
        ?.productCollectionNote || null,
    // The no-show policy's public TERMS (fee + threshold), so a booking surface
    // can state them BEFORE the button rather than in the email that follows.
    // Resolved through the same `resolveNoShowPolicy` the strike counter uses,
    // so "off" means the same thing on both sides of the mirror; `enabled` is
    // not carried — null IS off. See TeamPublicProfile.noShowPolicy.
    noShowPolicy: (() => {
      const policy = resolveNoShowPolicy(data.settings)
      return policy ? { feeAmount: policy.feeAmount, threshold: policy.threshold } : null
    })(),
    // Gift cards (E3): public-safe config only (enabled + purchasable face values —
    // never balances/codes) so the public shop can offer them without reading the
    // private team doc. Mirrors teams/{id}.settings.giftCards.
    // Gated on the gift-cards PLUGIN as well as the setting: uninstalling must
    // take the offer off the public shop, and the mirror is the only thing the
    // shop reads. This recomputes on install/uninstall because
    // onInstalledPluginStatusChange touches the team doc.
    //
    // SELLING only. Redeeming an already-issued card does not consult this — it
    // is money the studio has taken, and a plugin toggle must not void it.
    giftCards: (() => {
      if (!giftCardsPluginActive) return { enabled: false, amounts: [] }
      const raw = (data.settings as { giftCards?: GiftCardSettings } | undefined)?.giftCards
      return raw?.enabled === true && Array.isArray(raw.amounts)
        ? { enabled: true, amounts: raw.amounts }
        : { enabled: false, amounts: [] }
    })(),
    // Space "complete your signup" reminder toggle (absent ⇒ on) — the Space only
    // reads public_profile, so the setting must be mirrored here.
    space_signup_nudge: data.settings?.space?.signup_nudge !== false,
    active_public_surfaces,
    // The studio's own partner-app names, so the public book form can ask which
    // app somebody came through using the studio's answers rather than a
    // hardcoded industry list — and ask nothing at all when there are none.
    // Recomputed every run, so deactivating the last partner type takes the
    // question down. A partner type is not on THIS document, though, which is
    // why `syncSubscriptionTypesToPublicProfile` recomputes it too — see
    // `resolveTeamPartnerApps` below for every rail that writes this field.
    partner_apps: partnerApps,
    // Recomputed every run (may be empty) so stale consent links never linger.
    signup_documents: signupDocuments,
    // Recomputed every run from the waiver policy, for the same reason.
    required_waivers: requiredWaivers,
    updated_at: event.data!.after.updateTime,
  }

  // Only write default_public_surface when explicitly set; omit the key entirely
  // if unset so existing docs with no preference are not polluted with undefined.
  if (defaultSurface !== undefined) {
    publicProfile.default_public_surface = defaultSurface
  }

  // Denormalize the kiosk config (MINUS the PIN — toKioskPublicConfig strips it)
  // when the plugin is active; explicitly delete the field otherwise so a stale
  // config can never linger on a public, world-readable doc after deactivation.
  if (kioskActive) {
    // A freshly-installed kiosk persists `config: {}`; normalize fills every
    // field from the defaults so toKioskPublicConfig never dereferences a missing
    // one (which previously threw and aborted the ENTIRE public-profile sync for
    // the team, leaving kiosk — and every other surface — stale).
    // The RESOLVED install's config — so a studio whose kiosk came from its
    // organisation gets the organisation's settings rather than none. Precedence
    // between two active installs still favours the team's own.
    const kioskCfg = pluginInstalls.get('kiosk')?.config as Partial<KioskConfig> | undefined
    publicProfile.kiosk = toKioskPublicConfig(normalizeKioskConfig(kioskCfg))
  } else {
    publicProfile.kiosk = FieldValue.delete()
  }

  // Merge so sibling syncs that write other public_profile fields with merge
  // (e.g. aggregator_subscription_types, bookingSettings) aren't clobbered by a
  // team-doc write. Every field above is recomputed each run, so merge is safe.
  await afterRef.collection('public_profile').doc(teamId).set(publicProfile, { merge: true })

  // Re-derive the opt-in public coach roster too — a team write is also how
  // `public_coaches_enabled` gets toggled, and that field lives on this same doc.
  await rebuildTeamPublicCoaches(teamId)
})

/**
 * THE PARTNER APPS A STUDIO ACCEPTS, as names — for `TeamPublicProfile.partner_apps`.
 *
 * A "fitness app" is not a concept of its own in this data model: it is a
 * subscription type with `source: 'aggregator'` (SubscriptionType.source), which
 * is how the studio-facing UI already speaks about FitPass, SportPass and the
 * rest. So the public list is derived from the studio's own types rather than
 * from anything hardcoded, and it goes stale exactly when they do.
 *
 * NOT derived from the already-mirrored `aggregator_subscription_types`: that
 * array is filtered to `public == true`, which a partner type usually is not —
 * a studio does not sell FitPass in its own shop. Re-filtering it would yield an
 * empty list for most tenants, silently.
 *
 * NAMES ONLY. `payoutPerVisit` is what the partner pays the studio and prices
 * are commercial terms; neither belongs on a world-readable document, and the
 * form needs neither. Deduped case-insensitively (two types spelled the same
 * would render as two identical options) and sorted, so the option order does
 * not shuffle between syncs.
 *
 * ── ABSENT `active` MEANS ACTIVE ─────────────────────────────────────────────
 * Queried on `source` ALONE, with liveness filtered in memory. A
 * `.where('active', '==', true)` clause DROPS a document whose `active` field is
 * absent, and absent is ACTIVE everywhere else this repo reads an aggregator
 * type — `scripts/backfill-public-subscription-types.ts` spells it
 * `data.active !== false`, and so does the manager UI
 * (`components/subscriptions/SubscriptionTypesManager.tsx`). The strict clause
 * would hide a legacy partner the studio can see listed as active, and hide it
 * from the validator too, so the studio's real partner could be neither offered
 * nor stored. The result set is one studio's partner types: tiny.
 *
 * ── WHO WRITES THE MIRROR ────────────────────────────────────────────────────
 * Every rail that can change the answer calls this and writes the result to
 * `teams/{teamId}/public_profile/{teamId}.partner_apps`:
 *   • `syncTeamPublicProfile` (above) — on any write to `teams/{teamId}`
 *   • `syncSubscriptionTypesToPublicProfile` — on any write to a subscription
 *     type, which is where a partner is actually added, renamed or deactivated
 * A subscription type does NOT live on the team document, so without the second
 * rail the list would only refresh on some unrelated team write — the same gap
 * `sync/onAvailabilityWrite.ts` exists to close for availability windows.
 *
 * ── AND THAT MIRROR IS AUTHORITATIVE ─────────────────────────────────────────
 * Not a rendering hint: `loadTeamPartnerAppNames` (booking/contactFields.ts)
 * validates a posted answer against the mirror rather than re-querying here, so
 * the vocabulary the public form offered and the one the server accepts are the
 * same document. See that function's header for why.
 */
export async function resolveTeamPartnerApps(
  db: admin.firestore.Firestore,
  teamId: string
): Promise<string[]> {
  const snap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
    .where('source', '==', 'aggregator')
    .get()

  const seen = new Set<string>()
  const names: string[] = []
  for (const doc of snap.docs) {
    if (doc.data().active === false) continue
    const name = typeof doc.data().name === 'string' ? (doc.data().name as string).trim() : ''
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names.sort((a, b) => a.localeCompare(b))
}

// ── The appointment picker's CONTENT probe ──────────────────────────────────
//
// "Is there anything bookable behind /public/{slug}/appointments?" — answered by
// mirroring what `listAvailability` (appointments/window.ts) actually does,
// because that callable IS what a visitor sees. It returns `{ coaches: [] }`,
// i.e. an empty picker, unless an ACTIVE availability window links to an
// appointment activity of this team with at least one offerable duration; and it
// drops priced durations when the studio has no chargeable Connect account
// (UX-33), which can empty the picker on its own. All three conditions are
// reproduced here. If that resolver's rule changes, this one changes with it —
// the two disagreeing is precisely the guessed live state this flag exists to
// avoid.
//
// WHAT IT DELIBERATELY DOES NOT ASK: whether a given DAY has a free time. That
// needs the recurrence expanded over a date range against every booked session,
// which is a request-time computation, not a sync-time one. The flag says a
// visitor arrives at a configured picker rather than an empty state — not that
// tomorrow at 10:00 is free.
//
// The scan caps below bound the work this adds to EVERY team write. A studio
// with more active windows than the cap, whose only bookable one sits beyond it,
// gets a FALSE — an absent hub row rather than a wrong one, which is the safe
// direction (UX-28). No composite index: two equality filters, the same query
// `listAvailability` already runs, and the activities are fetched by id.
const APPOINTMENT_WINDOW_SCAN_LIMIT = 50
const APPOINTMENT_ACTIVITY_SCAN_LIMIT = 25

async function appointmentContentExists(
  db: admin.firestore.Firestore,
  teamId: string
): Promise<boolean> {
  const windows = await db
    .collection(AVAILABILITY_COLLECTION)
    .where('teamId', '==', teamId)
    .where('status', '==', 'active')
    .limit(APPOINTMENT_WINDOW_SCAN_LIMIT)
    .get()
  if (windows.empty) return false

  const referenced = new Set<string>()
  for (const doc of windows.docs) {
    for (const id of (doc.data().activityIds ?? []) as string[]) {
      if (referenced.size >= APPOINTMENT_ACTIVITY_SCAN_LIMIT) break
      referenced.add(id)
    }
  }
  if (referenced.size === 0) return false

  const activityDocs = await Promise.all(
    [...referenced].map((id) => db.collection(ACTIVITIES_COLLECTION).doc(id).get())
  )
  const bookable = new Set<string>()
  for (const doc of activityDocs) {
    if (!doc.exists) continue
    const a = doc.data() as Activity
    if (a.type !== 'appointment' || a.teamId !== teamId) continue
    // NO CHARGEABILITY FILTER — it would under-report now. A priced duration
    // used to be dropped when the studio had no Connect account, and this probe
    // mirrored that; since 2026-08-28 those lengths are booked and SETTLED AT
    // THE STUDIO, so a studio whose only durations are priced still has a live
    // picker. Filtering here would mark the surface dead over a page that works.
    const offerable = resolveAppointmentDurations(a)
    if (offerable.length === 0) continue
    bookable.add(doc.id)
  }
  if (bookable.size === 0) return false

  // The PAIRING, not merely the two sets being non-empty: a window offering only
  // activities that dropped out above is a window that yields nothing.
  return windows.docs.some((doc) =>
    ((doc.data().activityIds ?? []) as string[]).some((id) => bookable.has(id))
  )
}

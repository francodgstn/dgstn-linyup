/**
 * Shared storefront-seeding helpers for the seed scripts.
 *
 * Gives every studio+ demo team a complete public storefront so the /public/{slug}
 * surfaces all have content:
 *   • SHOP   → Products tab   (real teams/{id}/products + public_profile mirror)
 *   • SHOP   → Courses tab    (a one-off `purchase`-tier published course)
 *   • SITE   → Website        (a published one-page site with every section populated)
 *   • BIO    → page links      (Book / Join / Shop / Courses / Website)
 *
 * Plan gating: the products, website and online-courses plugins are all
 * `minPlan: 'studio'` (see each plugin manifest), so these helpers must only be
 * called for studio/organization teams — never coach/free.
 *
 * Self-contained writers: each function resolves `admin.firestore()` lazily at
 * call time (NOT at module load) so importing this file before
 * `admin.initializeApp()` runs in the seed is safe. Path constants mirror
 * @linyup/shared (the seed scripts don't resolve the workspace import).
 */

import admin from 'firebase-admin'
import { sanitizeMeta, sanitizeSections } from '../../packages/functions/src/website/sanitize'

// ── Firestore path constants (mirror @linyup/shared/paths) ─────────────────────
const TEAMS_COLLECTION = 'teams'
const PRODUCTS_SUBCOLLECTION = 'products'
const INSTALLED_PLUGINS_SUBCOLLECTION = 'installed_plugins'
const SITE_DRAFTS_COLLECTION = 'site_drafts'
const SITE_PUBLISHED_COLLECTION = 'site_published'
const COURSES_COLLECTION = 'courses'
const PROMO_CODES_SUBCOLLECTION = 'promo_codes'

// ── time helpers (local; avoid coupling to each seed's own ts/daysFromNow) ──────
const tsOf = (d: Date) => admin.firestore.Timestamp.fromDate(d)
function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

// ── shared identity passed to every writer ─────────────────────────────────────
export interface StorefrontOpts {
  teamId: string
  uid: string
  teamName: string
  teamSlug: string
  accentColor: string
  description: string
  /** Primary activity/class name, e.g. 'BJJ', 'Yoga' — flavors the course copy. */
  primaryActivity: string
  /** Contact email shown on the website contact section. */
  email: string
  /** Street/venue label for the website contact section. */
  locationLabel?: string
  /** ISO 4217, defaults 'CHF'. */
  currency?: string
  /** Free plan → website carries the "Powered by Linyup" badge. Studio+ → false. */
  freePlan?: boolean
  /** How long ago (days) the plugins were "installed" — keeps timelines believable. */
  installedDaysAgo?: number
}

// ── bio-link page links ────────────────────────────────────────────────────────
// Pure builders (no I/O) — used inline in each seed's team + public_profile writes.
// Page-link `target`s are SystemLinkTarget values; the public bio-link resolves them
// to /public/{slug}/{route}.

export interface PageLink {
  label: string
  description: string
  target: string
  showInBioLink: boolean
  iconName: string
  url: null
}

const LINK_BOOK: PageLink = {
  label: 'Book Now',
  description: 'Reserve your spot in a session',
  target: 'booking',
  showInBioLink: true,
  iconName: 'CalendarPlus',
  url: null,
}
const LINK_JOIN: PageLink = {
  label: 'Join as Member',
  description: 'Join our community and become a member',
  target: 'signup',
  showInBioLink: true,
  iconName: 'UserCheck',
  url: null,
}
const LINK_SHOP: PageLink = {
  label: 'Shop',
  description: 'Memberships, merch and courses',
  target: 'shop',
  showInBioLink: true,
  iconName: 'ShoppingBag',
  url: null,
}
const LINK_SPACE: PageLink = {
  label: 'Online Courses',
  description: 'Watch and learn between classes',
  target: 'space',
  showInBioLink: true,
  iconName: 'GraduationCap',
  url: null,
}
const LINK_SITE: PageLink = {
  label: 'Website',
  description: 'About us, schedule and contact',
  target: 'site',
  showInBioLink: true,
  iconName: 'Globe',
  url: null,
}

/** Full link set for a studio+ team with the whole storefront live. */
export function buildStorefrontPageLinks(): PageLink[] {
  return [LINK_BOOK, LINK_JOIN, LINK_SHOP, LINK_SPACE, LINK_SITE]
}

/** Lighter set for coach/free teams: booking + signup + memberships shop only. */
export function buildBasicPageLinks(): PageLink[] {
  return [LINK_BOOK, LINK_JOIN, LINK_SHOP]
}

// ── installed_plugins ──────────────────────────────────────────────────────────
// Never call this for a LOCKED plugin (e.g. 'ai-assistant'): those are key-gated
// and must stay out of all seed/sandbox/demo data (install only via unlockPlugin).
async function installPlugin(
  teamId: string,
  pluginId: string,
  uid: string,
  installedDaysAgo: number,
): Promise<void> {
  const db = admin.firestore()
  await db
    .collection('teams')
    .doc(teamId)
    .collection(INSTALLED_PLUGINS_SUBCOLLECTION)
    .doc(pluginId)
    .set({
      pluginId,
      teamId,
      installedAt: tsOf(daysAgo(installedDaysAgo)),
      installedBy: uid,
      status: 'active',
      config: {},
      updated_at: tsOf(daysAgo(installedDaysAgo)),
    })
}

// ── SHOP · Products ────────────────────────────────────────────────────────────
// Installs the products plugin, writes real teams/{id}/products docs, and mirrors
// the active set into public_profile.products (what syncProductsToPublicProfile
// would produce) so the public shop's Products tab renders deterministically.

interface SeedProduct {
  id: string
  name: string
  description: string
  priceAmount: number
  variantLabel?: string
  variants?: { id: string; label: string }[]
  order: number
}

function storeProducts(teamId: string, teamName: string): SeedProduct[] {
  return [
    {
      id: `${teamId}-prod-tee`,
      name: 'Training Tee',
      description: `Breathable performance tee with the ${teamName} crest.`,
      priceAmount: 35,
      variantLabel: 'Size',
      variants: [
        { id: 's', label: 'S' },
        { id: 'm', label: 'M' },
        { id: 'l', label: 'L' },
        { id: 'xl', label: 'XL' },
      ],
      order: 0,
    },
    {
      id: `${teamId}-prod-bottle`,
      name: 'Insulated Water Bottle',
      description: '750ml stainless steel — keeps drinks cold for 24h.',
      priceAmount: 28,
      order: 1,
    },
    {
      id: `${teamId}-prod-hoodie`,
      name: 'Heavyweight Hoodie',
      description: 'Cozy 400gsm hoodie for cooldowns and the street.',
      priceAmount: 75,
      variantLabel: 'Size',
      variants: [
        { id: 's', label: 'S' },
        { id: 'm', label: 'M' },
        { id: 'l', label: 'L' },
      ],
      order: 2,
    },
    {
      id: `${teamId}-prod-tote`,
      name: 'Kit Bag',
      description: 'Roomy gym tote for kit, towel and water bottle.',
      priceAmount: 45,
      order: 3,
    },
  ]
}

export async function seedStoreProducts(o: StorefrontOpts): Promise<void> {
  const db = admin.firestore()
  const installedDaysAgo = o.installedDaysAgo ?? 60
  await installPlugin(o.teamId, 'products', o.uid, installedDaysAgo)

  const products = storeProducts(o.teamId, o.teamName)
  for (const p of products) {
    await db
      .collection('teams')
      .doc(o.teamId)
      .collection(PRODUCTS_SUBCOLLECTION)
      .doc(p.id)
      .set({
        teamId: o.teamId,
        name: p.name,
        description: p.description,
        priceAmount: p.priceAmount,
        ...(p.variantLabel ? { variantLabel: p.variantLabel } : {}),
        ...(p.variants ? { variants: p.variants.map((v) => ({ ...v, active: true })) } : {}),
        active: true,
        order: p.order,
        created_at: tsOf(daysAgo(installedDaysAgo)),
        updated_at: tsOf(daysAgo(installedDaysAgo)),
        createdBy: o.uid,
      })
  }

  // Mirror the active set into public_profile.products (merge — preserves the
  // sibling fields the seed already wrote). Shape matches syncProductsToPublicProfile.
  const mirror = products.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    priceAmount: p.priceAmount,
    ...(p.variantLabel ? { variantLabel: p.variantLabel } : {}),
    ...(p.variants ? { variants: p.variants.map((v) => ({ id: v.id, label: v.label })) } : {}),
  }))
  await db
    .collection('teams')
    .doc(o.teamId)
    .collection('public_profile')
    .doc(o.teamId)
    .set({ products: mirror }, { merge: true })
}

// ── SITE · Website ─────────────────────────────────────────────────────────────
// Installs the website plugin and publishes a one-page site with every
// content-only section populated (hero · about · activities · pricing · schedule
// · contact). Writes both site_drafts (editor) and site_published (public read).

export async function seedStoreWebsite(o: StorefrontOpts): Promise<void> {
  const db = admin.firestore()
  const installedDaysAgo = o.installedDaysAgo ?? 60
  await installPlugin(o.teamId, 'website', o.uid, installedDaysAgo)

  const sections = [
    {
      id: `${o.teamId}-sec-hero`,
      type: 'hero',
      headline: o.teamName,
      subheadline: o.description,
      align: 'center',
      overlay: 45,
      cta: { label: 'Book Now', action: 'booking' },
    },
    {
      id: `${o.teamId}-sec-about`,
      type: 'content',
      heading: `About ${o.teamName}`,
      menuLabel: 'About',
      imageSide: 'left',
      body: `<p>${o.description}</p><p>Our coaches welcome every level — drop in for a free trial class, find your rhythm, and become part of a community that keeps showing up.</p>`,
    },
    {
      id: `${o.teamId}-sec-activities`,
      type: 'activities',
      heading: 'What we offer',
      menuLabel: 'Classes',
      source: 'activities',
      columns: 3,
      showBooking: true,
    },
    {
      id: `${o.teamId}-sec-pricing`,
      type: 'pricing',
      heading: 'Memberships',
      menuLabel: 'Pricing',
      subheading: 'Find the plan that fits your training.',
      source: 'subscriptions',
      ctaLabel: 'Join now',
    },
    {
      id: `${o.teamId}-sec-schedule`,
      type: 'schedule',
      heading: 'Upcoming classes',
      menuLabel: 'Schedule',
      source: 'sessions',
      windowDays: 14,
      displayMode: 'calendar',
      showBooking: true,
    },
    {
      id: `${o.teamId}-sec-contact`,
      type: 'contact',
      heading: 'Visit us',
      menuLabel: 'Contact',
      address: o.locationLabel ?? '12 Studio Lane, 8001 Zürich',
      phone: '+41 44 123 45 67',
      email: o.email,
      hours: 'Mon–Fri 7:00–21:00 · Sat 9:00–14:00',
      mapQuery: 'Zürich, Switzerland',
      showSocial: true,
    },
  ]
  const meta = {
    title: o.teamName,
    theme: 'light',
    accentColor: o.accentColor,
    font: 'sans',
    seo: { title: o.teamName, description: o.description },
    header: { showNav: true, ctaLabel: 'Book now', ctaAction: 'booking' },
    footer: { showSocial: true },
  }
  await db
    .collection(SITE_DRAFTS_COLLECTION)
    .doc(o.teamId)
    .set({
      teamId: o.teamId,
      slug: o.teamSlug,
      name: o.teamName,
      enabled: true,
      meta,
      sections,
      updated_at: tsOf(daysAgo(12)),
      updatedBy: o.uid,
    })
  await db
    .collection(SITE_PUBLISHED_COLLECTION)
    .doc(o.teamId)
    .set({
      teamId: o.teamId,
      slug: o.teamSlug,
      name: o.teamName,
      // Through the publish callable's own sanitizer — a demo site can never
      // show more than a studio pressing Publish would get.
      meta: sanitizeMeta(meta, o.teamName),
      sections: sanitizeSections(sections),
      socialLinks: [{ platform: 'instagram', url: `https://instagram.com/${o.teamSlug}` }],
      // As publishWebsite writes it: true on the free plan, absent otherwise.
      ...(o.freePlan ? { showBranding: true } : {}),
      published_at: tsOf(daysAgo(12)),
      updated_at: tsOf(daysAgo(12)),
    })
}

// ── SHOP · Courses (sellable) ──────────────────────────────────────────────────
// Installs the online-courses plugin (idempotent) and publishes a one-off
// `purchase`-tier course so the shop's Courses tab has an item. Optionally also
// publishes a `free` course so the Space portal isn't empty/all-locked for teams
// that have no other courses.

interface CourseSeed {
  id: string
  title: string
  summary: string
  access: 'free' | 'purchase'
  priceAmount?: number
  modules: { title: string; lessons: { title: string; type: 'text' | 'video'; body: string; media?: string; dur?: number }[] }[]
}

export async function seedStoreCourses(
  o: StorefrontOpts,
  opts: { includeFree?: boolean } = {},
): Promise<void> {
  const db = admin.firestore()
  const installedDaysAgo = o.installedDaysAgo ?? 60
  await installPlugin(o.teamId, 'online-courses', o.uid, installedDaysAgo)

  const act = o.primaryActivity
  const courses: CourseSeed[] = []
  if (opts.includeFree) {
    courses.push({
      id: `${o.teamId}-course-starter`,
      title: `${act} Starter`,
      summary: `A free, self-paced intro to ${act.toLowerCase()} — watch, learn and practice between classes.`,
      access: 'free',
      modules: [
        {
          title: 'Welcome',
          lessons: [
            {
              title: 'What to expect',
              type: 'text',
              body: `<p>Welcome to ${o.teamName}! Everything you need to know before your first class.</p>`,
            },
            {
              title: 'Your first session',
              type: 'video',
              body: '<p>A quick walkthrough of how a typical class runs.</p>',
              media: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
              dur: 360,
            },
          ],
        },
        {
          title: 'Core skills',
          lessons: [
            {
              title: `${act} fundamentals`,
              type: 'text',
              body: '<p>The building blocks every member should master early on.</p>',
            },
          ],
        },
      ],
    })
  }
  courses.push({
    id: `${o.teamId}-course-masterclass`,
    title: `${act} Masterclass`,
    summary: `A premium, in-depth ${act.toLowerCase()} course — buy once, keep forever.`,
    access: 'purchase',
    priceAmount: 49,
    modules: [
      {
        title: 'Advanced concepts',
        lessons: [
          {
            title: 'Reading your training',
            type: 'text',
            body: '<p>How to assess where you are and what to work on next.</p>',
          },
          {
            title: 'Drill breakdown',
            type: 'video',
            body: '<p>A detailed breakdown you can rewatch as often as you like.</p>',
            media: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
            dur: 720,
          },
        ],
      },
      {
        title: 'Putting it together',
        lessons: [
          {
            title: 'Building your own plan',
            type: 'text',
            body: '<p>Turn the concepts into a weekly plan that fits your schedule.</p>',
          },
        ],
      },
    ],
  })

  for (const c of courses) {
    let moduleCount = 0
    let lessonCount = 0
    const courseRef = db.collection(COURSES_COLLECTION).doc(c.id)
    for (let mi = 0; mi < c.modules.length; mi++) {
      const m = c.modules[mi]
      const moduleId = `${c.id}-m${mi}`
      await courseRef
        .collection('modules')
        .doc(moduleId)
        .set({
          courseId: c.id,
          teamId: o.teamId,
          title: m.title,
          order: mi,
          created_at: tsOf(daysAgo(installedDaysAgo)),
          updated_at: tsOf(daysAgo(installedDaysAgo)),
        })
      moduleCount++
      for (let li = 0; li < m.lessons.length; li++) {
        const l = m.lessons[li]
        await courseRef
          .collection('lessons')
          .doc(`${moduleId}-l${li}`)
          .set({
            courseId: c.id,
            moduleId,
            teamId: o.teamId,
            title: l.title,
            type: l.type,
            order: li,
            body: l.body,
            ...(l.type === 'video'
              ? { mediaSource: 'youtube', mediaUrl: l.media, durationSeconds: l.dur }
              : {}),
            attachments: [],
            created_at: tsOf(daysAgo(installedDaysAgo)),
            updated_at: tsOf(daysAgo(installedDaysAgo)),
          })
        lessonCount++
      }
    }
    const accessRule =
      c.access === 'purchase'
        ? { type: 'purchase', priceAmount: c.priceAmount }
        : { type: 'free' }
    await courseRef.set({
      scope: 'team',
      teamId: o.teamId,
      title: c.title,
      slug: c.id,
      summary: c.summary,
      status: 'published',
      accessRule,
      moduleCount,
      lessonCount,
      order: 0,
      created_at: tsOf(daysAgo(installedDaysAgo)),
      updated_at: tsOf(daysAgo(installedDaysAgo)),
      createdBy: o.uid,
      archived_at: null,
    })
    // Mirror what syncCoursePublicProfile writes so the public Space + shop list
    // the course even before the trigger fires against the project.
    await courseRef
      .collection('public_profile')
      .doc(c.id)
      .set({
        type: 'course',
        teamId: o.teamId,
        slug: c.id,
        title: c.title,
        summary: c.summary,
        coverImageUrl: null,
        accessType: c.access,
        ...(c.access === 'purchase' ? { priceAmount: c.priceAmount } : {}),
        subscriptionTypeIds: [],
        moduleCount,
        lessonCount,
        order: 0,
      })
  }
}

// ── SHOP · Promo codes ────────────────────────────────────────────────────────
// One live code per storefront tenant, so /manage/promo-codes is not an empty
// screen and a demo checkout can actually show a discount being applied
// (Franco's decision 3, 2026-08-19).
//
// A promo is a Stage A MODIFIER, not a tender: it changes what a purchase costs,
// and `resolvePaymentOptions` applies it. So the ONLY thing to seed is the code
// document. There is deliberately nothing else:
//
//   • no `redemptions/{identityKey}` rows — a use is consumed by a completed
//     SALE, and no seeded sale went through the promo rails;
//   • no `reservations` — those are live checkout state with a deadline, and a
//     seeded one would be a reservation nobody can release;
//   • `usage_count: 0` — its ONE writer is commitPromoRedemption's transaction,
//     writing an absolute value from its own read set. A seed inventing a count
//     would be a second writer with no ledger behind it.

export async function seedStorePromoCode(o: {
  teamId: string
  uid: string
  currency?: string
  installedDaysAgo?: number
}): Promise<void> {
  // Takes only what it needs, not the whole StorefrontOpts: the lead seeder
  // authors its storefront from a profile and has no StorefrontOpts to hand.
  const db = admin.firestore()
  const installedDaysAgo = o.installedDaysAgo ?? 30
  await installPlugin(o.teamId, 'promo-codes', o.uid, installedDaysAgo)

  // The canonical uppercase code IS the doc id — which is what makes "is this
  // code taken?" a create() rather than a query-then-write race.
  const code = 'WELCOME10'
  await db
    .collection(TEAMS_COLLECTION)
    .doc(o.teamId)
    .collection(PROMO_CODES_SUBCOLLECTION)
    .doc(code)
    .set({
      code,
      teamId: o.teamId,
      status: 'active',
      effect: 'percent_off',
      percent: 10,
      currency: o.currency ?? 'CHF',
      valid_from: null,
      valid_until: null,
      max_uses: 100,
      max_uses_per_contact: 1,
      restrict_to_contact_id: null,
      // 'new_contacts' would narrow the demo to people with no `joined` — the
      // broad code is the one a prospect can actually try in the shop.
      audience: 'all',
      usage_count: 0,
      // Every rail a promo is allowed on. Memberships, gift-card purchases, the
      // priced-trial door and the waitlist claim are NOT rails — the claim path
      // refuses one server-side, because shortening its deadline would give one
      // seat two timers.
      applies_to: ['drop_in', 'appointment', 'course', 'product'],
      activity_ids: null,
      course_ids: null,
      product_ids: null,
      label: 'Seeded demo code',
      created_at: tsOf(daysAgo(installedDaysAgo)),
      updated_at: tsOf(daysAgo(installedDaysAgo)),
      created_by: o.uid,
      created_by_name: 'Seed',
      disabled_at: null,
    })
}

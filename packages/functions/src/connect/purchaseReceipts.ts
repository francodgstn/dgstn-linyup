/* eslint-disable no-console */
/**
 * THE RECEIPTS FOR A SHOP PURCHASE — credit pack, membership, course, product —
 * and every one of them is ALWAYS ON.
 *
 * NOT behind a `SystemEmailKey`, and that is the same rule
 * `booking/paidConfirmation.ts` states for a paid class booking, inherited here
 * rather than re-argued. The test comes from `booking/waitlist/notify.ts`:
 * always on, because switching it off does not quieten the feature, it BREAKS
 * it. Three rails failed that test before UX-77:
 *
 *   • A CREDIT PACK is the starkest. Someone buys ten classes and the only place
 *     the number ten exists is a member area nobody told them about. Switching
 *     this off would leave a buyer holding a balance they cannot see and do not
 *     know how to spend.
 *   • A COURSE buyer is told nothing about WHERE TO WATCH the thing they bought.
 *     Stripe's receipt names a charge; it cannot name the Space.
 *   • A PRODUCT buyer gets no word of what happens next, and the studio's
 *     fulfillment is entirely manual — so silence here means silence everywhere.
 *
 * A studio may reasonably run its own courtesy confirmations from the
 * automations engine, which is why the FREE booking path keeps
 * `booking_confirmation` as a switch. Money is different: a receipt is not a
 * preference. Free-is-switchable / paid-is-not is the design across every rail —
 * see `utils/systemEmails.ts`, which owns the census of what sits outside the
 * toggles and why. (UX-77, following UX-76's call of 2026-08-17.)
 *
 * IDEMPOTENT, through the `mail_sends` ledger, keyed per TENDER exactly as the
 * booking receipt is: the Connect webhook is redelivered by Stripe, and the
 * gift-card full-cover branches are callables a client can retry. The key
 * carries the PaymentIntent id (or the gift-card hold key), so a redelivery is
 * deduped while a genuinely separate second purchase keys differently and mails.
 *
 * NOTHING HERE THROWS. The money has already moved and the entitlement is
 * already granted before any of these is called; a mail provider outage must not
 * become a webhook 5xx that makes Stripe re-run the grant logic.
 */
import * as admin from 'firebase-admin'
import type { Timestamp } from 'firebase-admin/firestore'
import {
  ACTIVITIES_COLLECTION,
  CONTACTS_COLLECTION,
  CONTACT_CREDIT_GRANTS_SUBCOLLECTION,
  COURSES_COLLECTION,
  PRODUCTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  gatedPlanIds,
  localizedPublicUrl,
  localizedPublicSubUrl,
  resolveProductCollectionNote,
} from '@linyup/shared'
import { sendEmail } from '../utils/email'
import { getHostingUrl } from '../utils/env'
import { getTeamContactEmail } from '../mail/senderConfig'
import {
  buildCourseReceiptEmail,
  buildCreditPackReceiptEmail,
  buildMembershipReceiptEmail,
  buildProductReceiptEmail,
  type Lang,
  type PaidAmount,
} from './purchaseTemplates'

const isLang = (v: unknown): v is Lang => v === 'en' || v === 'de' || v === 'fr' || v === 'it'

interface TeamContext {
  name: string
  slug: string | null
  lang: Lang
  data: Record<string, unknown>
}

async function loadTeam(teamId: string): Promise<TeamContext | null> {
  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()
  const data = snap.data()
  if (!data) return null
  return {
    name: (data.name as string) || 'the studio',
    slug: (data.slug as string | undefined) ?? null,
    lang: isLang(data.language) ? data.language : 'en',
    data: data as Record<string, unknown>,
  }
}

interface Recipient {
  firstname: string
  email: string
}

/** The buyer's name + address. The CONTACT is preferred over whatever Stripe
 *  collected: a login-first checkout may have been made by a parent for a child,
 *  and the contact document is the one the entitlement was written to. The
 *  checkout email is the fallback for the legacy anonymous shape. */
async function loadRecipient(contactId: string, fallbackEmail?: string | null): Promise<Recipient> {
  const snap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId).get()
  const c = snap.data() ?? {}
  return {
    firstname: ((c.firstname as string | undefined) ?? '').trim(),
    email: ((c.email as string | undefined) ?? fallbackEmail ?? '').trim(),
  }
}

/** Locale-pinned, always: a receipt is written in the studio's language, so the
 *  page it opens must answer in the same one (see the note above
 *  `localizedPublicUrl` in @linyup/shared). The default locale stays unprefixed,
 *  so an English studio's links are byte-identical to before. */
function spaceUrlFor(slug: string | null, lang: Lang): string | null {
  return slug ? localizedPublicUrl(getHostingUrl(), lang, slug, 'space') : null
}

// ─── 1. Credit pack / membership ──────────────────────────────────────────────

export interface MembershipPurchaseReceiptParams {
  teamId: string
  contactId: string
  /** Keys the `mail_sends` ledger: the PaymentIntent id, or the Checkout Session
   *  id when a subscription-mode session carries no intent of its own. */
  tenderRef: string
  /** The credit grant this purchase wrote, when it wrote one. Doc id under
   *  contacts/{id}/credit_grants — the SAME id `applyCreditGrant` used, which on
   *  this rail is the PaymentIntent id. */
  creditGrantId?: string | null
  planName: string
  recurring: boolean
  validUntil?: Date | null
  paid?: PaidAmount | null
  /** The plan's intro offer, ALREADY checked against the first charge by the
   *  caller (`introReceiptTerms` in connect/webhook.ts). It carries its own
   *  currency because a FREE intro produces no charge, so `paid` is null and
   *  there is nothing to borrow one from. */
  intro?: {
    periods: number
    amount: number
    fullAmount: number
    recurrence: string
    currency: string
  } | null
  /** These credits were GIVEN rather than bought (the `grantCredits` desk rail).
   *  Only reaches the credit-pack body, which is the only one whose copy thanks
   *  the reader for a purchase. Ignored when the sale carried no credits. */
  granted?: boolean
  fallbackEmail?: string | null
}

/**
 * The receipt for a membership purchase — which is a CREDIT PACK whenever the
 * price carried credits, and a plain membership otherwise. One entry point
 * because one checkout produces one or the other and the caller should not have
 * to know which; the shape is decided here, by whether the grant exists.
 */
export async function sendMembershipPurchaseReceipt(
  p: MembershipPurchaseReceiptParams
): Promise<void> {
  try {
    const team = await loadTeam(p.teamId)
    if (!team) {
      console.error(`[connect] purchase receipt: team ${p.teamId} missing — nothing sent`)
      return
    }
    const recipient = await loadRecipient(p.contactId, p.fallbackEmail)
    if (!recipient.email) {
      console.error(
        `[connect] membership purchase by contact ${p.contactId} has no email address — no receipt sent`
      )
      return
    }
    const spaceUrl = spaceUrlFor(team.slug, team.lang)

    // THE NUMBER COMES FROM THE GRANT THAT WAS JUST WRITTEN, never from
    // `Contact.credit_summary`. That rollup is maintained by the
    // onCreditGrantWrite trigger and is eventually consistent — reading it here
    // would report a stale balance in the one mail whose entire job is the
    // balance. `applyCreditGrant` has already written (or already found) this
    // exact document earlier in the same handler, keyed on the PaymentIntent, so
    // the number read here is the number that was bought — no trigger involved.
    const grant = p.creditGrantId
      ? (
          await admin
            .firestore()
            .collection(CONTACTS_COLLECTION)
            .doc(p.contactId)
            .collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)
            .doc(p.creditGrantId)
            .get()
        ).data()
      : null
    const credits = (grant?.credits_total as number | undefined) ?? 0

    const mail =
      credits > 0
        ? buildCreditPackReceiptEmail({
            firstname: recipient.firstname,
            teamName: team.name,
            packName: (grant?.subscription_type_name as string | undefined) || p.planName,
            credits,
            expiresAt: (grant?.expires_at as Timestamp | null | undefined)?.toDate() ?? null,
            activityNames: await activitiesCoveredBy(
              p.teamId,
              (grant?.subscription_type_id as string | undefined) ?? null
            ),
            paid: p.paid ?? null,
            granted: p.granted ?? false,
            spaceUrl,
            lang: team.lang,
          })
        : buildMembershipReceiptEmail({
            firstname: recipient.firstname,
            teamName: team.name,
            planName: p.planName,
            recurring: p.recurring,
            validUntil: p.validUntil ?? null,
            paid: p.paid ?? null,
            intro: p.intro ?? null,
            spaceUrl,
            lang: team.lang,
          })

    await sendEmail({
      to: recipient.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      teamId: p.teamId,
      tags: [credits > 0 ? 'credit-pack-receipt' : 'membership-receipt'],
      idempotencyKey: `purchase-membership-${p.contactId}-${p.tenderRef}`,
    })
  } catch (err) {
    console.error(
      `[connect] membership purchase receipt failed (team=${p.teamId} contact=${p.contactId}):`,
      err
    )
  }
}

/**
 * The activities a credit pack can actually be spent on — the classes whose
 * access rule names this subscription type. Empty when the pack is unscoped, the
 * query fails, or nothing references it, and the copy then stays general rather
 * than claiming a scope it could not verify.
 *
 * Read as one `teamId` query and filtered in memory ON PURPOSE: it needs no
 * composite index, a studio's activity list is small, and this runs once per
 * purchase. Best-effort — a receipt that names no classes is far better than a
 * receipt that does not go out.
 */
async function activitiesCoveredBy(
  teamId: string,
  subscriptionTypeId: string | null
): Promise<string[]> {
  if (!subscriptionTypeId) return []
  try {
    const snap = await admin
      .firestore()
      .collection(ACTIVITIES_COLLECTION)
      .where('teamId', '==', teamId)
      .get()
    const names = snap.docs
      .filter((d) => {
        const a = d.data()
        // Nothing the buyer cannot actually book: an archived or deactivated
        // activity in this list would read as a promise the timetable does not
        // keep. (`isActive` absent ⇒ active, as everywhere else.)
        if (a.archived_at || a.isActive === false) return false
        // The plans that INCLUDE the class (docs/class-access-derived.md) —
        // `gatedPlanIds` reads the modern list and a legacy `subscription` one
        // alike; an appointment has none.
        return gatedPlanIds({ type: a.type, accessRule: a.accessRule, isFreeTrial: a.isFreeTrial } as never).includes(subscriptionTypeId)
      })
      .map((d) => (d.data().name as string | undefined) ?? '')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
    // Capped: a pack that unlocks the whole timetable should not print the whole
    // timetable — past a handful the list stops being information.
    return names.length > 6 ? [] : names
  } catch (err) {
    console.warn(`[connect] credit pack scope lookup failed (team=${teamId}):`, err)
    return []
  }
}

// ─── 2. Course ────────────────────────────────────────────────────────────────

export interface CoursePurchaseReceiptParams {
  teamId: string
  contactId: string
  courseId: string
  /** Checkout metadata's title, used when the course document cannot be read. */
  courseTitle?: string | null
  tenderRef: string
  paid?: PaidAmount | null
  fallbackEmail?: string | null
}

export async function sendCoursePurchaseReceipt(p: CoursePurchaseReceiptParams): Promise<void> {
  try {
    const team = await loadTeam(p.teamId)
    if (!team) {
      console.error(`[connect] course receipt: team ${p.teamId} missing — nothing sent`)
      return
    }
    const recipient = await loadRecipient(p.contactId, p.fallbackEmail)
    if (!recipient.email) {
      console.error(
        `[connect] course purchase by contact ${p.contactId} has no email address — no receipt sent`
      )
      return
    }

    const courseSnap = await admin
      .firestore()
      .collection(COURSES_COLLECTION)
      .doc(p.courseId)
      .get()
    const course = courseSnap.data()
    const title = (course?.title as string | undefined) || p.courseTitle || 'Course'
    const courseSlug = (course?.slug as string | undefined) ?? null
    const spaceUrl = spaceUrlFor(team.slug, team.lang)
    // The deep link the Space itself uses (`/public/{slug}/space/courses/{slug}`)
    // — "where to watch it" means the course, not the lobby. Falls back to the
    // Space root for a course with no slug.
    const watchUrl =
      team.slug && courseSlug
        ? localizedPublicSubUrl(getHostingUrl(), team.lang, team.slug, 'space', [
            'courses',
            courseSlug,
          ])
        : spaceUrl

    const mail = buildCourseReceiptEmail({
      firstname: recipient.firstname,
      teamName: team.name,
      courseTitle: title,
      paid: p.paid ?? null,
      watchUrl,
      spaceUrl,
      lang: team.lang,
    })

    await sendEmail({
      to: recipient.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      teamId: p.teamId,
      tags: ['course-purchase-receipt'],
      idempotencyKey: `purchase-course-${p.courseId}-${p.contactId}-${p.tenderRef}`,
    })
  } catch (err) {
    console.error(
      `[connect] course purchase receipt failed (team=${p.teamId} course=${p.courseId}):`,
      err
    )
  }
}

// ─── 3. Product ───────────────────────────────────────────────────────────────

export interface ProductPurchaseReceiptParams {
  teamId: string
  contactId: string
  /** "Hoodie · XL" — already assembled by the caller, which is the same label it
   *  writes to the activity log and the payment line item. */
  itemLabel: string
  /** The product sold, when the caller knows which one. Used ONLY to look up its
   *  collection note (UX-79); absent ⇒ the team default still applies, because a
   *  studio that answered "how do I get it?" once should not have that answer
   *  disappear on a rail that lost the id. */
  productId?: string | null
  tenderRef: string
  paid?: PaidAmount | null
  fallbackEmail?: string | null
}

/**
 * The studio's answer to "how do I get it?" — the product's own note, else the
 * team default, else null (and then the body falls back to its generic line).
 *
 * Resolved through the SHARED `resolveProductCollectionNote`, the same function
 * the shop card and the checkout modal call, so a buyer cannot be shown one
 * sentence before paying and a different one after. Best-effort: a failed read
 * degrades to the team default rather than dropping the whole receipt.
 */
async function collectionNoteFor(
  teamId: string,
  productId: string | null | undefined,
  teamData: Record<string, unknown>
): Promise<string | null> {
  const teamDefault = (
    (teamData.settings as { productCollectionNote?: string } | undefined)?.productCollectionNote ??
    ''
  ).trim()
  if (!productId) return resolveProductCollectionNote(null, teamDefault)
  try {
    const snap = await admin
      .firestore()
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(PRODUCTS_SUBCOLLECTION)
      .doc(productId)
      .get()
    return resolveProductCollectionNote(
      { collectionNote: snap.data()?.collectionNote as string | undefined },
      teamDefault
    )
  } catch (err) {
    console.warn(`[connect] collection note lookup failed (team=${teamId} product=${productId}):`, err)
    return resolveProductCollectionNote(null, teamDefault)
  }
}

export async function sendProductPurchaseReceipt(p: ProductPurchaseReceiptParams): Promise<void> {
  try {
    const team = await loadTeam(p.teamId)
    if (!team) {
      console.error(`[connect] product receipt: team ${p.teamId} missing — nothing sent`)
      return
    }
    const recipient = await loadRecipient(p.contactId, p.fallbackEmail)
    if (!recipient.email) {
      console.error(
        `[connect] product purchase by contact ${p.contactId} has no email address — no receipt sent`
      )
      return
    }

    const mail = buildProductReceiptEmail({
      firstname: recipient.firstname,
      teamName: team.name,
      itemLabel: p.itemLabel,
      paid: p.paid ?? null,
      // HOW TO GET IT (UX-79) — the studio's own words when it has any. Absent,
      // the body keeps saying only what is true: handover is arranged directly.
      collectionNote: await collectionNoteFor(p.teamId, p.productId, team.data),
      // The studio's published address, so "ask them" names somebody. Absent ⇒
      // the copy falls back to "reply to this email", which the Managed sender's
      // Reply-To makes true.
      teamEmail: (await getTeamContactEmail(p.teamId, team.data)) ?? null,
      spaceUrl: spaceUrlFor(team.slug, team.lang),
      lang: team.lang,
    })

    await sendEmail({
      to: recipient.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      teamId: p.teamId,
      tags: ['product-purchase-receipt'],
      idempotencyKey: `purchase-product-${p.contactId}-${p.tenderRef}`,
    })
  } catch (err) {
    console.error(
      `[connect] product purchase receipt failed (team=${p.teamId} contact=${p.contactId}):`,
      err
    )
  }
}

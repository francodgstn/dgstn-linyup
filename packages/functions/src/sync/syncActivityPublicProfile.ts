// Keeps activities/{activityId}/public_profile/{activityId} in sync
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import {
  normalizeActivityTags,
  resolveActivityAccessRule,
  resolveActivityDropIn,
  resolveDurationSale,
  studioDropInOf,
  type ActivityAccessRule,
  type ActivityDropIn,
  type ActivityType,
  type DropInPrice,
} from '@linyup/shared'
import { touchTeamForSurfaceRecompute } from '../utils/plugins'
import { loadBookingSettings } from '../booking/bookingSettings'

// An APPOINTMENT activity is half of what makes the appointment picker live
// (`ActivePublicSurfaces.appointments`), and that flag is computed by the
// team-document sync — which an activity write does not trigger. Same nudge the
// forms/courses/documents syncs use, and narrowed to appointment activities on
// either side of the write so editing a class never touches the team document.
async function touchIfAppointmentActivity(
  before: FirebaseFirestore.DocumentData | undefined,
  after: FirebaseFirestore.DocumentData | undefined
): Promise<void> {
  const teamId = (after?.teamId ?? before?.teamId) as string | undefined
  if (!teamId) return
  if (before?.type !== 'appointment' && after?.type !== 'appointment') return
  await touchTeamForSurfaceRecompute(teamId)
}


/**
 * The mirror document for one activity — PURE, so the studio-default fan-out
 * (`syncStudioDropIn`) can rebuild a class's mirror without a write to the
 * activity itself.
 *
 * `studioDropIn` is the studio's default drop-in price (`BookingSettings.dropIn`
 * narrowed by `studioDropInOf`). The mirror carries the RESOLVED price — the
 * class's own, or the studio's when the class follows it — so every public
 * reader keeps reading `dropIn: { enabled, priceAmount }` and none has to know
 * a default exists.
 */
export function buildActivityPublicProfile(
  data: FirebaseFirestore.DocumentData,
  studioDropIn: DropInPrice | null
): Record<string, unknown> {
  // THE ONE READER (shared/utils/dropIn.ts). An appointment resolves to none.
  const dropIn = resolveActivityDropIn(
    {
      type: data.type as ActivityType | undefined,
      accessRule: data.accessRule as ActivityAccessRule | undefined,
      isFreeTrial: data.isFreeTrial as boolean | undefined,
      dropIn: data.dropIn as ActivityDropIn | undefined,
    },
    studioDropIn
  )

  return {
    type: 'activity',
    teamId: data.teamId,
    // Session category ('class' | 'appointment') so public UIs can route
    // appointment activities to the appointment flow instead of the class slot picker.
    activityType: data.type === 'appointment' ? 'appointment' : 'class',
    name: data.name || '',
    description: data.description || '',
    slug: data.slug || '',
    color: data.color || null,
    image_url: data.image_url || null,
    // Denormalised display order so public consumers sort like the admin list.
    order: typeof data.order === 'number' ? data.order : null,
    isFreeTrial: data.isFreeTrial || false,
    // Free-text display labels for the public cards. Normalised here as well as
    // in the editor — the mirror is the copy the world reads, and an activity
    // written by anything other than that form still has to arrive tidy.
    ...(Array.isArray(data.tags) && data.tags.length
      ? { tags: normalizeActivityTags(data.tags) }
      : {}),
    // Denormalised access gate so the public booking UI can render lock badges.
    // CLASS-ONLY: appointments have no access gate (the price is the gate) —
    // mirroring a resolved rule for them would resurrect a phantom {type:'open'}.
    ...(data.type !== 'appointment'
      ? { accessRule: resolveActivityAccessRule({ accessRule: data.accessRule, isFreeTrial: data.isFreeTrial }) }
      : {}),
    // The RESOLVED drop-in price, so the booking UI can offer pay-per-class —
    // present only when there is a price to charge.
    ...(dropIn.enabled ? { dropIn: { enabled: true, priceAmount: dropIn.priceAmount } } : {}),
    // CLASS-ONLY trial door: without this the public booking flow can't OFFER
    // the trial the admin toggled on — the promise "even when members-only"
    // needs the mirror to carry it.
    ...(data.type !== 'appointment' && data.trialEnabled === true ? { trialEnabled: true } : {}),
    // CLASS-ONLY paid-trial price — mirrored only alongside a live trial door
    // (same conditional style as trialEnabled above). Absent ⇒ the trial stays
    // FREE, today's behaviour untouched.
    ...(data.type !== 'appointment' &&
    data.trialEnabled === true &&
    typeof data.trialPriceAmount === 'number'
      ? { trialPriceAmount: data.trialPriceAmount }
      : {}),
    // CLASS-ONLY waitlist door — the mirror is the ONLY way the public booking
    // form learns a full slot has a queue behind it (the session mirror
    // deliberately carries no copy of the flag; see Session.waitlist_count).
    ...(data.type !== 'appointment' && data.waitlistEnabled === true
      ? { waitlistEnabled: true }
      : {}),
    // Appointment duration menu with base prices so public cards can show
    // "from CHF 45". Mirrored verbatim — no per-contact data to strip any more
    // (the old subscriptionPricing matrix is gone).
    ...(data.type === 'appointment' && Array.isArray(data.durations) && data.durations.length
      ? {
          durations: data.durations.map(
            (d: { minutes: number; priceAmount?: number | null; benefitOnly?: boolean }) => {
              // Through `resolveDurationSale`, so a benefit_only length mirrors
              // with NO price at all: a stale amount left by a mode switch must
              // never reach a public card as a sellable figure (UX-70).
              const sale = resolveDurationSale(d)
              return {
                minutes: d.minutes,
                priceAmount: sale.priceAmount,
                ...(sale.mode === 'benefit_only' ? { benefitOnly: true } : {}),
              }
            }
          ),
        }
      : {}),
    // The one member-benefit rule, mirrored verbatim — public-safe, since the
    // referenced subscription-type ids are already public in the shop.
    // Appointments: applies to every priced duration. Classes: the member rate
    // on the drop-in price — only meaningful (and only mirrored) alongside a
    // live, priced drop-in.
    // BOTH HALVES OR NEITHER, on an appointment. `resolveDurationBenefit` reads
    // the PRESENCE of `durationBenefits` to decide whether the activity-wide
    // rule still applies, so mirroring one without the other makes the public
    // picker quote from a rule the server has already stopped honouring.
    ...(data.type === 'appointment' && data.memberBenefit
      ? { memberBenefit: data.memberBenefit }
      : {}),
    ...(data.type === 'appointment' && data.durationBenefits
      ? { durationBenefits: data.durationBenefits }
      : {}),
    ...(data.type !== 'appointment' && data.memberBenefit && dropIn.enabled
      ? { memberBenefit: data.memberBenefit }
      : {}),
    // Display-only prerequisites shown on the public booking pages.
    prerequisites: data.prerequisites || null,
    // Display-only rich detail (meeting point, what's included/not, FAQ) —
    // answers the pre-booking questions the visitor would otherwise email in
    // for. Same for classes and appointments.
    meetingPoint: data.meetingPoint || null,
    whatsIncluded: data.whatsIncluded || null,
    whatsNotIncluded: data.whatsNotIncluded || null,
    faq: data.faq || null,
    // Per-activity cancellation policy override — falls back to the team-wide
    // default (TeamPublicProfile.bookingCancellationPolicy) when absent.
    cancellationPolicy: data.cancellationPolicy || null,
    // Book-form questions. The QUESTIONS are public (the form has to render
    // them); the ANSWERS live on the booking and are never mirrored here.
    ...(Array.isArray(data.bookingQuestions) && data.bookingQuestions.length
      ? { bookingQuestions: data.bookingQuestions }
      : {}),
    // Contact fields the book form collects into the CONTACT. Public-safe: it
    // names fields, never values — and a `custom:` entry only renders if its
    // definition separately opted in via publicCustomFields on the team.
    ...(Array.isArray(data.contactFields) && data.contactFields.length
      ? { contactFields: data.contactFields }
      : {}),
  }
}

export const syncActivityPublicProfile = onDocumentWritten('activities/{activityId}', async (event) => {
  const { activityId } = event.params
  const afterRef = event.data!.after.ref

  await touchIfAppointmentActivity(event.data!.before.data(), event.data!.after.data())

  // Remove public profile when document is deleted or activity is deactivated
  if (!event.data!.after.exists || event.data!.after.data()?.isActive === false) {
    await afterRef.collection('public_profile').doc(activityId).delete()
    return
  }

  const data = event.data!.after.data()!

  // The studio default, for a class that follows it — one extra document read
  // per activity write. An appointment never needs it.
  const studioDropIn =
    data.type === 'appointment' || !data.teamId
      ? null
      : studioDropInOf(await loadBookingSettings(data.teamId as string))

  await afterRef
    .collection('public_profile')
    .doc(activityId)
    .set(buildActivityPublicProfile(data, studioDropIn))
})

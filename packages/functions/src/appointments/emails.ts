/* eslint-disable no-console */
/**
 * Appointment booking emails (confirmation + .ics + coach notification) — moved
 * out of window.ts so the Connect webhook can import it without pulling in the
 * onCall modules (listAvailability/bookAppointment).
 *
 * THE CONFIRMATION'S GATE IS SPLIT BY TENDER, and that asymmetry IS THE DESIGN —
 * the same one `booking/paidConfirmation.ts` states for a class, so do not tidy
 * the two arms into one flag:
 *
 *   • A FREE appointment's confirmation is a COURTESY, so it stays behind
 *     `booking_confirmation`. A studio may reasonably send its own from the
 *     automations engine instead.
 *   • A PAID one is the RECEIPT, and it is ALWAYS ON. It carries the .ics, the
 *     cancel link and the only description of what was bought; Stripe's own
 *     receipt names a charge, not an appointment — no what, no when, no where,
 *     no cancellation terms. Switching it off would not quieten the feature, it
 *     would strand somebody who has already been charged, which is the test
 *     `booking/waitlist/notify.ts` applies to the offer and join mails.
 *
 * WHY THE CALLER ANSWERS, and not this function. `wasPaidFor` is a parameter
 * rather than a lookup because the fact lives with whoever settled the booking:
 * the webhook knows Stripe just paid, the staff callable knows cash was taken
 * over the counter (which no field on the booking document records), and the
 * public free path knows it refused every payable caller. Re-deriving it here
 * would mean reading the payment state a SECOND time, from a document the caller
 * has just written — the classic way two answers to one question drift apart.
 * (UX-77, extending UX-76's rule to the appointment rail.)
 */
import * as admin from 'firebase-admin'
import { sendEmail } from '../utils/email'
import { systemEmailEnabledFor } from '../utils/systemEmails'
import { to } from '../utils/async'
import type { Lang } from './booking'
import {
  buildAppointmentConfirmationEmail,
  buildAppointmentICalAttachment,
  buildAppointmentProviderNotificationEmail,
} from './templates'

export async function sendAppointmentBookingEmails(p: {
  teamId: string
  teamName: string
  lang: Lang
  activityName: string
  providerId: string | null
  providerName: string
  start: Date
  end: Date
  location: string | null
  onlineUrl: string | null
  cancelUrl: string | null
  bookingId: string
  /** Did this appointment COST its holder money (or stored value)? True ⇒ the
   *  confirmation is a receipt and ignores the `booking_confirmation` toggle;
   *  false ⇒ it is a courtesy and obeys it. Every caller answers from the tender
   *  it just settled — see the module header, and `bookingWasPaidFor`
   *  (`@linyup/shared`) where the booking document itself carries the marker. */
  wasPaidFor: boolean
  client: { firstname: string; lastname: string; email: string; phone: string | null }
  /** A BASKET: every date booked together, each with its own booking id (its
   *  calendar entry) and cancel link. ONE confirmation lists them all (US-07),
   *  with one calendar invite per date. Absent for a one-date booking, which
   *  mails exactly as before. */
  dates?: { start: Date; end: Date; cancelUrl: string | null; bookingId: string }[]
}): Promise<void> {
  const basketDates = p.dates && p.dates.length > 1 ? p.dates : null
  let coachEmail: string | null = null
  let coachFirstname = 'Coach'
  if (p.providerId) {
    const [, coachDoc] = await to(admin.firestore().collection('users').doc(p.providerId).get())
    if (coachDoc?.exists) {
      coachEmail = coachDoc.get('email') || null
      coachFirstname = coachDoc.get('firstname') || 'Coach'
    }
  }

  // Paid short-circuits the toggle AND its team-document read — see the header.
  const confirmationEnabled =
    p.wasPaidFor || (await systemEmailEnabledFor(p.teamId, 'booking_confirmation'))
  if (confirmationEnabled) {
    try {
      const email = buildAppointmentConfirmationEmail({
        firstname: p.client.firstname,
        teamName: p.teamName,
        slotTitle: p.activityName,
        providerName: p.providerName,
        start: p.start,
        end: p.end,
        location: p.location,
        onlineUrl: p.onlineUrl,
        cancelUrl: p.cancelUrl,
        instructions: null,
        lang: p.lang,
        dates: basketDates,
      })
      const icals = (basketDates ?? [{ start: p.start, end: p.end, bookingId: p.bookingId }]).map((d, i) => {
        const ical = buildAppointmentICalAttachment({
          bookingId: d.bookingId,
          slotTitle: p.activityName,
          start: d.start,
          end: d.end,
          location: p.location,
          providerName: p.providerName,
          coachEmail: coachEmail || 'noreply@linyup.com',
          clientName: `${p.client.firstname} ${p.client.lastname}`,
          clientEmail: p.client.email,
        })
        // One file per date, each its own name so a mail client keeps them apart.
        return basketDates ? { ...ical, filename: `appointment-${i + 1}.ics` } : ical
      })
      const subjects: Record<Lang, string> = {
        en: `Appointment Confirmed – ${p.activityName}`,
        de: `Termin bestätigt – ${p.activityName}`,
        fr: `Rendez-vous confirmé – ${p.activityName}`,
        it: `Appuntamento confermato – ${p.activityName}`,
      }
      await sendEmail({
        to: p.client.email,
        subject: subjects[p.lang],
        html: email.html,
        text: email.text,
        teamId: p.teamId,
        attachments: icals.map((ical) => ({
          filename: ical.filename,
          content: ical.content,
          contentType: ical.contentType,
        })),
      })
    } catch (err) {
      console.error('appointment emails: confirmation email failed', err)
    }
  }

  if (coachEmail) {
    try {
      const notif = buildAppointmentProviderNotificationEmail({
        coachFirstname,
        clientName: `${p.client.firstname} ${p.client.lastname}`,
        clientEmail: p.client.email,
        clientPhone: p.client.phone,
        slotTitle: p.activityName,
        start: p.start,
        end: p.end,
        notes: null,
        lang: p.lang,
        dates: basketDates,
      })
      const subjects: Record<Lang, string> = {
        en: `New appointment: ${p.client.firstname} ${p.client.lastname}`,
        de: `Neuer Termin: ${p.client.firstname} ${p.client.lastname}`,
        fr: `Nouveau rendez-vous : ${p.client.firstname} ${p.client.lastname}`,
        it: `Nuovo appuntamento: ${p.client.firstname} ${p.client.lastname}`,
      }
      await sendEmail({
        to: coachEmail,
        subject: subjects[p.lang],
        html: notif.html,
        text: notif.text,
        teamId: p.teamId,
      })
    } catch (err) {
      console.error('appointment emails: coach notification failed', err)
    }
  }
}

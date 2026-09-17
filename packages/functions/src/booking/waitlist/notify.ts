/* eslint-disable no-console */
// Telling the person. Every other file in this folder moves a seat; this is the
// half that makes a moved seat mean anything.
//
// It is a module of its own, and not a few lines inside the promoter, for one
// reason: the offer is minted INSIDE a transaction. Mail sent from inside a
// transaction is mail sent for a commit that may still fail — and sent again on
// every retry. So the promoter returns its offers and the send happens after the
// commit, exactly once (see `offerWaitlistSeatsAndNotify`).
//
// NOTHING HERE THROWS. A seat that was genuinely held must not report failure to
// the coach who pressed "Offer now", and a provider outage must not poison the
// write that freed the seat. Every failure is logged and swallowed — the queue
// re-derives itself from storage on the next pass, but a mail is not retried,
// which is precisely why the failures are logged loudly.
//
// It does, however, REPORT. `notifyWaitlistOffers` returns the offers it could
// not deliver, because "the mail was not sent" and "the seat is held" are the
// same fact seen from two sides: an offer nobody was told about is a seat taken
// off the day sheet, hidden from every booking callable, that expires in silence
// — and since an entry is offered once ever, the person is dropped from the
// queue having never been reachable. The caller (`offerWaitlistSeatsAndNotify`)
// gives those seats straight back and rolls them on.

import * as admin from 'firebase-admin'
import type { Timestamp } from 'firebase-admin/firestore'
import { ACTIVITIES_COLLECTION, SESSIONS_COLLECTION, localizedPublicUrl } from '@linyup/shared'
import {
  buildWaitlistExpiredEmail,
  buildWaitlistJoinedEmail,
  buildWaitlistOfferEmail,
  buildWaitlistOfferSms,
} from '../templates'
import { sendEmail } from '../../utils/email'
import { getHostingUrl } from '../../utils/env'
import { isWithinSmsSendingHours, sendSms } from '../../utils/sms'
import { systemEmailEnabledFor } from '../../utils/systemEmails'
import { getTeam } from '../../utils/teams'
import { offerWasDelivered } from './constants'
import type { WaitlistOffer } from './promote'

type Lang = 'en' | 'de' | 'fr' | 'it'
const isLang = (v: unknown): v is Lang => v === 'en' || v === 'de' || v === 'fr' || v === 'it'

/** Everything the three templates need about the class and the studio sending
 *  the mail. Resolved once per session, not once per recipient. */
interface WaitlistMailContext {
  teamName: string
  slug: string | null
  lang: Lang
  activityName: string
  sessionStart: Date
  sessionEnd: Date
  locationName: string | null
}

/**
 * The `mail_sends` ledger key for one waitlist mail.
 *
 * Keyed per EVENT, not per person-and-class. Leaving (or letting an offer lapse)
 * and re-joining writes a genuinely fresh entry for the same session+contact
 * pair, with a new token and — later — a new offer, so a
 * `waitlist-offer-{session}-{contact}` key would silently dedupe the SECOND
 * round's mail and hand that person a held seat nobody told them about. That is
 * the exact silence this module exists to end. The token pins it to the one
 * offer (or the one place in the queue) it belongs to, and still dedupes a
 * redelivered send of that same offer.
 *
 * Mail and SMS share ONE ledger collection, so the SMS variant carries the same
 * `sms-` prefix the reminder steps use, or the second channel would be skipped
 * as a duplicate of the first.
 */
function waitlistMailKey(
  kind: 'offer' | 'joined' | 'expired',
  sessionId: string,
  contactId: string,
  token: string
): string {
  return `waitlist-${kind}-${sessionId}-${contactId}${token ? `-${token.slice(0, 12)}` : ''}`
}

async function loadMailContext(
  teamId: string,
  sessionId: string
): Promise<WaitlistMailContext | null> {
  const db = admin.firestore()
  const [team, sessionSnap] = await Promise.all([
    getTeam(teamId),
    db.collection(SESSIONS_COLLECTION).doc(sessionId).get(),
  ])
  const session = sessionSnap.data()
  const start = session?.start as Timestamp | undefined
  if (!team || !start) return null

  // The denormalised name is what every other mail path uses; the activity read
  // is the fallback for sessions written before it was denormalised, and costs a
  // read only when it is missing.
  let activityName = (session?.activityName as string) || ''
  if (!activityName && session?.activityId) {
    const activitySnap = await db
      .collection(ACTIVITIES_COLLECTION)
      .doc(session.activityId as string)
      .get()
    activityName = (activitySnap.data()?.name as string) || ''
  }

  const end = session?.end as Timestamp | undefined
  return {
    teamName: team.name || 'Our Team',
    slug: team.slug || null,
    lang: isLang(team.language) ? team.language : 'en',
    activityName: activityName || 'Class',
    sessionStart: start.toDate(),
    sessionEnd: end ? end.toDate() : start.toDate(),
    locationName: (session?.location as string) || null,
  }
}

/**
 * Hand out the offers a promotion pass just committed.
 *
 * NOT behind `systemEmailEnabledFor`, and that is deliberate. The other system
 * mails are courtesies a studio may reasonably run itself from the automations
 * engine; this one carries the single-use claim token, and there is no
 * automation trigger that could replace it. A studio that switched it off would
 * mint offers nobody is told about — a held seat, removed from the day sheet and
 * from every booking callable, that expires in silence. Same posture as the
 * verification codes in `utils/systemEmails.ts`: always on, because switching it
 * off does not quieten the feature, it breaks it.
 *
 * SMS is the nudge on top, and only inside the sending window — a claim window
 * is time-critical, but not so critical that it may wake somebody at 03:00. The
 * offer's window is anchored to the same window opening (`resolveClaimWindow`),
 * so a seat freed at 23:10 is emailed immediately and stays claimable in the
 * morning. There is deliberately no deferred-SMS pass.
 *
 * RETURNS the offers that reached nobody — the caller releases those seats. A
 * send is only a delivery when the mail actually left: `sendEmail` does NOT
 * throw when a recipient is suppressed (an earlier hard bounce), when the
 * tenant's messaging policy is `silent`/`allowlist`, or when `MAIL_ENABLED` is
 * false — it returns `{ skipped: true }`, which used to be discarded here. The
 * one `skipped` that IS a delivery carries a `providerMessageId`: that is the
 * idempotent redelivery of a send that already went out. Same test as
 * `dailyTasks/sendBookingReminders`.
 */
export async function notifyWaitlistOffers(
  offers: readonly WaitlistOffer[]
): Promise<WaitlistOffer[]> {
  const undeliverable: WaitlistOffer[] = []
  if (offers.length === 0) return undeliverable

  // One promotion pass only ever touches one session; grouping makes that an
  // invariant of this code rather than of its callers, and keeps the context
  // reads at one per session however the caller batches.
  const bySession = new Map<string, WaitlistOffer[]>()
  for (const offer of offers) {
    const group = bySession.get(offer.sessionId)
    if (group) group.push(offer)
    else bySession.set(offer.sessionId, [offer])
  }

  const smsWindowOpen = isWithinSmsSendingHours(new Date())

  for (const [sessionId, group] of bySession) {
    let ctx: WaitlistMailContext | null = null
    try {
      ctx = await loadMailContext(group[0].teamId, sessionId)
    } catch (err) {
      console.error(`[waitlist] offer mail context failed for session ${sessionId}:`, err)
    }
    if (!ctx) {
      console.error(
        `[waitlist] ${group.length} seat(s) offered on session ${sessionId} could not be notified — no team/session context`
      )
      undeliverable.push(...group)
      continue
    }
    if (!ctx.slug) {
      // Unreachable in practice (joining goes through `/public/{slug}/…`), but a
      // held seat nobody can claim is the one outcome worth shouting about.
      console.error(
        `[waitlist] team ${group[0].teamId} has no slug — cannot build a claim link for session ${sessionId}`
      )
      undeliverable.push(...group)
      continue
    }

    for (const offer of group) {
      const claimUrl = localizedPublicUrl(getHostingUrl(), ctx.lang, ctx.slug, 'waitlist', {
        token: offer.offerToken,
      })
      const expiresAt = offer.offerExpiresAt.toDate()
      // The claim link travels by MAIL only — the SMS below says "check your
      // email" and carries no token — so the mail is what decides whether this
      // offer reached anybody at all.
      let delivered = false
      if (offer.email) {
        try {
          const { html, text } = buildWaitlistOfferEmail({
            firstname: offer.firstname,
            teamName: ctx.teamName,
            activityName: ctx.activityName,
            sessionStart: ctx.sessionStart,
            sessionEnd: ctx.sessionEnd,
            locationName: ctx.locationName,
            claimUrl,
            expiresAt,
            lang: ctx.lang,
          })
          const subjects: Record<Lang, string> = {
            en: `A place has opened up – ${ctx.activityName}`,
            de: `Ein Platz ist frei geworden – ${ctx.activityName}`,
            fr: `Une place s'est libérée – ${ctx.activityName}`,
            it: `Si è liberato un posto – ${ctx.activityName}`,
          }
          const outcome = await sendEmail({
            to: offer.email,
            subject: subjects[ctx.lang],
            html,
            text,
            teamId: offer.teamId,
            tags: ['waitlist-offer'],
            idempotencyKey: waitlistMailKey('offer', sessionId, offer.contactId, offer.offerToken),
          })
          delivered = offerWasDelivered(outcome)
          if (!delivered) {
            console.error(
              `[waitlist] offer mail to contact ${offer.contactId} on session ${sessionId} was not delivered (suppressed address, messaging policy, or mail disabled) — giving the seat back`
            )
          }
        } catch (err) {
          console.error(
            `[waitlist] offer mail to contact ${offer.contactId} on session ${sessionId} failed:`,
            err
          )
        }
      } else {
        // The join callable demands one, so an entry without an email was
        // written some other way — and the SMS below cannot carry the claim link.
        console.error(
          `[waitlist] contact ${offer.contactId} was offered a seat on session ${sessionId} but has no email address`
        )
      }

      if (!delivered) {
        // No SMS either: "check your email to claim it" pointing at a mail that
        // does not exist, for a seat this pass is about to hand back, is worse
        // than silence.
        undeliverable.push(offer)
        continue
      }

      if (!offer.phone || !smsWindowOpen) continue
      try {
        await sendSms({
          to: offer.phone,
          contactId: offer.contactId,
          content: buildWaitlistOfferSms({
            teamName: ctx.teamName,
            activityName: ctx.activityName,
            sessionStart: ctx.sessionStart,
            expiresAt,
            lang: ctx.lang,
          }),
          teamId: offer.teamId,
          tag: 'waitlist-offer',
          idempotencyKey: `sms-${waitlistMailKey('offer', sessionId, offer.contactId, offer.offerToken)}`,
        })
      } catch (err) {
        console.error(
          `[waitlist] offer SMS to contact ${offer.contactId} on session ${sessionId} failed:`,
          err
        )
      }
    }
  }

  return undeliverable
}

/**
 * "You're on the list" — sent from `joinWaitlist` once the place is committed.
 *
 * It carries the long-lived `entry_token` link, which is the ONLY way a guest
 * who closed the tab can see their position or leave the queue again: the
 * callable's response is otherwise the single copy of that token. Never a claim
 * credential — this mail gets forwarded.
 *
 * NOT behind `systemEmailEnabledFor` either, for the same reason the offer above
 * is not, and it took a second look to see it: this is not the courtesy it
 * resembles. `listMyWaitlist` needs a contact session, which a guest does not
 * have, so without this mail their place in the queue is one they can see once
 * and never leave — a studio that switched the toggle off would be trapping
 * people rather than quietening a mail. (The expiry notice below stays behind
 * the toggle: it carries nothing but news, and switching it off leaves nobody
 * stuck.)
 */
export async function notifyWaitlistJoined(params: {
  teamId: string
  sessionId: string
  contactId: string
  firstname: string
  email: string
  position: number
  entryToken: string
}): Promise<void> {
  const { teamId, sessionId, contactId, firstname, email, position, entryToken } = params
  if (!email) return
  try {
    const ctx = await loadMailContext(teamId, sessionId)
    if (!ctx) return
    const { html, text } = buildWaitlistJoinedEmail({
      firstname,
      teamName: ctx.teamName,
      activityName: ctx.activityName,
      sessionStart: ctx.sessionStart,
      sessionEnd: ctx.sessionEnd,
      locationName: ctx.locationName,
      position,
      statusUrl: ctx.slug
        ? localizedPublicUrl(getHostingUrl(), ctx.lang, ctx.slug, 'waitlist', { token: entryToken })
        : null,
      lang: ctx.lang,
    })
    const subjects: Record<Lang, string> = {
      en: `You're on the waitlist – ${ctx.activityName}`,
      de: `Sie stehen auf der Warteliste – ${ctx.activityName}`,
      fr: `Vous êtes sur la liste d'attente – ${ctx.activityName}`,
      it: `Sei in lista d'attesa – ${ctx.activityName}`,
    }
    await sendEmail({
      to: email,
      subject: subjects[ctx.lang],
      html,
      text,
      teamId,
      tags: ['waitlist-joined'],
      idempotencyKey: waitlistMailKey('joined', sessionId, contactId, entryToken),
    })
  } catch (err) {
    console.error(
      `[waitlist] join confirmation to contact ${contactId} on session ${sessionId} failed:`,
      err
    )
  }
}

/**
 * "Your place went to the next person" — sent when a claim window closes unused,
 * whether this codebase handed the seat back itself (`released`) or found the
 * hold already deleted by `expirePendingBookings` (`stale`). Never on a
 * self-heal: that person is IN the class.
 *
 * Closes the loop the offer mail opened. Without it the only signal is a claim
 * link that has stopped working, which reads as a bug rather than as a deadline.
 */
export async function notifyWaitlistOfferExpired(params: {
  teamId: string
  sessionId: string
  contactId: string
  firstname: string
  email: string
  /** The token of the offer that just lapsed — read off the entry BEFORE the
   *  release deleted it, and what keys this mail to that one offer. */
  offerToken: string
}): Promise<void> {
  const { teamId, sessionId, contactId, firstname, email, offerToken } = params
  if (!email) return
  try {
    if (!(await systemEmailEnabledFor(teamId, 'booking_confirmation'))) return
    const ctx = await loadMailContext(teamId, sessionId)
    if (!ctx) return
    // Past classes are closed out in bulk by the sweep's second pass; telling
    // somebody their offer lapsed for a class that has already run is noise.
    if (ctx.sessionStart.getTime() <= Date.now()) return
    const { html, text } = buildWaitlistExpiredEmail({
      firstname,
      teamName: ctx.teamName,
      activityName: ctx.activityName,
      sessionStart: ctx.sessionStart,
      rejoinUrl: ctx.slug
        ? localizedPublicUrl(getHostingUrl(), ctx.lang, ctx.slug, 'booking', { session: sessionId })
        : null,
      lang: ctx.lang,
    })
    const subjects: Record<Lang, string> = {
      en: `Your place was not claimed in time – ${ctx.activityName}`,
      de: `Ihr Platz wurde nicht rechtzeitig bestätigt – ${ctx.activityName}`,
      fr: `Votre place n'a pas été confirmée à temps – ${ctx.activityName}`,
      it: `Il tuo posto non è stato confermato in tempo – ${ctx.activityName}`,
    }
    await sendEmail({
      to: email,
      subject: subjects[ctx.lang],
      html,
      text,
      teamId,
      tags: ['waitlist-expired'],
      idempotencyKey: waitlistMailKey('expired', sessionId, contactId, offerToken),
    })
  } catch (err) {
    console.error(
      `[waitlist] expiry notice to contact ${contactId} on session ${sessionId} failed:`,
      err
    )
  }
}

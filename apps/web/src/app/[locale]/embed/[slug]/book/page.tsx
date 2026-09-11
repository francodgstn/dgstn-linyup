import type { Metadata } from 'next'
import { parseDateKey, parseDocId, parseSlug } from '@linyup/shared'
import EmbedBooking from './EmbedBooking'

// The booking funnel as a FRAMABLE panel, for a studio's own website.
//
// `/public/{slug}/booking` stays the canonical route — emails, QR codes, the
// bio-link and the Stripe return all still point there, and a visitor who opens
// this URL directly is sent to it (EmbedBooking). This route exists only so the
// SAME funnel can be framed: everything outside `/embed/*` sends
// `X-Frame-Options: DENY`, and a modal over someone else's page needs a document
// that is allowed to be framed (see proxy.ts).
//
// Lives directly under [locale] (NOT the (public) group) for the same reason the
// section embed does: no AnnouncementBar, no PublicReturnBar, no contact pill —
// the panel is the whole surface. The two providers the funnel does need are
// mounted by EmbedBooking itself.
//
// The static `book` segment wins over the sibling `[sectionId]`, and widget ids
// are `s-xxxxxxxxxx` (plugins/website/defaults.ts), so no widget can be shadowed.
export const dynamic = 'force-dynamic'

// A chrome-less duplicate of the booking page must not compete with it in search
// results; the panel is only ever meant to be opened inside a frame.
export const metadata: Metadata = { robots: { index: false, follow: false } }

interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<{
    session?: string
    activity?: string
    activityId?: string
    appointment?: string
    provider?: string
    date?: string
    referral?: string
  }>
}

export default async function EmbedBookingPage({ params, searchParams }: Props) {
  const { slug } = await params
  const sp = await searchParams
  // Every value here is attacker-supplied — this document is framable by ANY
  // site, so it is the most exposed entry the funnel has. Narrow before anything
  // reaches a Firestore path, exactly as the canonical route does.
  //
  // `activity` is the activity SLUG (the `/booking/{activitySlug}` path form)
  // and `activityId` its ID (`?activity=` on the canonical route). The two
  // public routes genuinely differ; embed.js maps each to its own name rather
  // than leaving this end to guess which it was given.
  return (
    <EmbedBooking
      slug={slug}
      session={parseDocId(sp.session)}
      activitySlug={parseSlug(sp.activity)}
      activityId={parseDocId(sp.activityId)}
      appointmentActivityId={parseDocId(sp.appointment)}
      providerId={parseDocId(sp.provider)}
      date={parseDateKey(sp.date)}
      referral={parseDocId(sp.referral)}
    />
  )
}

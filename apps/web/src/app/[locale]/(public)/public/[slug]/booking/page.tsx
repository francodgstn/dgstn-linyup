import { parseDateKey, parseDocId, parsePositiveInt, parsePublicFrom } from '@linyup/shared'
import BookingForm from './BookingForm'

export const dynamic = 'force-dynamic'

// The booking deep-link contract, read SERVER-side and handed down as props —
// same convention as ../appointments/page.tsx, so the client wizard needs no
// useSearchParams() and therefore no Suspense boundary.
//
// Precedence: session > activity > {activitySlug} path > single activity > picker.
// See `applyEntry` in BookingForm.
interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<{
    date?: string
    session?: string
    activity?: string
    provider?: string
    start?: string
    duration?: string
    referral?: string
    from?: string
  }>
}

export default async function BookingPage({ params, searchParams }: Props) {
  const { slug } = await params
  const { date, session, activity, provider, start, duration, referral, from } = await searchParams
  // Every value here is attacker-supplied (a malformed link sent to a victim).
  // Narrow BEFORE it reaches a Firestore path or the render tree; an unparseable
  // param degrades the deep link rather than breaking the page.
  return (
    <BookingForm
      slug={slug}
      initialDate={parseDateKey(date)}
      initialSession={parseDocId(session)}
      initialActivityId={parseDocId(activity)}
      initialProviderId={parseDocId(provider)}
      initialStartMs={parsePositiveInt(start)}
      initialDurationMinutes={parsePositiveInt(duration, 24 * 60)}
      referral={parseDocId(referral)}
      from={parsePublicFrom(from)}
    />
  )
}

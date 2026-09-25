/**
 * RETIRED — the catalog is where an activity is made, priced, linked and
 * archived now, and this page had become a second, thinner view of the same
 * records (Franco, 2026-09-02).
 *
 * A REDIRECT RATHER THAN A DELETION. Twenty-odd places link here — the pricing
 * page, the schedule, availability, the appointment dialog, an `/activities`
 * stub — and every studio that bookmarked it. Redirecting retires the surface
 * immediately while all of those keep working; the links can be repointed at
 * leisure, and none of them breaks in the meantime.
 *
 * `?tab=activities` so a bookmark lands on the list it used to show.
 */
import { redirect } from 'next/navigation'
import type { Route } from 'next'

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const path = '/manage/offer?tab=activities'
  redirect((locale === 'en' ? path : `/${locale}${path}`) as Route)
}

/**
 * RETIRED — see the note on the activities page. The catalog's Plans tab
 * holds the same list plus the prices, the usage limit and the activity
 * matcher, all of which this page could only link to.
 *
 * `?tab=affiliations` IS STILL HONORED, as it was before: this was a two-tab
 * hub, affiliations moved to their own destination, and that query string is in
 * bookmarks and in the /offer/affiliations stub. Sending it on beats landing
 * somebody on a list of plans they did not ask for.
 */
import { redirect } from 'next/navigation'
import type { Route } from 'next'

export const dynamic = 'force-dynamic'

export default async function PlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { locale } = await params
  const { tab } = await searchParams
  const path = tab === 'affiliations' ? '/affiliations' : '/manage/offer?tab=plans'
  redirect((locale === 'en' ? path : `/${locale}${path}`) as Route)
}

import { redirect } from 'next/navigation'
import type { Route } from 'next'
import { publicPath } from '@linyup/shared'
import { toQuery } from '@/lib/publicRoutes'

export const dynamic = 'force-dynamic'

// Back-compat shim: appointments are just booking now. One funnel asks which
// offer, and an appointment's times come from availability instead of from a
// session list, which is a different `when` rather than a different route.
//
// The query MUST ride through. Live links carry `?activity=`, `?provider=` and
// `?date=` (a clicked availability window names the coach and the day), the
// embed loader has been sending them for as long as it has existed, and a
// dropped param lands the visitor on the offer list being asked to choose
// again what they just clicked.
interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AppointmentsRedirectPage({ params, searchParams }: Props) {
  const { slug } = await params
  redirect(`${publicPath(slug, 'booking')}${toQuery(await searchParams)}` as Route)
}

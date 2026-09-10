import { notFound } from 'next/navigation'
import { parsePublicFrom } from '@linyup/shared'
import ContactUpdateForm from './ContactUpdateForm'
import ContactLinkForm from './ContactLinkForm'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ contactId?: string; from?: string; t?: string }>
}

export default async function ContactUpdatePage({ params, searchParams }: Props) {
  const { slug } = await params
  const { contactId, from, t } = await searchParams

  // TWO RAILS, and the token wins. `?t=` is a grant the studio just handed over
  // in person; `?contactId=` is the email-verification flow, which proves
  // ownership of an address before it edits anything. A URL carrying both is
  // not a combination anything mints, and honouring the token is the safe
  // reading of it: the token resolves its own contact server-side, so the id in
  // the query string is never consulted.
  if (t) return <ContactLinkForm token={t} />

  if (!contactId) notFound()

  return <ContactUpdateForm slug={slug} contactId={contactId} from={parsePublicFrom(from)} />
}

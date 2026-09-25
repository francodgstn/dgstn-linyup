'use client'

/**
 * WHERE THE FEDERATION IS, AND HOW TO REACH IT.
 *
 * Its own card rather than four more rows on the General one, which already
 * holds the name, the description and the authoring language — a form grows
 * until nobody reads it, and these four answer a different question from those
 * three.
 *
 * PUBLIC BY NATURE. A studio's address reaches its bio-link through its primary
 * place; an organization has no places of its own, so this is where its contact
 * section gets an address from. Nothing is shown that has not been filled in,
 * so an org that would rather not publish a street address simply leaves it
 * empty — there is no separate visibility switch to get wrong.
 */

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MapPin } from 'lucide-react'
import { ORGANIZATIONS_COLLECTION } from '@linyup/shared'
import type { Organization } from '@linyup/shared'

export function OrgContactDetailsCard({
  orgId,
  org,
  isAdmin,
  onSaved,
}: {
  orgId: string
  org: Organization | null | undefined
  isAdmin: boolean
  onSaved: (msg: string, type?: 'success' | 'error') => void
}) {
  const t = useTranslations('OrgSettings')
  const qc = useQueryClient()
  const [saving, setSaving] = useState(false)

  const [route, setRoute] = useState('')
  const [streetNumber, setStreetNumber] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [locality, setLocality] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [website, setWebsite] = useState('')

  useEffect(() => {
    const hq = org?.headquarters
    setRoute(hq?.route ?? '')
    setStreetNumber(hq?.street_number ?? '')
    setPostalCode(hq?.postal_code ?? '')
    setLocality(hq?.locality ?? '')
    setEmail(org?.contact_email ?? '')
    setPhone(org?.contact_phone ?? '')
    setWebsite(org?.contact_website ?? '')
  }, [org])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      // An EMPTY field clears its stored value rather than being skipped — this
      // is a full form the admin can see, not a booking payload arriving from
      // somewhere anonymous, so blanking a line here means "remove it".
      await updateDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId), {
        headquarters: {
          route: route.trim(),
          street_number: streetNumber.trim(),
          postal_code: postalCode.trim(),
          locality: locality.trim(),
        },
        contact_email: email.trim(),
        contact_phone: phone.trim(),
        contact_website: website.trim(),
      })
      qc.invalidateQueries({ queryKey: ['org', orgId] })
      onSaved(t('contactSaved'))
    } catch {
      onSaved(t('contactError'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="h-4 w-4" />
          {t('contactTitle')}
        </CardTitle>
        <CardDescription>{t('contactDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="org-hq-route">{t('hqStreetLabel')}</Label>
              <Input
                id="org-hq-route"
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                disabled={!isAdmin}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-hq-number">{t('hqNumberLabel')}</Label>
              <Input
                id="org-hq-number"
                value={streetNumber}
                onChange={(e) => setStreetNumber(e.target.value)}
                disabled={!isAdmin}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="org-hq-postal">{t('hqPostalLabel')}</Label>
              <Input
                id="org-hq-postal"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                disabled={!isAdmin}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-hq-locality">{t('hqLocalityLabel')}</Label>
              <Input
                id="org-hq-locality"
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
                disabled={!isAdmin}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="org-contact-email">{t('contactEmailLabel')}</Label>
            <Input
              id="org-contact-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('contactEmailPlaceholder')}
              disabled={!isAdmin}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="org-contact-phone">{t('contactPhoneLabel')}</Label>
              <Input
                id="org-contact-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={!isAdmin}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-contact-website">{t('contactWebsiteLabel')}</Label>
              <Input
                id="org-contact-website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder={t('contactWebsitePlaceholder')}
                disabled={!isAdmin}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t('contactHint')}</p>

          {isAdmin && (
            <Button type="submit" disabled={saving}>
              {saving ? '…' : t('saveButton')}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  )
}

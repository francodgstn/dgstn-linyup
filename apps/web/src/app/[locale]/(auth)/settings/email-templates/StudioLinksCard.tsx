'use client'

// The two BUILT-IN placeholders that have no value until the studio types one.
//
// Every other team token resolves itself — {{teamName}} from the team doc,
// {{bookingUrl}} / {{membershipUrl}} / {{bioLinkUrl}} from the slug. {{websiteUrl}}
// and {{reviewUrl}} are the exception: they point OUTSIDE Linyup (the studio's own
// site, its Google Business review page), so only the studio can supply them, and
// an unset one renders as an empty string — a review-request email that ships a
// dead "Leave a review" link and says nothing about it. The stock automation
// library uses {{reviewUrl}} in eight recipes, so that is not a hypothetical.
//
// They were settable in exactly ONE place: /team/bio-link, under "Social links",
// between Instagram and TikTok. A review link is not a social network and a studio
// that never built a bio link has no reason to open that page, so in practice the
// placeholder panel offered two tokens with nowhere to fill them in (Franco,
// 2026-09-20). This card is that nowhere, put where the tokens are offered.
//
// ── ONE FIELD, TWO EDITORS ───────────────────────────────────────────────────
// Both halves write `Team.socialLinks`, so this card and the bio-link form are
// two editors of one array — the ordinary last-write-wins shape, and the reason
// `onSave` below MERGES rather than replaces: it rewrites the `website` and
// `review` entries and leaves every other platform exactly as it found it. The
// bio-link page loads the team on mount, so the only way to lose an edit is to
// have had its form already open when this one saved.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { doc, updateDoc } from 'firebase/firestore'
import { Globe, Loader2, Star } from 'lucide-react'
import { db } from '@/lib/firebase'
import { TEAMS_COLLECTION, type SocialLink, type Team } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Empty, or an http(s) URL. The same guard the bio-link form applies, and for
 *  the same reason: these strings become an `href` on the public bio link and an
 *  anchor in outgoing mail, so `javascript:` / `data:` would be stored XSS. */
const SAFE_URL = /^https?:\/\/.+/

export function StudioLinksCard({ teamId, team }: { teamId: string; team: Team }) {
  const t = useTranslations('EmailSettings')
  const tc = useTranslations('Common')
  const qc = useQueryClient()

  const urlOf = (platform: 'website' | 'review') =>
    team.socialLinks?.find((l) => l.platform === platform)?.url ?? ''

  const [website, setWebsite] = useState('')
  const [review, setReview] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setWebsite(urlOf('website'))
    setReview(urlOf('review'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.socialLinks])

  const onSave = async () => {
    setError('')
    const entries: { platform: 'website' | 'review'; url: string }[] = [
      { platform: 'website', url: website.trim() },
      { platform: 'review', url: review.trim() },
    ]
    if (entries.some((e) => e.url && !SAFE_URL.test(e.url))) {
      setError(t('studioLinksInvalidUrl'))
      return
    }
    // MERGE, never replace — see the header. Everything that is not one of these
    // two platforms is carried through untouched, in its original order.
    const kept = (team.socialLinks ?? []).filter(
      (l) => l.platform !== 'website' && l.platform !== 'review'
    )
    const socialLinks: SocialLink[] = [...kept, ...entries.filter((e) => e.url)]

    setSaving(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { socialLinks })
      await qc.invalidateQueries({ queryKey: ['team', teamId] })
      await qc.invalidateQueries({ queryKey: ['team_for_templates', teamId] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const dirty = website.trim() !== urlOf('website') || review.trim() !== urlOf('review')

  return (
    <Card>
      <CardContent className="pt-6 space-y-5">
        <div>
          <h3 className="font-semibold text-sm">{t('studioLinksTitle')}</h3>
          <p className="text-xs text-muted-foreground mt-1">{t('studioLinksDescription')}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="studio-website" className="flex items-center gap-1.5 text-xs">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
              {t('studioLinksWebsiteLabel')}
            </Label>
            <Input
              id="studio-website"
              type="url"
              inputMode="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://my-studio.ch"
            />
            <p className="text-xs text-muted-foreground">{t('studioLinksWebsiteHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="studio-review" className="flex items-center gap-1.5 text-xs">
              <Star className="h-3.5 w-3.5 text-muted-foreground" />
              {t('studioLinksReviewLabel')}
            </Label>
            <Input
              id="studio-review"
              type="url"
              inputMode="url"
              value={review}
              onChange={(e) => setReview(e.target.value)}
              placeholder="https://g.page/r/my-studio/review"
            />
            <p className="text-xs text-muted-foreground">{t('studioLinksReviewHint')}</p>
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{t('studioLinksAlsoOnBioLink')}</p>
          <div className="flex shrink-0 items-center gap-3">
            {saved && !saving && <span className="text-xs text-muted-foreground">{tc('saved')}</span>}
            <Button size="sm" onClick={onSave} disabled={saving || !dirty}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? tc('saving') : tc('save')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

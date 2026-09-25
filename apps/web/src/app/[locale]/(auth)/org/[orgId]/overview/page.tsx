'use client'

/**
 * THE ORGANIZATION, SEEN FROM A MEMBER STUDIO.
 *
 * The org console is built for the people who RUN a federation. Most people who
 * ever open an organization do not: they own a studio that belongs to one, they
 * have no `org_members` row, and until this page existed the switcher offered
 * them a scope whose landing page told them "No teams have joined this
 * organization yet" about the federation they are a member of.
 *
 * ── WHY THIS IS A SUMMARY AND NOT A SMALLER CONSOLE ─────────────────────────
 *
 * The roster, the billing, the org's own members and its website belong to the
 * organizers, and the answer is not to widen a rule so a studio can see them.
 * The useful question is a different one — *what is this organization to MY
 * studio* — and it has three parts, which are the three sections below:
 *
 *   WHAT IT IS        the name and description, off the org document.
 *   WHERE YOU STAND   your own `org_teams` row: joined when, active or not.
 *   WHAT IT HANDS DOWN the standards it imposes and the resources it lends —
 *                     belts, affiliation types, places, programs, events.
 *
 * ── EVERY READ HERE WAS ALREADY PERMITTED ───────────────────────────────────
 *
 * Not one rule was relaxed to build this page, which is the property that makes
 * it safe to add. `firestore.rules` already admits a member studio
 * (`currentTeamInOrg`) to the org document, `affiliation_types`, `org_places`,
 * `org_program_templates` and org-scoped `events`; and the studio's OWN
 * `org_teams` row is readable by `isTeamMember(teamId)` — by document id. That
 * last distinction is the whole reason the roster fails and this page does not:
 * a `getDoc` on your own row is allowed, a `list` of everyone's is not.
 *
 * So the sections are not a design preference. They are the shape of what this
 * position in the data can honestly show.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *
 * No way to CONTACT the organization, because there is nothing to contact:
 * `Organization` carries no public address, and its admins live in
 * `org_members`, which a member studio cannot read. A "get in touch" affordance
 * needs a field and a callable behind it, and Franco named it as later work
 * alongside an org feed (2026-08-28). Inventing a mailto here would ship a
 * button that goes nowhere.
 */

import { useParams } from 'next/navigation'
import { useTranslations, useFormatter } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import {
  collection,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  Timestamp,
} from 'firebase/firestore'
import { Link } from '@/i18n/navigation'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { orgHref } from '@/lib/org-nav'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AFFILIATION_TYPES_SUBCOLLECTION,
  EVENTS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  ORG_PLACES_SUBCOLLECTION,
  ORG_PROGRAM_TEMPLATES_SUBCOLLECTION,
  ORG_TEAMS_SUBCOLLECTION,
} from '@linyup/shared'
import type { OrgTeam } from '@linyup/shared'
import { CalendarRange, IdCard, ListTodo, MapPin, Shield } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Route } from 'next'

/** An upcoming org event, reduced to what a card shows. */
interface OrgEventRow {
  id: string
  title: string
  start: Timestamp | null
}

const UPCOMING_EVENTS_SHOWN = 4

export default function OrgOverviewPage() {
  const { orgId } = useParams<{ orgId: string }>()
  const t = useTranslations('Org')
  const format = useFormatter()
  const { org, loading: orgLoading, affiliationTerm } = useOrg()
  const { currentTeamId, team } = useAuth()

  // ── Where this studio stands ───────────────────────────────────────────────
  //
  // BY DOCUMENT ID, and that is not an optimization. `org_teams` admits
  // `isOrgMember(orgId) || isTeamMember(teamId)`; a LIST returns sibling rows
  // that satisfy neither and Firestore denies the whole query, which is exactly
  // how the roster page fails for this audience. Asking for your own row asks a
  // question the rules can answer.
  const { data: standing, isLoading: standingLoading } = useQuery<OrgTeam | null>({
    queryKey: ['org-standing', orgId, currentTeamId],
    enabled: !!currentTeamId,
    queryFn: async () => {
      if (!currentTeamId) return null
      const { doc, getDoc } = await import('firebase/firestore')
      const snap = await getDoc(
        doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_TEAMS_SUBCOLLECTION, currentTeamId)
      )
      return snap.exists() ? ({ ...snap.data() } as OrgTeam) : null
    },
  })

  // ── What the organization hands down ──────────────────────────────────────
  //
  // COUNTS, not contents. The page answers "is there anything here", and a
  // server-side count is one round trip that does not grow with the federation
  // — a studio should not download an org's whole place list to be told it has
  // eleven. The ranking systems are the exception: they live on the org
  // document itself, which is already loaded.
  const { data: counts } = useQuery({
    queryKey: ['org-shared-counts', orgId],
    queryFn: async () => {
      const orgRef = collection(db, ORGANIZATIONS_COLLECTION, orgId, AFFILIATION_TYPES_SUBCOLLECTION)
      const placesRef = collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_PLACES_SUBCOLLECTION)
      const templatesRef = collection(
        db,
        ORGANIZATIONS_COLLECTION,
        orgId,
        ORG_PROGRAM_TEMPLATES_SUBCOLLECTION
      )
      // One failure must not blank the whole section — a federation that has
      // never created a place is the ordinary case, and an org that later
      // narrows one of these rules should cost this page a row, not the page.
      const [types, places, templates] = await Promise.allSettled([
        getCountFromServer(orgRef),
        getCountFromServer(placesRef),
        getCountFromServer(templatesRef),
      ])
      const value = (r: PromiseSettledResult<{ data(): { count: number } }>) =>
        r.status === 'fulfilled' ? r.value.data().count : null
      return {
        affiliationTypes: value(types),
        places: value(places),
        templates: value(templates),
      }
    },
  })

  // ── The federation's calendar ─────────────────────────────────────────────
  const { data: events } = useQuery<OrgEventRow[]>({
    queryKey: ['org-upcoming-events', orgId],
    queryFn: async () => {
      // The same shape the org events page uses, so it hits the same index.
      const q = query(
        collection(db, EVENTS_COLLECTION),
        where('orgId', '==', orgId),
        where('scope', '==', 'org'),
        where('deleted_at', '==', null),
        where('start', '>=', Timestamp.now()),
        orderBy('start', 'asc'),
        limit(UPCOMING_EVENTS_SHOWN)
      )
      const snap = await getDocs(q)
      return snap.docs.map((d) => ({
        id: d.id,
        title: (d.data().title as string) ?? '',
        start: (d.data().start as Timestamp | undefined) ?? null,
      }))
    },
  })

  const rankingSystems = org?.ranking_systems ?? []

  if (orgLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* WHAT IT IS. The page owns its heading (`ownsHeader` in the catalog)
          because the organization's NAME is the title here — this is the one
          org page that is about the organization rather than about a section of
          it. */}
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{org?.name ?? ''}</h1>
        {org?.description && (
          <p className="max-w-2xl text-sm text-muted-foreground">{org.description}</p>
        )}
      </header>

      {/* WHERE YOU STAND */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('overviewStandingTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {standingLoading ? (
            <Skeleton className="h-5 w-48" />
          ) : standing ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{team?.name}</span>
              <Badge variant={standing.status === 'active' ? 'default' : 'secondary'}>
                {t(
                  standing.status === 'active'
                    ? 'overviewStandingActive'
                    : 'overviewStandingInactive'
                )}
              </Badge>
              {standing.joined && (
                <span className="text-muted-foreground">
                  {t('overviewStandingJoined', {
                    date: format.dateTime(standing.joined.toDate(), {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }),
                  })}
                </span>
              )}
            </div>
          ) : (
            // Reachable: an org admin's OWN current studio may sit outside the
            // organization they administer, so "your studio's standing" has no
            // answer rather than a bad one.
            <p className="text-sm text-muted-foreground">{t('overviewStandingNone')}</p>
          )}
        </CardContent>
      </Card>

      {/* WHAT IT HANDS DOWN */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('overviewSharedTitle')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SharedStat
            icon={Shield}
            label={t('overviewSharedRanking')}
            value={rankingSystems.length}
            hint={rankingSystems.map((r) => r.name).join(' · ')}
          />
          {/* The tenant's OWN word for the concept, slotted into the label
              rather than used as it — this card counts KINDS of affiliation,
              and "2 / Affiliation" read as a broken plural beside "1 / Ranking
              systems". `affiliation_term` is arbitrary tenant text, so the
              phrasing has to survive any noun in any of the four locales. */}
          <SharedStat
            icon={IdCard}
            label={t('overviewSharedAffiliationTypes', { term: affiliationTerm })}
            value={counts?.affiliationTypes ?? null}
          />
          <SharedStat icon={MapPin} label={t('overviewSharedPlaces')} value={counts?.places ?? null} />
          <SharedStat
            icon={ListTodo}
            label={t('overviewSharedTemplates')}
            value={counts?.templates ?? null}
            href={orgHref(orgId, 'program-templates')}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('overviewSharedHint')}</p>
      </section>

      {/* THE FEDERATION'S CALENDAR */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">{t('overviewEventsTitle')}</CardTitle>
          <Link
            href={orgHref(orgId, 'events') as Route}
            className="text-sm text-primary hover:underline"
          >
            {t('overviewEventsAll')}
          </Link>
        </CardHeader>
        <CardContent>
          {events === undefined ? (
            <Skeleton className="h-16 w-full" />
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('overviewEventsNone')}</p>
          ) : (
            <ul className="divide-y">
              {events.map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-2 text-sm">
                  <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  {e.start && (
                    <span className="shrink-0 text-muted-foreground">
                      {format.dateTime(e.start.toDate(), {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * One thing the organization shares.
 *
 * A null count means the read did not answer — NOT zero. Showing "0" for a
 * denied or failed count states something false about the federation, so the
 * card shows a dash and says nothing.
 */
function SharedStat({
  icon: Icon,
  label,
  value,
  hint,
  href,
}: {
  icon: LucideIcon
  label: string
  value: number | null
  hint?: string
  href?: string
}) {
  const body = (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-lg font-semibold tabular-nums">{value ?? '—'}</div>
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground/70">{hint}</div>}
      </div>
    </div>
  )
  if (!href) return body
  return (
    <Link href={href as Route} className="block transition-colors hover:bg-accent/50 rounded-lg">
      {body}
    </Link>
  )
}

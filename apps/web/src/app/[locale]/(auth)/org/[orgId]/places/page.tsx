'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { SearchInput } from '@/components/ui/search-input'
import { Skeleton } from '@/components/ui/skeleton'
import { PlacesManager, type PlaceFormValues } from '@/components/places/PlacesManager'
import {
  useOrgPlaces,
  useOrgTeamPlaces,
  createOrgPlace,
  updateOrgPlace,
  deleteOrgPlace,
} from '@/hooks/usePlaces'
import { MAX_PLACES } from '@linyup/shared'
import { MapPin, Building2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export default function OrgPlacesPage() {
  const t = useTranslations('OrgPlaces')
  const { orgId } = useParams<{ orgId: string }>()
  const { isAdmin } = useOrg()
  const { user } = useAuth()
  const qc = useQueryClient()
  const { data: places = [], isLoading } = useOrgPlaces(orgId)
  // A MEMBER STUDIO'S PLACES ARE READ-ONLY HERE. An organization needs to see
  // where its studios actually train — the roster alone does not say — but a
  // studio's locations stay the studio's to edit, which is also exactly what the
  // rules allow (read for an org admin, write for the studio's managers).
  // Admin-only: `isOrgAdminOfTeam` denies an org_viewer, so asking as one would
  // just be a guaranteed empty list.
  const { data: teamPlaces = [] } = useOrgTeamPlaces(isAdmin ? orgId : null)
  const [search, setSearch] = useState('')
  const [studioFilter, setStudioFilter] = useState<string>('all')
  const invalidate = () => qc.invalidateQueries({ queryKey: ['org-places', orgId] })

  // Client-side, over the places already in hand. Name and address are matched
  // separately rather than against one joined string, so a query cannot match by
  // straddling the boundary between them.
  const term = search.trim().toLowerCase()
  const matches = (name?: string, address?: string) =>
    !term ||
    (name ?? '').toLowerCase().includes(term) ||
    (address ?? '').toLowerCase().includes(term)

  const visible = useMemo(
    () => (studioFilter === 'all' ? places.filter((p) => matches(p.name, p.address)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [places, term, studioFilter],
  )

  // The studios that actually HAVE a place, in the order their places sort —
  // a filter offering a studio with nothing behind it is a dead option.
  const studios = useMemo(() => {
    const seen = new Map<string, string>()
    for (const p of teamPlaces) if (!seen.has(p.teamId)) seen.set(p.teamId, p.teamName ?? p.teamId)
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [teamPlaces])

  const visibleTeamPlaces = useMemo(
    () =>
      teamPlaces.filter(
        (p) =>
          (studioFilter === 'all' || p.teamId === studioFilter) && matches(p.name, p.address),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teamPlaces, term, studioFilter],
  )

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
    )
  }

  async function handleCreate(d: PlaceFormValues) {
    if (!user) return
    await createOrgPlace({ orgId, userId: user.uid, data: d })
    invalidate()
  }
  async function handleUpdate(id: string, d: PlaceFormValues) {
    await updateOrgPlace(orgId, id, d)
    invalidate()
  }
  async function handleDelete(id: string) {
    await deleteOrgPlace(orgId, id)
    invalidate()
  }

  const noMatches = term !== '' && visible.length === 0 && visibleTeamPlaces.length === 0

  return (
    <div className="max-w-3xl space-y-5">
      {/* The heading and the search field are rendered here, and PlacesManager is
          mounted in the variant that drops its own <h1> and measure: the field
          belongs between the title and the cards, and the shared manager's page
          chrome has no slot there. */}
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* Mounted once there is a list to narrow. A field over an organization
          with no places yet is a control with nothing to do. */}
      {(places.length > 0 || teamPlaces.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="max-w-xs flex-1">
            <SearchInput
              className="h-9 text-sm"
              placeholder={t('searchPlaceholder')}
              value={search}
              onValueChange={setSearch}
            />
          </div>
          {/* Only once there is more than one source to choose between. With no
              studio places the control would have a single option. */}
          {studios.length > 0 && (
            <Select value={studioFilter} onValueChange={(v) => setStudioFilter(v ?? 'all')}>
              <SelectTrigger className="h-9 w-[12rem] shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('filterAll')}</SelectItem>
                {studios.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {noMatches ? (
        // Its own copy, not the manager's "No places yet" — a search that matched
        // nothing and an organization with no places are different situations,
        // and reusing the second reads as the places having disappeared.
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          {t('emptySearch', { query: search.trim() })}
        </p>
      ) : (
        <PlacesManager
          title={t('title')}
          subtitle={t('subtitle')}
          variant="sheet"
          places={visible}
          canManage={isAdmin}
          // The manager compares `cap` against the list it is handed, so a
          // narrowed list has to narrow the cap by the same amount — otherwise
          // typing in the search field re-enables "Add place" on an organization
          // that has already reached the limit.
          cap={MAX_PLACES - (places.length - visible.length)}
          onCreate={handleCreate}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
        />
      )}

      {/* ── THE STUDIOS' OWN PLACES ──────────────────────────────────────────
          A separate, plainly read-only list rather than rows mixed into the
          manager above: the manager's cards carry edit and delete, and an
          organization cannot edit these. Showing them in the same control with
          the buttons quietly missing would read as a bug. */}
      {visibleTeamPlaces.length > 0 && (
        <section className="space-y-2 pt-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('studioPlacesTitle')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('studioPlacesHint')}</p>
          <ul className="divide-y rounded-lg border">
            {visibleTeamPlaces.map((p) => (
              <li key={`${p.teamId}:${p.id}`} className="flex items-start gap-3 p-3">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  {p.address && (
                    <p className="truncate text-xs text-muted-foreground">{p.address}</p>
                  )}
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Building2 className="h-3 w-3" />
                  <span className="max-w-[10rem] truncate">{p.teamName ?? p.teamId}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

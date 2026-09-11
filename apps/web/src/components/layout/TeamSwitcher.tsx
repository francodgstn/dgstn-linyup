'use client'

/**
 * WHICH STUDIO AM I IN, AND HOW DO I GET TO THE OTHER ONE.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Every layer below the UI has always supported a person belonging to more than
 * one studio: membership is a document per team (`teams/{id}/team_members/{uid}`
 * with `userId` denormalised on it), the collection-group index on that field
 * already ships, the rules already let a caller read exactly their own
 * memberships, and the server already reasons about the multi-team person —
 * `purgeScheduledTeams` keeps an owner's login when they run a second studio.
 * Only the UI was missing, and people reach two studios today through ordinary
 * team invitations with no way to open the second one. The sidebar used to say
 * so in a comment ("there is no team switcher"); that decision was reversed on
 * 2026-08-24.
 *
 * ── IT SHOWS EVERYWHERE YOU CAN STAND, AND TICKS WHERE YOU ARE ─────────────
 * Every studio and every organisation this login can reach, with the current
 * one ticked. It used to hide the studio list for anyone in a single studio;
 * that was right while this lived in the account menu and only answered "take
 * me to my OTHER studio", and wrong as a scope switcher, whose job is the whole
 * picture. The trigger still refuses to become a dropdown at all when there is
 * genuinely nowhere else to go (see ScopeSwitcher) — that is where "unchanged
 * for the overwhelming majority" is kept now. "Create another studio" is always
 * there, because it is the only way anyone gets to two.
 *
 * A FAILED READ IS NOT THAT SILENCE. An empty list and an errored query both
 * leave nothing to render, and they mean opposite things: the first is "you are
 * in one studio", the second is "your second studio is one network hiccup away
 * and you cannot see it". So `isError` gets its own row — the failure said out
 * loud, with a retry — and the block is blank only when the read succeeded and
 * genuinely returned one studio.
 *
 * ── THE SWITCH IS A HARD NAVIGATION, ON PURPOSE ─────────────────────────────
 * `AuthContext` re-subscribes when `currentTeam` changes, but dozens of pages
 * hold TanStack caches and module state keyed to the old team. Reloading the
 * document is one line that drops all of it; a soft navigation would leave the
 * previous studio's contacts, sessions and counts on screen under the new
 * studio's name. It lands on the dashboard rather than reloading in place,
 * because a team-scoped detail URL (`/contacts/{id}`) does not exist in the
 * studio being switched to.
 *
 * ── IT LISTS ORGANISATIONS TOO NOW, AND STILL DOES NOT NEST ────────────────
 * This used to say organisations were a separate concept with their own sidebar
 * section (`OrgLinks`). That section was deleted when an organisation became a
 * SCOPE rather than a row (docs/org-navigation.md), and its entries moved here —
 * because "which place am I standing in" is one question and answering it in two
 * controls is the ambiguity the scope model removes.
 *
 * They are still two FLAT groups. Nothing nests, groups or rolls up: an
 * organisation is not a parent of the studios listed above it, it is a different
 * place to stand.
 *
 * ── AND IT NO LONGER LIVES IN THE ACCOUNT MENU ─────────────────────────────
 * It is the content of the scope switcher in the sidebar's header row
 * (components/layout/ScopeSwitcher.tsx). The notes below about "the account
 * menu" describe where it came from, not where it is.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { collectionGroup, doc, getDoc, getDocs, query, updateDoc, where } from 'firebase/firestore'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, Building2, Check, Landmark, Loader2, Plus } from 'lucide-react'
import type { Route } from 'next'
import { TEAMS_COLLECTION, USERS_COLLECTION, TEAM_MEMBERS_SUBCOLLECTION } from '@linyup/shared'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useOrgLinks } from '@/hooks/useOrgLinks'
import { useScope } from '@/contexts/ScopeContext'
import { useRouter } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'

export type MyTeam = { id: string; name: string }

/**
 * The studios this login is a member of.
 *
 * One collection-group read of the caller's own membership documents (the rule
 * on `{path=**}/team_members/{id}` returns exactly those), then one document
 * read per studio for its name. Cached for five minutes: membership changes
 * when somebody accepts an invitation, which is not something to re-ask on
 * every menu open.
 *
 * IT COSTS NOTHING UNTIL THE MENU IS OPENED. The account dropdown's content
 * lives behind base-ui's `Menu.Portal`, which does not render its children
 * while the menu is closed — so this component, and this query, mount on the
 * first open rather than on every page load.
 *
 * The rules spend one document access per returned membership
 * (`isTeamMember`), against a budget of 20 for a multi-document read, so this
 * shape holds for any realistic number of studios and would need to move
 * server-side long before anyone reached twenty.
 */
export function useMyTeams() {
  const { user } = useAuth()
  const uid = user?.uid ?? null

  return useQuery<MyTeam[]>({
    queryKey: ['my-teams', uid],
    enabled: !!uid,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (!uid) return []
      const snap = await getDocs(
        query(collectionGroup(db, TEAM_MEMBERS_SUBCOLLECTION), where('userId', '==', uid))
      )
      const ids = Array.from(
        new Set(
          snap.docs
            // The denormalised stamp is READ, not reconstructed from the parent
            // path. The collection-group rule gates on the document's own
            // `userId`, and a document with no `teamId` is one this map simply
            // drops — a `?? d.ref.parent.parent?.id` fallback would invent a
            // team id for a membership that never claimed one.
            //
            // (This comment used to describe the rule as gating on
            // `isTeamMember(resource.data.teamId)`. It did, and that rule denied
            // every query it was supposed to allow — see firestore.rules.)
            .map((d) => d.get('teamId') as string | undefined)
            .filter((id): id is string => !!id)
        )
      )
      const teams = await Promise.all(
        ids.map(async (id) => {
          const snapshot = await getDoc(doc(db, TEAMS_COLLECTION, id))
          if (!snapshot.exists()) return null
          return { id, name: (snapshot.data().name as string | undefined) || id }
        })
      )
      return (teams.filter(Boolean) as MyTeam[]).sort((a, b) => a.name.localeCompare(b.name))
    },
  })
}

/**
 * Renders inside the account dropdown. Emits its own trailing separator so the
 * caller only has to decide where the block goes.
 */
export function TeamSwitcher({ onCreateStudio }: { onCreateStudio?: () => void } = {}) {
  const t = useTranslations('TopBar')
  const locale = useLocale()
  const router = useRouter()
  const { user, currentTeamId } = useAuth()
  const { data: teams = [], isError, isFetching, refetch } = useMyTeams()
  const { data: orgs = [] } = useOrgLinks()
  const { current: currentScope } = useScope()
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)

  /** Am I standing in this studio RIGHT NOW? Being the current team is not
   *  enough — in org scope the current team is still set, but you are somewhere
   *  else. Without this, the studio you belong to renders as ticked-and-inert
   *  inside an organisation, so the switcher's most obvious way back to your own
   *  studio does nothing at all. */
  const standingIn = (teamId: string) =>
    currentScope?.kind === 'team' && currentScope.id === teamId

  /**
   * A LIST OF ONE IS NOT A LIST — UNLESS YOU ARE NOT STANDING IN IT.
   *
   * The single-studio rule below holds only in team scope, where the one row
   * would be the studio you are already in. In ORG scope you are somewhere
   * else, so that row is the way BACK — and hiding it left an org admin who
   * runs one studio with a switcher that could reach the organisation and
   * nothing else (Franco, 2026-09-02).
   *
   * Same blind spot `standingIn` was written for, one step earlier: that fixed
   * the row rendering as ticked-and-inert, this stops it being absent.
   */
  const showStudioList = teams.length > 1 || currentScope?.kind === 'org'

  async function switchTo(teamId: string) {
    if (!user || switchingTo) return
    // Already the current team, but standing in an ORG: this is navigation, not
    // a team switch. Nothing is cached against the wrong tenant, so none of the
    // hard-reload reasoning below applies.
    if (teamId === currentTeamId) {
      if (!standingIn(teamId)) router.push('/dashboard' as Route)
      return
    }
    setSwitchingTo(teamId)
    try {
      await updateDoc(doc(db, USERS_COLLECTION, user.uid), { currentTeam: teamId })
      // `useRouter` from @/i18n/navigation cannot be used here: this has to be a
      // document load, not a client navigation. The prefix is added by hand for
      // the same reason — `localePrefix: 'as-needed'` leaves the default locale
      // unprefixed.
      const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
      window.location.assign(`${prefix}/dashboard`)
    } catch {
      setSwitchingTo(null)
      toast.error(t('switchStudioFailed'))
    }
  }

  return (
    <>
      {isError && (
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            {t('switchStudio')}
          </DropdownMenuLabel>
          {/* The read failed, so how many studios this login has is UNKNOWN.
              Saying so — and offering the retry — is the only thing that keeps
              the empty block below meaning "one studio" and nothing else. */}
          <DropdownMenuItem
            closeOnClick={false}
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <AlertTriangle className="mr-2 h-4 w-4 text-destructive" />
            )}
            <span className="truncate">{t('studioListFailed')}</span>
            <span className="ml-2 shrink-0 text-xs font-medium text-primary">
              {t('studioListRetry')}
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      )}
      {/* BOTH GROUPS, ALWAYS, WITH A TICK ON WHERE YOU ARE (Franco, 2026-08-27).
          This used to hide the studio list unless you were in more than one — a
          rule inherited from when the block lived in the account menu and only
          ever answered "take me to my other studio". As the SCOPE switcher its
          job is different: it is the whole picture of where this login can
          stand, and a picture with your current place missing is a worse answer
          than a slightly longer list. The tick is what makes the extra row
          informative rather than noise — it says where you are, which is the
          question the control exists to answer. */}
      {!isError && teams.length > 0 && (
        <DropdownMenuGroup>
          {/* A LIST OF ONE IS NOT A LIST. With a single studio the only row
              would be the studio you are standing in, under a heading that
              offers to switch you to it — so the heading and the rows are both
              held back and the group is the create row alone (Franco,
              2026-08-28). That is what the switcher shows somebody who has one
              studio and no organisation: a way to get a second, and the offer
              behind it. */}
          {showStudioList && (
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              {t('switchStudio')}
            </DropdownMenuLabel>
          )}
          {showStudioList &&
            teams.map((team) => {
            const isCurrent = standingIn(team.id)
            return (
              <DropdownMenuItem
                key={team.id}
                disabled={!!switchingTo}
                // The menu stays open while the switch is in flight, so the row
                // can show it working and a failure lands on a menu that still
                // shows which studio you are actually in. Picking the studio you
                // are already in does nothing, so that one just closes.
                closeOnClick={isCurrent}
                onClick={() => void switchTo(team.id)}
              >
                {switchingTo === team.id ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : isCurrent ? (
                  <Check className="mr-2 h-4 w-4 text-primary" />
                ) : (
                  <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
                )}
                <span className="truncate">{team.name}</span>
                {/* The tick carries the state visually; this is the same fact
                    for a screen reader, which cannot see which row is ticked. */}
                {isCurrent && <span className="sr-only">{t('currentStudio')}</span>}
              </DropdownMenuItem>
            )
          })}
          {/* INSIDE THE STUDIOS GROUP, because it makes a STUDIO — at the foot
              of the whole menu it read as a general action and sat under the
              organisations, which it has nothing to do with (Franco,
              2026-08-27). Shown to someone with a single studio too — it is
              the only route to a second one, so gating it on already having
              two would make it unreachable. It rides on the group's own gate,
              which is right: a login with no studio at all is sent to the
              signup wizard by the app before it ever opens this menu.

              IT REACHES THE EXISTING TEAM-CREATION FLOW rather than a second
              copy of it: `provisionTeam` is generic and nothing in it assumes
              it is the caller's first team. The wizard otherwise redirects
              anyone who already has a `currentTeam` straight to the dashboard;
              `?new=1` is what skips that bounce and opens it at its team step.
              THAT BRANCH LIVES IN `app/[locale]/signup/page.tsx` — this entry
              is the only thing that sets the flag, so the two move together or
              the item goes nowhere. */}
          <DropdownMenuItem
            onClick={() => {
              // A login that already has an organisation has met this offer and
              // is not the audience for it; so has one with no handler, which is
              // every caller that has not opted in.
              if (orgs.length > 0 || !onCreateStudio) {
                router.push('/signup?new=1' as Route)
                return
              }
              onCreateStudio()
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('createStudio')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      )}
      {/* THE ORGANISATIONS THIS LOGIN CAN STAND IN.
          A second GROUP, not a second control, because the question is the same
          one — "which scope am I in" — and answering it in two places would put
          the ambiguity back that the scope model exists to remove.

          Entering an org is ORDINARY NAVIGATION, unlike switching studio: the
          current team does not change, so there is no cache keyed to the wrong
          tenant and none of the hard-reload reasoning below applies.

          IT LINKS TO THE SCOPE ROOT, not to a page. Where an organisation opens
          depends on whether you run it or merely belong to one of its studios,
          and `/org/{id}` is the one place that decides — see that route. Naming
          a page here would mean resolving a role for every organisation in the
          list before this menu could render a single row. */}
      {orgs.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            {t('switchOrganisation')}
          </DropdownMenuLabel>
          {orgs.map((org) => {
            const isCurrent = currentScope?.kind === 'org' && currentScope.id === org.id
            return (
              <DropdownMenuItem
                key={org.id}
                disabled={!!switchingTo}
                onClick={() => router.push(`/org/${org.id}` as Route)}
              >
                {isCurrent ? (
                  <Check className="mr-2 h-4 w-4 text-primary" />
                ) : (
                  <Landmark className="mr-2 h-4 w-4 text-muted-foreground" />
                )}
                <span className="truncate">{org.name}</span>
                {isCurrent && <span className="sr-only">{t('currentStudio')}</span>}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      )}
    </>
  )
}

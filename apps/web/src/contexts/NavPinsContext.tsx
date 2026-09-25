'use client'

/**
 * THE NAV-MEMORY CENSUS — the owner. Add to this list; never copy it.
 *
 * The admin shell remembers where you have been in more than one way, and until
 * 2026-08-18 all of them were called "pin" (UX-23). Two of them still are, in
 * storage. On screen the word survives on open tabs alone, and — since
 * 2026-08-29 (UX-84) — the pin GLYPH does too: it used to be worn by open tabs
 * AND by the Shortcuts group's curated half on ONE shared model ("keep this
 * within reach"), which collided with the OTHER star on this screen (the
 * "recommended by Linyup" badge on a plugin-suggestion row, item 1 below). The
 * fix gave each meaning its own glyph rather than reusing one: Shortcuts' curated
 * half moved off the pin onto a STAR, and the plugin-suggestion badge moved off
 * that same star onto a puzzle piece — so the pin is once again the ONLY thing
 * that GLYPH means on screen (open tabs alone), and the star is now the ONLY
 * thing ITS glyph means (a personal favorite). The saved-filter sense is gone
 * entirely. What exists, and what each one is called where a user can read it:
 *
 * 1. SHORTCUTS — this file's STORED AND CODED name; ON SCREEN it is labeled
 *    "Favorites", since 2026-08-29 (UX-84, display-only rename — same policy as
 *    plan IDs vs plan display names, see CLAUDE.md). The storage keys, this
 *    file's exports and every `Shortcut*` component/prop name were left alone
 *    deliberately (see "STORED NAMES KEEP THE OLD WORD" below); only the copy and
 *    the icon changed. A per-browser list of NAV DESTINATIONS (a page, a
 *    settings screen, a plugin item), keyed by a stable nav id, rendered as the
 *    sidebar's "Favorites" group. It has two halves and they are ONE mechanism,
 *    not two:
 *      · ALWAYS SHOWN (`alwaysShownIds`) — hand-curated, drag-ordered, never
 *        truncated, never ages out. Added from a sidebar row, a settings-rail
 *        row or a search result. UI verb: "Always show in favorites". The row
 *        wears its star FILLED and at rest — which, with no heading and no
 *        divider anywhere in the group, is the ONLY thing that marks a row as
 *        belonging to this run (see the vocabulary note at the end of this
 *        item).
 *      · RECENT (`recentIds`) — an automatic rolling history of the last
 *        RECENTS_MAX destinations visited, listed under the always-shown ones
 *        and truncated behind "Show more". No verb: it fills itself.
 *    The control on a row PROMOTES a recent to always-shown (and back); the ×
 *    REMOVES the row from Favorites entirely. Icon: a star, filled while on.
 *
 *    TWO RUNS, ORDERED, MARKED AS ONE REGION BY A LEFT RULE (2026-08-18):
 *    always-shown first, recent after, under the one "Favorites" heading, with a
 *    thin flat brand-violet rule down the left edge of the whole area — heading,
 *    both runs and the empty-state hint. NOTHING HARD SEPARATES THE RUNS: no
 *    sub-headings, no divider. Both were built here first, on the same day, and
 *    both were removed:
 *      · sub-headings ("Pinned" / "Recent") — they restate what the rows already
 *        say, and they put a noun in front of a verb that disagrees with it (see
 *        the vocabulary note below).
 *      · a hairline between the runs — it competed with the region marker for the
 *        one job of marking this area out, and lost.
 *    THE RULE IS NOT THE ORIGINAL RULE, and the difference is the entire point of
 *    this pass. The original was a `before:` pseudo-element on a padded wrapper:
 *    it reserved layout width, so every shortcut row sat 12px right of every other
 *    nav row, and it carried a vertical gradient that read as noise. The
 *    replacement is absolutely positioned, flat and a hairline wide — same signal,
 *    no indent, no ramp. (A horizontal background wash over the whole area was
 *    tried in between and rejected: it grew with the list and read as a highlight
 *    rather than a boundary.) It sits in `nav`'s own left padding, NOT at the
 *    content edge the rows start from, so an active row's background has a few px
 *    of air rather than butting against it. If anything here is ever re-styled,
 *    THOSE are the two constraints to preserve: the marker must not consume width,
 *    and any breathing room it needs comes out of the gutter, never out of the
 *    rows — which is also the only thing keeping every nav link in the sidebar on
 *    one 8px left offset (verified live across all 19).
 *
 *    What carries the split now that no line does — all three already existed:
 *      1. ORDER. Pinned first, always.
 *      2. THE PIN. Filled and visible at rest on a pinned row; hover-only on a
 *         recent one. Two adjacent rows are tellable apart without reading.
 *      3. THE MOVE. Pinning re-renders the row at the end of the pinned run, so
 *         the promotion is SEEN. With no line to cross this motion is the whole
 *         story, which is why the two runs are derived from `alwaysShownIds` on
 *         every render and never snapshotted. Unpinning moves it back rather than
 *         dropping it (that is the ×).
 *    Other consequences worth keeping:
 *      · ONE heading level, which "Clear all" needs — it empties both halves in
 *        one action, so it belongs to the group, not to either run.
 *      · The empty state is ruled too. A region that stopped being marked exactly
 *        when the hint explaining it appears would be marking the wrong thing.
 *      · DRAG REORDERS WITHIN THE PINNED RUN ONLY. Recent is ordered by last
 *        visit, so a manual placement there could not be stored and the next
 *        navigation would undo it; and dragging from one run to the other is not
 *        offered because promotion already has one visible, reversible affordance
 *        (the pin), and an accidental drop is a poor second one. A reorder is
 *        applied to the STORED list, so a pinned destination that is currently
 *        gated off (and therefore not rendered) survives it.
 *      · The collapsed icon rail is unchanged: the same rows in the same order,
 *        no rule (a hairline beside a 40px column marks nothing) and no eraser.
 *    Rendered by `ShortcutsNav` in `app/[locale]/(auth)/layout.tsx`; the rule's
 *    measured contrast values, per theme, are on `SHORTCUTS_RULE` there.
 *
 *    NOT THE HEAD TILE — that is item 5 below, and it is deliberately separate.
 *
 *    VOCABULARY, recorded: the only words the user reads are still the verbs on
 *    the control — "Always show in favorites" / "Stop always showing"
 *    (`Nav.shortcutAlwaysShow`, `shortcutStopAlwaysShowing` — same KEY names,
 *    text changed 2026-08-29, shared with the sidebar rows and the search
 *    dropdown) — while the glyph is a star (was a pin until 2026-08-29, UX-84).
 *    Splitting the group added NO new copy, deliberately: naming the runs "Pinned" and
 *    "Recent" would have put a noun in front of a verb that disagrees with it,
 *    and reconciling the two is a separate four-locale decision that should move
 *    in one pass or not at all.
 *
 * 2. OPEN TABS — `contexts/OpenTabsContext.tsx`. The Notion-style strip of
 *    pages you currently have OPEN, including individual records (a contact, a
 *    session). Different question: Favorites answers "where do I go often",
 *    Open tabs answers "what am I in the middle of". They are deliberately NOT
 *    merged. A tab may be PINNED, which protects it from Close-others and cap
 *    eviction — the same word every browser uses. Icon: a pin — and, since
 *    2026-08-29 (UX-84), once again the ONLY thing on screen that glyph means:
 *    Favorites moved its curated half off the pin onto a star (item 1), which
 *    is what freed "pin" back to one mental model over one object. Before that
 *    it was shared, unlabelled, with Favorites' curated half — deliberately,
 *    at the time — and it is what UX-23 was NOT: back then "pin" also meant a
 *    saved contact filter, a third, unrelated object, which now says "show in
 *    filter bar".
 *
 * 3. SAVED FILTERS ON THE CONTACTS PAGE — `app/[locale]/(auth)/contacts/page.tsx`.
 *    Not a destination at all: a stored ContactFilter, per TEAM (Firestore, not
 *    localStorage), which may be shown as a chip in the filter bar. It used to
 *    say "Pin to filter bar"; it now says "Show in filter bar".
 *
 * 4. RECENTLY VIEWED CONTACTS — `contexts/RecentContactsContext.tsx`. The last
 *    few PEOPLE whose detail page you opened, ids only, per TEAM, in
 *    localStorage. Surfaced in exactly one place: the sidebar search panel
 *    BEFORE anything is typed (typing replaces it with results). A third
 *    question again — Favorites answers "where do I go often", Open tabs "what
 *    am I in the middle of", this one "who was I just looking at" — and neither
 *    of the other two can answer it: a contact page records the "contacts" PAGE
 *    into Favorites' recents, and Open tabs rewrites its active tab in place (so
 *    ten contacts leave one tab) and only when the strip is switched on. Names
 *    are resolved live from the roster query, never stored; an id that no longer
 *    resolves is dropped from the rendering, not from storage. UI label:
 *    "Recently viewed contacts". No verb and no control: it fills itself.
 *    VOCABULARY: in code it is `recentContact*`, never `recent*` bare — that
 *    word is spent on the recents half of Favorites above (item 1).
 *
 * 5. THE HEAD TILES — this file too, but their OWN key
 *    (`linyup_nav_head_tile`, still singular: a stored name is a machine
 *    identifier, see STORED NAMES KEEP THE OLD WORD below). The adjustable
 *    tiles beside Dashboard at the top of the nav, rendered by `HeadTiles` in
 *    `app/[locale]/(auth)/layout.tsx`.
 *
 *    A LIST SINCE 2026-09-20, capped at HEAD_TILES_MAX cells INCLUDING the
 *    fixed Dashboard — so five of the studio's own, in a two-column grid, three
 *    rows at the very most.
 *
 *    THERE IS NO SETTING FOR HOW MANY (Franco, 2026-09-20). A 2/4/6 control was
 *    considered and dropped: the grid already grows a cell at a time as tiles
 *    are added, so a number to choose up front is a second way to say the same
 *    thing and one more row of settings to scroll past. What the absence costs
 *    is the ability to cap it BELOW six while still adding tiles, which nobody
 *    has asked for.
 *
 *    IT WAS BUILT AS THE TOP OF ITEM 1 AND THAT WAS WRONG (2026-08-20). Deriving
 *    the tile from the first always-shown shortcut stored nothing new, which is
 *    why it was tried — but it fused two controls: pinning a shortcut, or
 *    dragging the pinned run into a different order, silently changed which
 *    destination sat in the head tile. The two look like one question ("what do
 *    I keep in reach") and are not: SHORTCUTS is a LIST you curate and scan, the
 *    HEAD TILE is ONE SLOT you set once and stop thinking about. A list whose
 *    first element is also a fixed chrome element has no stable first element.
 *
 *    So the tile is set and unset on its own, and its value never appears in
 *    `alwaysShownIds`. A destination may be both a head tile and a shortcut;
 *    that is a duplicate the user asked for twice, not a bug. Precedence matches
 *    item 1: NO ENTRY FOR THIS STUDIO means "not chosen yet" and falls back to
 *    DEFAULT_HEAD_TILE_IDS (Schedule); an EMPTY LIST means "I cleared them" and
 *    renders the dashed placeholder, which is the affordance for setting one
 *    again. No verb: the control is a chooser on the tile itself.
 *
 * STORED NAMES KEEP THE OLD WORD, deliberately — same policy as plan IDs vs
 * plan display names (see CLAUDE.md): `linyup_nav_pins`, `linyup_settings_pins`
 * and `TeamNavDefaults.defaultNavPins` are machine identifiers written by
 * seeds and by browsers in the wild, and renaming them buys nothing a user can
 * see. The vocabulary a user reads is "favorites" / "always show", everywhere
 * (since 2026-08-29, UX-84 — display-only rename, it was "shortcuts" before).
 *
 * ── EVERYTHING HERE IS PER STUDIO ──
 * Favorites, recents and the head tile are all stored as `{ [teamId]: … }`,
 * keyed by AuthContext's `currentTeamId` — the same shape and the same reason as
 * census item 4. A studio's rail is about ITS pages, so a flat value would bleed
 * one studio's navigation into another's the moment a person can switch between
 * them (`components/layout/TeamSwitcher.tsx`). Migration of the older flat
 * values, and why the storage key names stayed the same, are documented on the
 * key constants below.
 *
 * ── Default precedence for the always-shown list (highest wins) ──
 * (1) the user's own stored list FOR THIS STUDIO, if there is an entry at all —
 * even `[]`, an explicit "I cleared everything" — (2) legacy-key migration,
 * which counts as a user choice too and is adopted into the studio they are in
 * when it happens, (3) the team's seeded `settings.defaultNavPins`
 * (TeamNavDefaults, see packages/shared/src/types/team.ts), (4) the hardcoded
 * DEFAULT_SHORTCUT_IDS. The team default reuses AuthContext's existing team
 * subscription — no new Firestore listener — and is never written to
 * localStorage, so it can never be mistaken for a deliberate user choice and it
 * keeps tracking the team doc until the user actually makes one. It is a
 * FALLBACK IN THE READER, not a value copied into state: the instant the user
 * adds/removes/reorders anything, that studio gets an entry of its own and the
 * default stops applying to it — permanently, and only to it.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { DEFAULT_SHORTCUT_IDS, DEFAULT_HEAD_TILE_IDS } from '@/lib/settings-nav'
import { useAuth } from '@/contexts/AuthContext'
import type { TeamNavDefaults } from '@linyup/shared'

/**
 * STORED SHAPES ARE KEYED BY TEAM: `{ [teamId]: … }`, the same shape
 * `contexts/RecentContactsContext.tsx` already stores its per-team history in.
 * Every value in this file is a statement about ONE studio's navigation — the
 * shortcut list names that studio's pages, the recents are where you have been
 * inside it, the head tile is the one destination you keep beside its Dashboard
 * — so a flat value would hand studio B the studio A rail the moment anyone can
 * switch (see `components/layout/TeamSwitcher.tsx`), and switching back would
 * find A's curation overwritten by B's.
 *
 * THE KEY NAMES DO NOT CHANGE with the shape, deliberately: a browser in the
 * wild holds the old flat value under the same name, and the reader below
 * accepts either — an array (or, for the head tile, a string/`null`) is a
 * pre-2026-08-24 value and is adopted into the studio the user is currently in,
 * then rewritten in the new shape. Renaming the keys instead would silently
 * reset every shortcut list ever curated.
 *
 * NOTHING IS EVICTED. The team dimension is bounded by the studios this login
 * is actually a member of, so there is no unbounded key here to defend against
 * — and the curated stores (shortcuts, head tile) hold deliberate choices that
 * an LRU would throw away without asking.
 */
const STORAGE_KEY = 'linyup_nav_pins'
const LEGACY_KEY = 'linyup_settings_pins'
const RECENTS_KEY = 'linyup_nav_recents'
const RECENTS_MAX = 10
/** Census item 5. A LIST per team since 2026-09-20 — see the header. The key
 *  keeps its singular name on the policy stated there: stored names are machine
 *  identifiers and renaming one buys nothing a user can see. */
const HEAD_TILE_KEY = 'linyup_nav_head_tile'

/** Cells in the head grid, Dashboard included — so at most HEAD_TILES_MAX - 1
 *  are the studio's own. Two columns, so six is three rows and the last one a
 *  reader can still take in at a glance. */
export const HEAD_TILES_MAX = 6

/** Stable identity, so a studio with no history does not re-render the sidebar. */
const NO_IDS: string[] = []

type ListStore = Record<string, string[]>
type TileStore = Record<string, string[]>

function asIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((id): id is string => typeof id === 'string')
}

/**
 * Read a list key in either shape.
 *
 * `flat` is the pre-team-scoping value if that is what is stored; the caller
 * files it under the current studio and rewrites the key. Malformed storage
 * reads as "nothing stored", never as an exception on a nav render.
 */
function readListStore(key: string): { store: ListStore; flat: string[] | null } {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { store: {}, flat: null }
    const parsed = JSON.parse(raw) as unknown
    const flat = asIds(parsed)
    if (flat) return { store: {}, flat }
    if (!parsed || typeof parsed !== 'object') return { store: {}, flat: null }
    const store: ListStore = {}
    for (const [teamId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      const list = asIds(ids)
      if (list) store[teamId] = list
    }
    return { store, flat: null }
  } catch {
    return { store: {}, flat: null }
  }
}

/**
 * The head tile's THREE states per studio are why this is not just a string:
 *   · no entry for the team → not chosen yet, fall back to DEFAULT_HEAD_TILE_IDS
 *   · entry is `[]`         → deliberately cleared, render the placeholder
 *   · entry is a list       → those destinations, in that order
 * Storing `null` rather than dropping the entry is what stops the default
 * flowing back in and making the clear button look broken — the same
 * distinction item 1 draws between a stored `[]` and no entry at all.
 *
 * `flat` carries the pre-team-scoping single value, normalized to a list — so
 * `hasFlat` is what says whether there was one, since an empty list is itself a
 * meaningful stored value here.
 */
function readTileStore(): { store: TileStore; flat: string[] | null; hasFlat: boolean } {
  try {
    const raw = localStorage.getItem(HEAD_TILE_KEY)
    if (!raw) return { store: {}, flat: null, hasFlat: false }
    const parsed = JSON.parse(raw) as unknown
    // PRE-LIST FLAT VALUES, from before the tile was team-scoped: a bare string
    // is the one chosen tile, a bare null is "I cleared it".
    if (parsed === null) return { store: {}, flat: [], hasFlat: true }
    if (typeof parsed === 'string') return { store: {}, flat: [parsed], hasFlat: true }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { store: {}, flat: null, hasFlat: false }
    }
    const store: TileStore = {}
    for (const [teamId, id] of Object.entries(parsed as Record<string, unknown>)) {
      // A team's value was `string | null` until 2026-09-20 and is a list now.
      // Both shapes are in browsers in the wild, so both are read; only the list
      // is ever written back.
      if (id === null) store[teamId] = []
      else if (typeof id === 'string') store[teamId] = [id]
      else if (Array.isArray(id)) store[teamId] = asIds(id) ?? []
    }
    return { store, flat: null, hasFlat: false }
  } catch {
    return { store: {}, flat: null, hasFlat: false }
  }
}

function persist(key: string, store: ListStore | TileStore) {
  try {
    localStorage.setItem(key, JSON.stringify(store))
  } catch {
    /* ignore (private mode, quota) */
  }
}

interface NavPinsValue {
  alwaysShownIds: string[]
  isAlwaysShown: (id: string) => boolean
  toggleAlwaysShown: (id: string) => void
  /** Replace the always-shown order wholesale (drag-and-drop reordering). */
  setShortcutOrder: (ids: string[]) => void
  /** Most-recently-visited nav ids, newest first (may include always-shown ids). */
  recentIds: string[]
  /** Record a visit to a nav destination (moves it to the front of recents). */
  recordVisit: (id: string) => void
  /** Remove an item from Favorites entirely (drop from both halves). */
  removeShortcut: (id: string) => void
  /** Empty Favorites: nothing always shown, no recents. */
  clearShortcuts: () => void
  /** Census item 5 — the single adjustable tile beside Dashboard. `null` = the
   *  studio cleared it and wants the placeholder. Never overlaps alwaysShownIds. */
  /** The studio's chosen head tiles, in order. Never includes Dashboard, which
   *  is fixed and occupies the first cell. At most HEAD_TILES_MAX - 1 long. */
  headTileIds: string[]
  /** Append a tile. Ignored at capacity, and a duplicate is ignored too — the
   *  grid is a set of destinations, and two cells to one page is not a choice
   *  anybody makes on purpose. */
  addHeadTile: (id: string) => void
  /** Replace the tile at `index`; a null id removes it. */
  setHeadTileAt: (index: number, id: string | null) => void
}

const NavPinsContext = createContext<NavPinsValue | null>(null)

export function NavPinsProvider({ children }: { children: React.ReactNode }) {
  // Reused from AuthContext's existing subscriptions — no new Firestore read.
  // `currentTeamId` is the key everything below is filed under; `team` carries
  // the seeded default. The provider mounts inside the auth layout, which holds
  // a spinner until the profile has loaded, so the studio is known on the first
  // render rather than arriving later.
  const { team, currentTeamId } = useAuth()

  // The WHOLE store, every studio, hydrated after mount — localStorage does not
  // exist during SSR, so a render-time read is a hydration mismatch.
  const [pinsStore, setPinsStore] = useState<ListStore>({})
  const [recentsStore, setRecentsStore] = useState<ListStore>({})
  const [tileStore, setTileStore] = useState<TileStore>({})
  // recordVisit can fire (from the sidebar's pathname effect) before the
  // hydration effect below has run — effects fire child-first — so in that
  // window the writer reads storage itself and merges, and the first visit of a
  // session never clobbers the history.
  const hydrated = useRef(false)
  // A pre-team-scoping flat value is folded into the current studio ONCE. It is
  // that studio's list by adoption, not by right, so arriving in a second studio
  // later must not hand it the same list again.
  const adoptedFlat = useRef(false)

  useEffect(() => {
    const pins = readListStore(STORAGE_KEY)
    const recents = readListStore(RECENTS_KEY)
    const tile = readTileStore()
    // The settings-only pin key is only consulted when nothing has ever been
    // stored under the shortcuts key — same precedence as before team scoping.
    const legacyPins =
      pins.flat === null && !Object.keys(pins.store).length ? readListStore(LEGACY_KEY).flat : null

    let nextPins = pins.store
    let nextRecents = recents.store
    let nextTile = tile.store

    if (currentTeamId && !adoptedFlat.current) {
      adoptedFlat.current = true
      const flatPins = pins.flat ?? legacyPins
      if (flatPins) {
        nextPins = { ...nextPins, [currentTeamId]: flatPins }
        persist(STORAGE_KEY, nextPins)
      }
      if (recents.flat) {
        nextRecents = { ...nextRecents, [currentTeamId]: recents.flat.slice(0, RECENTS_MAX) }
        persist(RECENTS_KEY, nextRecents)
      }
      if (tile.hasFlat) {
        // `hasFlat` is the test, not truthiness: `[]` is the pre-list "I
        // cleared it" and must be adopted as a cleared list, not skipped.
        nextTile = { ...nextTile, [currentTeamId]: tile.flat ?? [] }
        persist(HEAD_TILE_KEY, nextTile)
      }
    }

    // In-memory wins per studio: every mutation persists as it happens, so
    // anything already in state is the newer of the two by construction.
    setPinsStore((prev) => ({ ...nextPins, ...prev }))
    setRecentsStore((prev) => ({ ...nextRecents, ...prev }))
    setTileStore((prev) => ({ ...nextTile, ...prev }))
    hydrated.current = true
  }, [currentTeamId])

  /**
   * Default precedence for the always-shown list — the header's four levels,
   * DERIVED rather than synced. The team default used to be copied into state by
   * an effect gated on a "has the user chosen?" ref; expressing it as a fallback
   * instead means there is no window in which the wrong list is in state, and
   * "the user's own list wins permanently" is simply the presence of an entry
   * for this studio — including an entry of `[]`, which is "I cleared it".
   */
  const alwaysShownIds = useMemo(() => {
    const own = currentTeamId ? pinsStore[currentTeamId] : undefined
    if (own) return own
    const teamDefault = (team?.settings as TeamNavDefaults | undefined)?.defaultNavPins
    if (teamDefault?.length) return teamDefault
    return DEFAULT_SHORTCUT_IDS
  }, [currentTeamId, pinsStore, team])

  const recentIds = useMemo(
    () => (currentTeamId ? (recentsStore[currentTeamId] ?? NO_IDS) : NO_IDS),
    [currentTeamId, recentsStore]
  )

  // Same three-state precedence census item 5 has always had, now over a list:
  //   no entry for the team → not chosen yet, fall back to the default one
  //   []                    → deliberately cleared, render the placeholder
  //   [ids]                 → those destinations, in that order
  const headTileIds =
    currentTeamId && currentTeamId in tileStore
      ? tileStore[currentTeamId]
      : DEFAULT_HEAD_TILE_IDS

  /**
   * EVERY WRITE STARTS FROM THE WHOLE MAP, INCLUDING THE STUDIOS NOT ON SCREEN.
   * A write that lands before the hydration effect has run would otherwise
   * persist a map holding this studio alone and silently drop every other
   * studio's entry — the same read-through the recents writer has always done
   * for its own list, widened to the dimension that now exists.
   */
  const listBase = useCallback(
    (prev: ListStore, key: string): ListStore =>
      hydrated.current ? prev : { ...readListStore(key).store, ...prev },
    []
  )

  /** Write this studio's always-shown list. A no-op with no studio to file it under. */
  const writeAlwaysShown = useCallback(
    (ids: string[]) => {
      if (!currentTeamId) return
      setPinsStore((prev) => {
        const next = { ...listBase(prev, STORAGE_KEY), [currentTeamId]: ids }
        persist(STORAGE_KEY, next)
        return next
      })
    },
    [currentTeamId, listBase]
  )

  const pushRecent = useCallback(
    (id: string) => {
      if (!currentTeamId) return
      setRecentsStore((prev) => {
        let base = prev
        if (!hydrated.current) {
          const stored = readListStore(RECENTS_KEY)
          // Also folds a pre-team-scoping flat history, which the hydration
          // effect has not yet had the chance to adopt.
          const storedIds = stored.store[currentTeamId] ?? stored.flat ?? []
          base = {
            ...stored.store,
            ...prev,
            [currentTeamId]: Array.from(new Set([...(prev[currentTeamId] ?? []), ...storedIds])),
          }
        }
        const current = base[currentTeamId] ?? []
        if (base === prev && current[0] === id) return prev
        const next = {
          ...base,
          [currentTeamId]: [id, ...current.filter((p) => p !== id)].slice(0, RECENTS_MAX),
        }
        persist(RECENTS_KEY, next)
        return next
      })
    },
    [currentTeamId]
  )

  const toggleAlwaysShown = useCallback(
    (id: string) => {
      const removing = alwaysShownIds.includes(id)
      writeAlwaysShown(removing ? alwaysShownIds.filter((p) => p !== id) : [...alwaysShownIds, id])
      // Turning "always show" off DEMOTES the row to a recent rather than
      // dropping it from the Favorites group (removeShortcut does that).
      if (removing) pushRecent(id)
    },
    [alwaysShownIds, pushRecent, writeAlwaysShown]
  )

  const setShortcutOrder = useCallback((ids: string[]) => writeAlwaysShown(ids), [writeAlwaysShown])

  /**
   * Clear the whole block, for this studio.
   *
   * Persists an EMPTY always-shown list rather than dropping the entry, so this
   * reads as "I want none" rather than "I have not chosen yet" — otherwise the
   * team's `settings.defaultNavPins` (or DEFAULT_SHORTCUT_IDS) would flow
   * straight back in and the button would look broken. That precedence is
   * documented at the top of this file; this is the case it exists for.
   */
  const clearShortcuts = useCallback(() => {
    if (!currentTeamId) return
    writeAlwaysShown([])
    setRecentsStore((prev) => {
      const next = { ...listBase(prev, RECENTS_KEY), [currentTeamId]: [] }
      persist(RECENTS_KEY, next)
      return next
    })
  }, [currentTeamId, listBase, writeAlwaysShown])

  const removeShortcut = useCallback(
    (id: string) => {
      if (!currentTeamId) return
      if (alwaysShownIds.includes(id)) writeAlwaysShown(alwaysShownIds.filter((p) => p !== id))
      setRecentsStore((prev) => {
        const base = listBase(prev, RECENTS_KEY)
        const current = base[currentTeamId] ?? []
        const ids = current.filter((p) => p !== id)
        if (base === prev && ids.length === current.length) return prev
        const next = { ...base, [currentTeamId]: ids }
        persist(RECENTS_KEY, next)
        return next
      })
    },
    [alwaysShownIds, currentTeamId, listBase, writeAlwaysShown]
  )

  const isAlwaysShown = useCallback((id: string) => alwaysShownIds.includes(id), [alwaysShownIds])

  /** The one writer. Both mutators go through it so the read-through, the cap
   *  and the persist are stated once. */
  const writeTiles = useCallback(
    (update: (current: string[]) => string[]) => {
      if (!currentTeamId) return
      setTileStore((prev) => {
        // Same read-through as `listBase`, for the map this one writes.
        const base = hydrated.current ? prev : { ...readTileStore().store, ...prev }
        const current = currentTeamId in base ? base[currentTeamId] : DEFAULT_HEAD_TILE_IDS
        const next = { ...base, [currentTeamId]: update(current).slice(0, HEAD_TILES_MAX - 1) }
        persist(HEAD_TILE_KEY, next)
        return next
      })
    },
    [currentTeamId]
  )

  const addHeadTile = useCallback(
    (id: string) => writeTiles((cur) => (cur.includes(id) ? cur : [...cur, id])),
    [writeTiles]
  )

  const setHeadTileAt = useCallback(
    (index: number, id: string | null) =>
      writeTiles((cur) => {
        if (id === null) return cur.filter((_, i) => i !== index)
        // Moving a tile onto a destination already on the grid would leave two
        // cells pointing at one page; drop the other rather than refuse.
        return cur.map((v, i) => (i === index ? id : v)).filter((v, i) => i === index || v !== id)
      }),
    [writeTiles]
  )

  const value = useMemo(
    () => ({
      alwaysShownIds,
      isAlwaysShown,
      toggleAlwaysShown,
      setShortcutOrder,
      recentIds,
      recordVisit: pushRecent,
      removeShortcut,
      clearShortcuts,
      headTileIds,
      addHeadTile,
      setHeadTileAt,
    }),
    [
      alwaysShownIds,
      isAlwaysShown,
      toggleAlwaysShown,
      setShortcutOrder,
      recentIds,
      pushRecent,
      removeShortcut,
      clearShortcuts,
      headTileIds,
      addHeadTile,
      setHeadTileAt,
    ]
  )

  return <NavPinsContext.Provider value={value}>{children}</NavPinsContext.Provider>
}

export function useNavPins(): NavPinsValue {
  const ctx = useContext(NavPinsContext)
  if (!ctx) throw new Error('useNavPins must be used within NavPinsProvider')
  return ctx
}

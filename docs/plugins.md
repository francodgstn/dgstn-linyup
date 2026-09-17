---
title: Plugins
status: living
area: platform
---
# Plugins

A plugin packages a feature that not every tenant gets. **Manifests are code**
(`apps/web/src/plugins/*/manifest.ts`, collected in `PLUGIN_REGISTRY`); **only
install state is data** (`teams/{teamId}/installed_plugins/{pluginId}` and
`organizations/{orgId}/installed_plugins/{pluginId}`, doc id = plugin id).

Install state is the gate. `pluginAccessForPlan` decides who *may* install;
studio/organization owners install client-side, Coach activates paid add-ons
through `activatePluginAddon`, and `firestore.rules` refuses a client install
below Studio so paid value cannot be self-granted.

---

## Bundles — a container of plugins

A **container** is a plugin whose install installs others. HMD was the first:
`hmd` holds `hmd-fighting-cup` and `hmd-belts`. **AI insights** (`ai`) is the
second and the first generic one: `ai-contact-summary`, `ai-member-recap`,
`ai-team-sentiment`, `ai-offer-drafting`.

```
organizations/hmd/installed_plugins/hmd                 ← the container: what a human writes
   config.modules = { 'hmd-fighting-cup': true }        ← DESIRED state
organizations/hmd/installed_plugins/hmd-fighting-cup    ← MATERIALIZED by the reconciler
   installedByBundle: 'hmd'                             ← provenance
```

### Why members are real plugins

Nine things consume install state — the sidebar, plugin nav rows, event types,
the automation rule builder, the server gate, five ad-hoc server gates, the
teardown trigger, billing, and `firestore.rules` — and every one keys off **a
document whose id is the plugin id**. A member that is an ordinary plugin
therefore resolves through all of them with no changes at all. Modelling modules
as a map inside one document would have broken all nine, and rules cannot read
into a config map to decide anything.

The container adds exactly one thing on top: a tenant discovers and installs
**one card**.

This is also why widening `hmd-fighting-cup` needed **no migration**. The
container was added *beside* it; the member kept its id, its `hmd_fighting_cup`
event-type value and its folder.

### Where the composition lives

`PLUGIN_BUNDLES` in `packages/shared/src/types/plugin-bundles.ts` — **not** in
the manifest. The server-side reconciler needs the member list and cannot import
`PLUGIN_REGISTRY` (that lives in `apps/web`). `PLUGIN_ADDONS` next door sets the
same precedent. Declaring it in both places would be a copy for a test to police.

**A member absent from `config.modules` is ON.** A module shipped after a tenant
installed the container must reach them without anybody editing their data; only
an explicit `false` switches one off, and being stored it survives every
reconcile. **But it arrives on the next reconcile, not on deploy:** the
reconciler runs when the container's install document is written, so an existing
install gains a new module the next time that document is saved (any module
switch does it).

### The reconciler

`packages/functions/src/plugins/bundleReconcile.ts` is the **one writer** of a
member install document, driven by two triggers (team + org) in
`bundleTriggers.ts`. It reads the container, diffs desired against actual, and
commits one batch.

Four rules, each of which is a bug if broken — all pinned by
`packages/functions/src/plugins/bundles.test.ts`:

- **Two loop breakers.** The `isBundleContainer` guard stops a member document
  this function just wrote from re-entering as if it were a container; the
  empty-diff early return stops a no-op commit re-firing the trigger it runs
  inside. Neither is an optimisation — without either, the first install loops.
- **It deletes; it never writes `status: 'inactive'`.** That marker means a plan
  lapse, and `orgs/orgTierRails.test.ts` allows exactly two writers of it.
- **It only removes what it created.** A member document without this
  container's `installedByBundle` stamp is a standalone install that predates
  the container, and deleting it would take away a feature the tenant chose for
  itself, config included.
- **`retry: true` is safe** precisely because the function is a pure function of
  current state. This is why it is *not* part of
  `onInstalledPluginStatusChange`, which carries a non-idempotent activation
  hook and must stay `retry: false`.

### The three bundle-aware places

Everything else is bundle-blind, and `bundles.test.ts` re-derives that split from
the source — a new file reading `PLUGIN_REGISTRY` fails until it is classified.

1. **Surfaces that offer an install** call `installableManifests()`: the
   marketplace grid and its `?plugin=` deep link, `DiscoverPanel`, and the org
   catalogue. A member is not offered; the container is.
2. **The reconciler.**
3. **The container's config panel**, plus `settings/event-types`, which keeps
   showing a member's event type (it offers no install) but gates on the
   **container's** audience and prints the **container's** name.

The switches are one component, `components/plugins/BundleModulesPanel.tsx`,
at either scope. HMD's live on the **org** plugins page, and have to: an
org-managed install deliberately shows no Configure control on a studio's own
settings page, and HMD installs at org level. **AI insights** (`ai`, since
2026-09-16 — the first generic container, see `docs/ai-insights.md`) installs at
the studio, so its switches render in the studio's Configure dialog through its
own `plugins/ai/ConfigPanel.tsx`.

A dependency BETWEEN members of one container is not a `PLUGIN_REQUIREMENTS`
entry: a requirement is written as a standalone install, which for a member
would be a document the reconciler does not own. AI insights' member recap needs
the contact briefing only because its button lives inside the briefing, so the
dependency is one of placement and is stated in the module's description.

---

## Requirements — a plugin that needs another

`PLUGIN_REQUIREMENTS` in `packages/shared/src/types/plugin-requirements.ts`:
"installing A requires B". Today: `finance` requires `asset-register`, because
the statement of assets is an accounting artifact over the register's records
and the accrual phase's depreciation postings will read them.

**A REQUIREMENT IS NOT A BUNDLE MEMBER**, and conflating the two is the way this
area goes wrong. A member is hidden from every catalogue, owned by one
container, stamped `installedByBundle`, and deleted when the container goes. A
requirement is a first-class plugin a tenant discovers, installs and KEEPS on
its own, which something else also happens to need. The bundle file rules itself
out for this anyway: "a container is never an `addon`", and `finance` is one.

**`reconcileRequirements` is the ONE writer** of a requirement install
(`packages/functions/src/plugins/requirementsReconcile.ts`), riding the same two
triggers as the bundle reconciler. It is a trigger and not the Install button
because there are **five** writers of an install document — the marketplace's
client `setDoc`, `activatePluginAddon`, `unlockPlugin`, `onTeamCreated`'s
`DEFAULT_TEAM_PLUGINS`, and `bundleReconcile` — and finance reaches a Coach
through `activatePluginAddon`, which never touches the client at all. A
dependency implemented at the install button would be silently absent for
exactly the tenants it matters most to.

It reconciles **both directions** from whichever document changed: a requirer
appearing materialises its requirements, and a requirement disappearing while a
requirer is still active puts it back. Two loop breakers, mirroring the bundle
reconciler: a plugin in neither side of the relation returns before any read,
and an empty diff returns before committing.

Three rules, each pinned by `packages/functions/src/plugins/requirements.test.ts`:

- **A requirement is installed as an ORDINARY standalone install** — no
  provenance stamp, and deliberately not `installedByBundle` (one writer of that
  field, and reusing it would make a requirement deletable by a container it
  does not belong to). It follows that **removing the requirer never removes the
  requirement**: after the fact it is indistinguishable from one the tenant
  chose, and it usually is.
- **No cascade.** Removing a plugin something else needs is refused in the
  marketplace, naming the requirer, with the confirm button disabled. That is
  the honest version of what the reconciler would do anyway.
- **A requirement is never a paid add-on and never gated above its requirer** —
  the reconciler installs it for free and `firestore.rules` must admit that
  install at the requirer's own tier.

---

## Audience — discovery, never running

`PluginAudience` + `pluginVisibleToTenant` keep one customer's name out of every
other tenant's catalogue. **Nothing that resolves an INSTALLED plugin consults
it.** A tenant dropped from the list keeps its card, its Configure and its
Remove — a list edit must not be a data change with an outage in it.

`pluginIsInstallable` is a separate, orthogonal predicate: audience asks "may
*this tenant* see it?", installability asks "does *anyone* install this
directly?" and does not depend on the tenant. Fusing them would overload a
function whose contract is that an absent audience means public.

---

## The server gate

`pluginIsActive(teamId, pluginId)` / `assertPluginInstalled` /
`resolveActivePluginInstall` in `packages/functions/src/utils/plugins.ts`.

**Gate creation, never consumption.** Selling a gift card is gated; redeeming one
already sold is not — that would be the studio keeping a customer's money and
giving nothing back.

**The plan requirement lives in the MANIFEST (`minPlan`), never in a second
runtime gate.** A callable that also calls `requirePlan(...)` is a second door on
the same room: the two drift, and the one nobody remembers is the one that
refuses a paying studio. `createPromoCode` carried exactly such a duplicate
(`requirePlan(teamId, 'studio')`) and it was removed when Promo Codes became a
plugin. A per-plugin limit like `PROMO_CODE_LIMITS` is a **ceiling, not a
door** — it caps how many a studio may create, it never decides whether they
may create at all.

**It resolves the team install, then the org one.** `org_id` IS the grant, the
same doctrine `useInstalledPlugins` states on the client. This function once read
the team path only, which made every org-level install invisible to every
server-side gate — a studio could see a feature in its own sidebar and be refused
by the callable behind it.

**An inactive team document does not veto an active org one**, and the obvious
reading is wrong here: the client filters to `status === 'active'` *first* and
only then lets a team entry take precedence. A server where the team document
wins merely by existing refuses what the studio can see.

**`resolveActivePluginInstalls` (plural) owns that precedence rule.** The
singular form reads the team document for `org_id` and delegates; a caller that
already holds the team document — `syncTeamPublicProfile` does, on every team
write — passes the `org_id` it is standing on and asks about several plugins in
one batch. Two `getAll` round trips whatever the plugin count.

### Where the gate must be, and the two seams that did not have it

Two places carried on as if a plugin could never be given back. Both were
`docs/plugins.md` Phase 1b, both are now closed, and both are pinned by
`packages/functions/src/plugins/installGate.test.ts`.

**The automation engine** dispatched `plugin:*` actions on the stored action id
alone: a rule composed while WhatsApp was installed kept sending after the plugin
was removed. The install is now resolved **once per rule**, in
`resolveActionResources`, into `ResolvedActions.activePlugins` — never per
contact, because a rule sweeps every contact in the team and the answer cannot
change mid-sweep. Fixing it uncovered a second defect: `hasResolvableActions` had
no arm for a plugin action, so a rule whose ONLY action was one was skipped
wholesale with the misleading "no executable action resources found" — a
WhatsApp-only automation had never run.

**`syncTeamPublicProfile`** probed the TEAM install path only, so an org-level
install was invisible to the one computation that decides what the PUBLIC sees:
a member studio could publish a site its own public profile then advertised as
absent. All four liveness probes (`website`, `kiosk`, `custom-forms`,
`gift-cards`) now go through the resolver. Two of the surfaces are additionally
gated on published content, so no studio can begin advertising something it
never created; `kiosk` has no such condition and correctly so — an org install IS
the grant.

That change is **eventually consistent by design**: nothing fans an org install
out to its member teams, so each studio's surfaces recompute on its own next team
write. A trigger on org installs touching every member team is a write
amplification this flag does not justify, and the previous behaviour was not
"later" but "never".

**The plugin id inside `plugin:{id}:{name}` is parsed in ONE place** —
`pluginIdOfNamespacedId` in `packages/shared/src/types/plugin.ts`, beside the id
types. Rank-progression requirements use the same shape and the same function
(`pluginIdOfRequirement` is an alias, asserted to be identical).

---

## Contributions

A manifest DECLARES; a registry IMPLEMENTS. Declarations must be serializable
data (catalogues and rule builders read them without loading plugin code);
implementations must be code. That is why `automationActions` sits in the
manifest while `pluginActionHandlers` sits in `packages/functions/src/plugins/`.

| Contribution | Declared | Resolved |
|---|---|---|
| Sidebar rows | `navContributions` | `usePluginNavEntries` (`(auth)/layout.tsx`) |
| Event type | `eventType` | `useEventTypes`, `CheckinPanel` |
| Automation triggers/actions | `automationTriggers` / `automationActions` | `pluginActionHandlers` |
| Icons | `iconName`, `navContributions[].icon` | `PLUGIN_ICON_MAP` (`plugins/icons.tsx`) |
| UI components | `hasOwnerConfig`, `eventType.has*` | `pluginSlot()` (`plugins/slots.ts`), by convention |

**`pluginSlot` resolves by convention**: a plugin ships
`@/plugins/{id}/{Slot}.tsx` exporting a symbol named for the slot, and nothing
central is edited. The slot names are a closed union because a typo in a dynamic
import path fails at runtime, in the one branch that renders it. The per-slot
`switch` is deliberate — a fully dynamic path would make webpack build a context
over every file under `plugins/`.

Icons resolve through **one** map. There used to be three, and they had already
drifted: the org catalogue's copy was missing five icons, so five plugins
rendered a fallback puzzle piece on that page and nowhere else. The map stays
explicit rather than using `DynamicIcon`, which reaches its result via
`import * as LucideIcons` and would pull the whole icon set into the
authenticated layout.

---

## Adding a plugin

1. `apps/web/src/plugins/<id>/manifest.ts`, registered in `registry.ts`.
2. Its icon in `plugins/icons.tsx` if not already there.
3. Message keys via `apps/web/messages/_pending/<lane>.json`, then
   `pnpm i18n:merge` — **never edit the four locale files directly**.
4. A teardown arm in `onInstalledPluginStatusChange` **only** if the plugin
   publishes something public; if you add one, add its copy to
   `REMOVE_EFFECT_KEY`, because the default text promises the data is kept.
5. To make it a bundle member: one line in `PLUGIN_BUNDLES`. Nothing else — the
   catalogues and the reconciler follow.
6. To make another plugin depend on it: one line in `PLUGIN_REQUIREMENTS`.
   Nothing else — `reconcileRequirements` and the marketplace's blocked-remove
   follow. If its `minPlan` is below Studio, remember the
   `CLIENT_INSTALLABLE_FROM` / `clientInstallableRank` pair (both, or the build
   fails).

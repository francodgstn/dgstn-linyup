// Tears down plugin-specific public artefacts when a plugin is deactivated —
// and runs per-plugin ACTIVATION hooks (finance: seed chart + rebuild ledger).
// Triggered on every write to teams/{teamId}/installed_plugins/{pluginId}.
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import {
  unpublishSiteForTeam,
  deleteAllCoursePublicProfiles,
  touchTeamForSurfaceRecompute,
} from '../utils/plugins'
import { rebuildLedgerForTeam } from '../accounting/rebuild'
import { revokeAllApiKeys } from '../api/auth/credentials'
import { API_CONNECTORS_PLUGIN_ID, KEEP_COURSE_MIRRORS_FIELD } from '@linyup/shared'

export const onInstalledPluginStatusChange = onDocumentWritten(
  'teams/{teamId}/installed_plugins/{pluginId}',
  async (event) => {
    const { teamId, pluginId } = event.params

    const beforeStatus = event.data?.before.exists
      ? (event.data.before.data()?.status as string | undefined)
      : undefined
    const afterStatus = event.data?.after.exists
      ? (event.data.after.data()?.status as string | undefined)
      : undefined

    // Recompute active_public_surfaces on EVERY write — not just deactivation.
    // Installing a plugin (or editing its config, e.g. kiosk's denormalized
    // public subset) can flip a surface live just as much as deactivating one
    // can flip it dark, so this must run unconditionally, ahead of the
    // teardown-only early-return below.
    await touchTeamForSurfaceRecompute(teamId)

    const wasActive = beforeStatus === 'active'
    const isStillActive = afterStatus === 'active'

    // ACTIVATION hook — finance plugin: seed the chart of accounts + settings
    // and replay the whole finance journal into the accounting ledger, so the
    // ledger appears fully populated the moment the plugin is installed. Fires
    // for studio/org direct installs AND coach add-on installs alike (both
    // write this doc). Timeout note: the default trigger window comfortably
    // covers current journal volumes; the "Rebuild ledger" button is the
    // manual escape hatch for anything bigger.
    if (pluginId === 'finance' && !wasActive && isStillActive) {
      try {
        await rebuildLedgerForTeam(teamId)
      } catch (err) {
        console.error(`[accounting] install-time rebuild failed team=${teamId}:`, err)
      }
      return
    }

    // Only tear down plugin-specific public artefacts when transitioning away
    // from 'active':
    //   - doc deleted (afterStatus undefined) while it was active before, OR
    //   - status changed from 'active' to something else
    if (!wasActive || isStillActive) return

    if (pluginId === 'website') {
      // Tear down published site: remove site_published/{teamId} + flag draft disabled.
      await unpublishSiteForTeam(teamId)
    } else if (pluginId === 'online-courses') {
      // …UNLESS the write that deactivated this install said to keep them.
      //
      // The mirror is not decoration: the Space resolves a course by slug from
      // it, so deleting it takes a course away from the contact who BOUGHT it
      // (the `purchases/{contactId}` entitlement survives — the surface does
      // not), and nothing rewrites a mirror on reinstall (UX-16). On an
      // ORGANISATION lapse that would punish a member for a third party's
      // unpaid bill, so `downgradeTeamToFree` stamps its disposition onto this
      // very document and this arm obeys it. Without this check, sparing the
      // mirrors over there is silently undone here a second later.
      if (event.data?.after.data()?.[KEEP_COURSE_MIRRORS_FIELD] === true) {
        console.log(
          `[plugins] team ${teamId}: online-courses deactivated, course mirrors KEPT ` +
            `(bought courses stay openable)`
        )
        return
      }
      // Batch-delete all course/public_profile summaries for this team.
      await deleteAllCoursePublicProfiles(teamId)
    } else if (pluginId === API_CONNECTORS_PLUGIN_ID) {
      // An external DOOR, not a public artefact: every key the team issued stops
      // working the moment the plugin goes (removal, lapse, downgrade to Free).
      // Creation is the only place the install gate sits (api/keys.ts), so
      // without this arm an uninstalled team would keep reading through keys it
      // already held. Reinstalling does NOT bring them back — revoked is final.
      const revoked = await revokeAllApiKeys(teamId, 'system')
      console.log(`[plugins] team ${teamId}: api-connectors deactivated, ${revoked} API key(s) revoked`)
    }
    // NOTE: 'documents' has NO teardown any more, because Documents is no longer
    // a plugin — there is no install to deactivate. The arm that used to delete
    // every document mirror is gone together with deleteAllDocumentPublicProfiles
    // itself, which also settles a live asymmetry: downgradeTeamToFree tore down
    // `website` and `online-courses` synchronously but left documents to this
    // trigger. A waiver's text is somebody's evidence and its public copy is
    // linked from a booking form; a plan change must not delete it.
    // NOTE: 'finance' intentionally has NO teardown — accounting/journal data
    // are financial records and persist across deactivation (a coach add-on
    // cancel deletes the install doc but never the data); reinstall re-seeds
    // idempotently and the rebuild reconciles the gap.
  }
)

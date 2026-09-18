// The per-team live-contact counter, stamped once every contact is imported.
//
// `teams/{teamId}/counters/contacts` is what the operator console reads instead
// of running a `count()` per tenant on every page view. Two writers keep it in
// the live system — the `trackContacts` trigger (deltas) and the nightly
// platform-metrics job (authoritative) — and a migration is neither: it writes
// contacts straight to Firestore, so an imported studio has no counter at all.
//
// On a deployed project the nightly job fixes that by morning. The HMD import's
// normal home is the EMULATOR (scripts/MIGRATE-HMD.md), where no scheduler ever
// runs, so it would stay wrong for as long as the snapshot lives — and wrong in
// the worse direction than blank: `trackContacts` does run locally, and its
// `increment()` on a missing document CREATES it at 1, so a migrated club of two
// hundred reads `live: 1` the moment anyone adds a contact.
//
// LAST, deliberately. It stores an ABSOLUTE count, so it has to see the final
// state of the contacts collection — after pass 05 imports them and after
// anything later touches their liveness markers.
import type { MigrationConfig } from '../config'
import { targetDb } from '../config'
import { writeTeamContactCounter } from '../../lib/contactCounter'

export async function pass18ContactCounters(
  cfg: MigrationConfig,
  teamIds: string[],
): Promise<void> {
  console.log('\nPass 18 — contact counters')
  if (cfg.dryRun) {
    console.log(`   (dry run) would stamp the live-contact counter for ${teamIds.length} team(s)`)
    return
  }
  let total = 0
  for (const teamId of teamIds) {
    const live = await writeTeamContactCounter(targetDb, teamId)
    total += live
    console.log(`   ${teamId}: ${live} live`)
  }
  console.log(`   ✓ ${teamIds.length} counter(s) stamped, ${total} live contacts in total`)
}

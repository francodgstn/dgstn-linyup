// The long jobs, behind one function: the callables that run for minutes or want a
// gigabyte — publishing a website, rebuilding the accounting ledger, a bulk
// Tarif 595 run, an outreach send, a scores recalculation, the store-presence
// refresh (docs/functions-consolidation-plan.md → "Phase 2").
//
// They are together BECAUSE of what a router does to options: the ROUTER's
// memory and timeout govern and a member's own are ignored. Left in their domain
// routers they would stretch every quick call beside them to nine minutes and a
// gigabyte; here the expensive profile is paid only by the calls that need it.
//
// Concurrency is LOW on purpose. These are memory-hungry and CPU-bound for their
// whole run, so a second one on the same instance is competition, not sharing.
//
// Every member ALSO stays exported standalone from src/index.ts until its alias
// is provably unused (utils/frozenFunctions.test.ts says why). Authorisation is
// each member's own; the router adds none and removes none. This module must NOT
// call `setGlobalOptions` — src/index.ts owns it.

import { callableRouter } from '../utils/callableRouter'
import { rebuildAccountingLedger } from '../accounting/rebuild'
import { refreshStorePresence } from '../appstores/ops'
import { recalculateScoresFromDate } from '../gamification/recalculateScoresFromDate'
import { publishOrgWebsite } from '../orgWebsite'
import { sendOutreachEmail } from '../outreach'
import { startTarif595BulkIssue } from '../tarif595'
import { publishWebsite } from '../website'

export const rpcHeavy = callableRouter(
  'rpcHeavy',
  {
    // The max of the members': the scores recalculation asks for 1GiB, and most
    // of them for 540s.
    memory: '1GiB',
    timeoutSeconds: 540,
    cpu: 1,
    concurrency: 4,
  },
  {
    rebuildAccountingLedger,
    refreshStorePresence,
    recalculateScoresFromDate,
    publishOrgWebsite,
    sendOutreachEmail,
    startTarif595BulkIssue,
    publishWebsite,
  }
)

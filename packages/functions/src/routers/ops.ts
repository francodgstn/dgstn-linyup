// The operator console's callables, behind one function.
//
// The pilot router (docs/functions-consolidation-plan.md → "Phase 1"), chosen
// because its only callers are operators in the admin app: a bad deploy here
// inconveniences us and no studio, and no member-app binary calls any of it.
//
// Every member ALSO stays exported standalone from src/index.ts until its alias
// is provably unused — see utils/frozenFunctions.test.ts for why a name must
// never be dropped just because a router lists it.
//
// Authorisation is each member's own `requireOperator`; the router adds none and
// removes none. This module must NOT call `setGlobalOptions` — src/index.ts owns it.

import { callableRouter } from '../utils/callableRouter'
import { manageDemoTenant, setReviewAccess, getReviewAccess } from '../ops'
import { resyncTenantFeeRate } from '../ops/feeRate'
import { previewPlatformNotice, sendPlatformNotice } from '../ops/platformNotices'

export const rpcOps = callableRouter(
  'rpcOps',
  {
    // The ROUTER's options govern at runtime, so they are the max of the
    // members': the demo-tenant rebuild and the platform-notice send both run
    // to 540s, and the rebuild asks for 512MiB.
    timeoutSeconds: 540,
    memory: '512MiB',
    // Explicit, or a function this small defaults to a fractional CPU, which
    // pins concurrency to 1 (routers/spike.ts has the long version). A handful
    // of operators is the whole audience, so both numbers stay small.
    cpu: 1,
    concurrency: 10,
    maxInstances: 3,
  },
  {
    manageDemoTenant,
    setReviewAccess,
    getReviewAccess,
    resyncTenantFeeRate,
    previewPlatformNotice,
    sendPlatformNotice,
  }
)

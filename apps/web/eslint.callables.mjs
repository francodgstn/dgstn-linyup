// Tripwire: a Cloud Function is called through `callFunction`, never by name.
//
// Callables are served by domain routers (docs/functions-consolidation-plan.md),
// and each app's `callFunction` is the one place that knows which router serves
// a name. A bare `httpsCallable(functions, 'x')` still WORKS against a callable
// that keeps a function of its own — which is what makes it a trap rather than a
// bug anybody would notice:
//
//   - it bypasses the router, so that name never goes quiet, and a name that
//     never goes quiet can never be removed (scripts/alias-usage.mjs);
//   - against a callable that ONLY a router serves — every callable added since
//     the routers, and every one whose alias was removed — it is a 404 in
//     production, found by the first user to press the button.
//
// Shared by apps/web, apps/admin and apps/mobile, the way
// eslint.firestorePaths.mjs is. The one file allowed to import these names in each
// app is its callFunction helper, exempted in that app's own config.
export const noDirectCallables = {
  paths: [
    {
      name: 'firebase/functions',
      importNames: ['httpsCallable', 'httpsCallableFromURL'],
      message:
        "Call a Cloud Function through callFunction('name'), never httpsCallable directly: callables are served by routers, and only callFunction knows which. See CLAUDE.md → 'Callables are served by routers'.",
    },
  ],
}

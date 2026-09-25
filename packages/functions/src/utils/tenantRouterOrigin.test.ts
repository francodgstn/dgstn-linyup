// THE CUSTOM-DOMAIN WORKER MUST FORWARD TO THE BACKEND PRODUCTION SHIPS TO.
//
// Studios' own domains (book.theirdojo.ch) are served by the tenant-router
// Worker (infra/workers/tenant-router), which forwards every request to the
// App Hosting backend named in its `ORIGIN` var. Production releases reach the
// web app only through the rollout in .github/workflows/deploy-prod.yml. Those
// two names live in two files owned by two deploys, and nothing tied them:
// production moved from `linyup-web` (us-central1) to `linyup-web-eu`, and the
// Worker kept forwarding to the old backend, which stopped receiving releases
// on 2026-08-25. Every custom domain would have served that build while
// app.linyup.com moved on, and broken outright once the callable aliases the
// old build still calls were removed.
//
// This reads SOURCE, so the extractors are tested against synthetic input
// below, including what they must NOT match (a commented-out line), and the
// real check was run against the defect before it was trusted.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** src/utils → packages/functions → packages → the repo root. */
const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

type Origin = { backend: string; project: string; region: string }

/** The Worker's ORIGIN, from wrangler.jsonc. Whole-line // comments are
 *  dropped first; a trailing comment cannot hide a value (`https://` is not
 *  a comment), and exactly one ORIGIN must remain. */
export function workerOrigin(jsonc: string): Origin {
  const live = jsonc
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  const found = [...live.matchAll(/"ORIGIN"\s*:\s*"https:\/\/([a-z0-9-]+?)--([a-z0-9-]+)\.([a-z0-9-]+)\.hosted\.app\/?"/g)]
  if (found.length !== 1) throw new Error(`expected one ORIGIN on a *.hosted.app backend, found ${found.length}`)
  const [, backend, project, region] = found[0]
  return { backend, project, region }
}

/** Every backend a workflow rolls out to one Firebase project alias. YAML
 *  comment lines are dropped, so a disabled rollout does not count. */
export function rolloutBackends(yaml: string, alias: string): Set<string> {
  const live = yaml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
  const re = new RegExp(`apphosting:rollouts:create\\s+([A-Za-z0-9-]+)\\s+--project\\s+${alias}\\b`, 'g')
  return new Set([...live.matchAll(re)].map((m) => m[1]))
}

describe('tenant-router origin — the extractors see what they claim to see', () => {
  it('workerOrigin: reads backend, project and region; ignores a commented-out ORIGIN', () => {
    const src = [
      '{',
      '  "vars": {',
      '    // "ORIGIN": "https://old-web--linyup-prod.us-central1.hosted.app"',
      '    "ORIGIN": "https://linyup-web-eu--linyup-prod.europe-west4.hosted.app"',
      '  }',
      '}',
    ].join('\n')
    assert.deepEqual(workerOrigin(src), { backend: 'linyup-web-eu', project: 'linyup-prod', region: 'europe-west4' })
  })

  it('workerOrigin: refuses zero or two ORIGINs rather than guessing', () => {
    assert.throws(() => workerOrigin('{ "vars": {} }'))
    const two = '"ORIGIN": "https://a--p.r.hosted.app"\n"ORIGIN": "https://b--p.r.hosted.app"'
    assert.throws(() => workerOrigin(two))
  })

  it('rolloutBackends: only the named alias, and not a commented-out line', () => {
    const yaml = [
      '  run: npx firebase-tools apphosting:rollouts:create linyup-web-eu --project production --git-commit "$SHA"',
      '  run: npx firebase-tools apphosting:rollouts:create linyup-admin-eu --project production',
      '  # run: npx firebase-tools apphosting:rollouts:create linyup-web --project production',
      '  run: npx firebase-tools apphosting:rollouts:create linyup-web --project productionish',
      '  run: npx firebase-tools apphosting:rollouts:create linyup-web --project sandbox',
    ].join('\n')
    assert.deepEqual([...rolloutBackends(yaml, 'production')].sort(), ['linyup-admin-eu', 'linyup-web-eu'])
  })
})

describe('tenant-router origin — custom domains get what production gets', () => {
  const origin = workerOrigin(read('infra/workers/tenant-router/wrangler.jsonc'))
  const prodProject = (JSON.parse(read('.firebaserc')) as { projects: Record<string, string> }).projects.production
  const shipped = rolloutBackends(read('.github/workflows/deploy-prod.yml'), 'production')

  it('forwards to the production project — custom domains are production-only', () => {
    assert.equal(origin.project, prodProject)
  })

  it('forwards to a backend deploy-prod.yml rolls out, and not the operator console', () => {
    assert.ok(shipped.size > 0, 'deploy-prod.yml rolls out no App Hosting backend: the extractor no longer matches it')
    assert.ok(
      shipped.has(origin.backend),
      `the Worker forwards to "${origin.backend}", but production releases roll out ${[...shipped].join(', ')}`,
    )
    assert.ok(!origin.backend.includes('admin'), `"${origin.backend}" is the operator console, not the web app`)
  })
})

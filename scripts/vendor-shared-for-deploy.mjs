#!/usr/bin/env node
/**
 * Prepare packages/functions for Firebase deploy in a pnpm monorepo.
 *
 * Cloud Build (used by `firebase deploy` to build Cloud Functions) runs plain
 * `npm install` on the uploaded packages/functions directory. npm does not
 * understand pnpm's `workspace:*` protocol and fails with:
 *
 *   npm error code EUNSUPPORTEDPROTOCOL
 *   npm error Unsupported URL Type "workspace:": workspace:*
 *
 * Cloud Build only ever sees the contents of `packages/functions`, never the
 * sibling `packages/shared`, so a `workspace:` / `file:../shared` reference can
 * never resolve there. This script vendors the *built* @linyup/shared package
 * INTO packages/functions and rewrites the dependency to a self-contained
 * `file:./vendor/shared` reference that npm can install.
 *
 * It mutates packages/functions/package.json and writes packages/functions/vendor/
 * — both are intended to happen only in the ephemeral CI checkout (vendor/ is
 * gitignored). The committed package.json keeps `workspace:*` so local pnpm and
 * tsc keep working unchanged.
 */
import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sharedDir = join(repoRoot, 'packages', 'shared')
const functionsDir = join(repoRoot, 'packages', 'functions')
const vendorDir = join(functionsDir, 'vendor', 'shared')

const log = (msg) => console.log(`[vendor-shared] ${msg}`)

// 1. Build @linyup/shared so dist/ exists.
log('building @linyup/shared…')
execSync('pnpm --filter @linyup/shared run build', { cwd: repoRoot, stdio: 'inherit' })

const sharedDist = join(sharedDir, 'dist')
if (!existsSync(sharedDist)) {
  throw new Error(`expected ${sharedDist} to exist after build`)
}

// 2. Copy the built package (dist + package.json) into packages/functions/vendor/shared.
log(`vendoring into ${vendorDir}`)
rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })
cpSync(sharedDist, join(vendorDir, 'dist'), { recursive: true })
cpSync(join(sharedDir, 'package.json'), join(vendorDir, 'package.json'))
// The node10-resolution subpath stubs (see packages/shared/tarif595-positions.js).
for (const stub of ['tarif595-positions.js', 'tarif595-positions.d.ts']) {
  cpSync(join(sharedDir, stub), join(vendorDir, stub))
}

// 3. Rewrite the functions package.json dependency to the vendored copy so the
//    npm install Cloud Build runs no longer chokes on `workspace:*`.
const pkgPath = join(functionsDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
if (!pkg.dependencies?.['@linyup/shared']) {
  throw new Error('expected @linyup/shared in packages/functions dependencies')
}
pkg.dependencies['@linyup/shared'] = 'file:./vendor/shared'
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

log('done — @linyup/shared rewritten to file:./vendor/shared')

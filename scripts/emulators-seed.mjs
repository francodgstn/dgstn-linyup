#!/usr/bin/env node
/**
 * Starts Firebase emulators (auth, firestore, functions, storage), waits for
 * them, seeds the database, then keeps running until Ctrl+C.
 *
 * Usage (two terminals):
 *   Terminal 1:  pnpm emulators:seed
 *   Terminal 2:  pnpm dev:web
 */

import { spawn } from 'child_process'
import { createConnection } from 'net'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// THE EMULATOR CAN LOAD ZERO FUNCTIONS AND SAY NOTHING. Its default discovery
// timeout is short, and on a cold Windows run the functions build plus the
// module graph regularly outruns it — the CLI then serves an EMPTY function
// registry, so every callable the app makes answers `internal` with no clue
// anywhere as to why. `emulators-run.mjs` has raised it since it was written;
// this script, which is the one most people start, did not.
process.env.FUNCTIONS_DISCOVERY_TIMEOUT ??= '120'

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT, ...opts })
}

function waitForPort(port, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    function attempt() {
      const sock = createConnection(port, '127.0.0.1')
      sock.on('connect', () => { sock.destroy(); resolve() })
      sock.on('error', () => {
        sock.destroy()
        if (Date.now() > deadline) reject(new Error(`Port ${port} not available after ${timeoutMs}ms`))
        else setTimeout(attempt, 1000)
      })
    }
    attempt()
  })
}

function runToCompletion(cmd, args) {
  return new Promise((resolve) => {
    const p = run(cmd, args)
    p.on('exit', (code) => resolve(code ?? 0))
  })
}

// Is something ALREADY listening here? (The inverse of waitForPort.) Resolves
// true on a successful connect, false on error or after a short timeout.
function probePortInUse(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = createConnection(port, '127.0.0.1')
    const done = (inUse) => {
      sock.destroy()
      resolve(inUse)
    }
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
    setTimeout(() => done(false), timeoutMs)
  })
}

// REFUSE if an emulator is already running. `seed-emulator.ts` issues a DELETE
// against Firestore + Auth as its FIRST act, and the bare `waitForPort(8080)`
// below would be satisfied by ANOTHER session's emulator on :8080 — this would
// then wipe that session's data, and if it runs with --export-on-exit, overwrite
// its snapshot on Ctrl+C (the "Emulator port collision" trap, and how
// snapshots/all and snapshots/hmd-migration get clobbered). So probe the wipe
// targets first and stop loudly, the way emulators-demo.mjs fails on a missing
// snapshot rather than guessing.
for (const port of [8080, 9099]) {
  if (await probePortInUse(port)) {
    console.error(`\n❌ Something is already listening on :${port} — another Firebase emulator`)
    console.error('   (or a different seed/dev suite) is already running.')
    console.error('   `pnpm emulators:seed` WIPES Firestore + Auth as its FIRST act, so it')
    console.error("   refuses rather than silently erasing that session's data — and any")
    console.error('   --export-on-exit snapshot it would overwrite on Ctrl+C.')
    console.error('   Stop the other emulator first (Ctrl+C in its terminal, or bluntly')
    console.error('   `taskkill /F /IM java.exe`), then run this again.\n')
    process.exit(1)
  }
}

console.log('==> Building @linyup/shared…')
const sharedBuildCode = await runToCompletion('pnpm', ['--filter', '@linyup/shared', 'run', 'build'])
if (sharedBuildCode !== 0) {
  console.error('❌ Shared package build failed')
  process.exit(1)
}

console.log('==> Building Cloud Functions…')
const buildCode = await runToCompletion('pnpm', ['--filter', '@linyup/functions', 'run', 'build'])
if (buildCode !== 0) {
  console.error('❌ Functions build failed')
  process.exit(1)
}

console.log('==> Starting Firebase emulators (auth, firestore, functions, storage)')
const emulators = run('pnpm', ['exec', 'firebase', 'emulators:start',
  '--only', 'auth,firestore,functions,storage', '--project', 'demo-linyup'])

function cleanup() { try { emulators.kill() } catch {} }
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// Say WHY when the emulator dies. Without this the keep-alive at the bottom of
// this file is the only thing holding the event loop open, so the moment the
// child exits Node unwinds with code 13 and the words "unsettled top-level
// await" — which describes this script's plumbing and not the actual cause.
// A half-dead emulator then looks identical to a crashed script.
//
// The causes seen in practice, all of which the child reports and this used to
// swallow: a port still held by a previous run mid-teardown (the CLI aborts with
// "port taken" even for the hub on 4400 or the UI on 4000, not just the four we
// wait on), a stale emulator JVM, or an orphaned firebase-tools process holding
// sockets that `netstat -ano | grep LISTENING` does not show.
emulators.on('exit', (code, signal) => {
  if (signal === 'SIGTERM' || signal === 'SIGINT') return // our own cleanup
  console.error(
    `\n❌ The Firebase emulators exited (${signal ? `signal ${signal}` : `code ${code}`}).` +
      '\n   Scroll up — the CLI printed the reason. If it mentions a port being taken,' +
      '\n   a previous run is still shutting down or has left a process behind:' +
      '\n     pnpm exec firebase emulators:exec --only auth,firestore true   # or, bluntly:' +
      '\n     taskkill /F /IM java.exe                                       # stale emulator JVMs' +
      '\n   then run this again.\n'
  )
  process.exit(code ?? 1)
})

console.log('==> Waiting for Firestore emulator on :8080')
await waitForPort(8080)
console.log('==> Waiting for Auth emulator on :9099')
await waitForPort(9099)
console.log('==> Waiting for Functions emulator on :5001')
await waitForPort(5001)
console.log('==> Waiting for Storage emulator on :9199')
await waitForPort(9199)
console.log('    emulators up')

console.log('==> Seeding emulator data')
// The seed then waits for the trigger queue it causes to drain (minutes, not
// seconds), so "Ready" below means the derived data exists too. An explicitly
// empty value opts out. See scripts/lib/triggerDrain.ts.
process.env.SEED_FUNCTIONS_EMULATOR_HOST ??= '127.0.0.1:5001'
const seedCode = await runToCompletion('pnpm', ['exec', 'tsx', 'scripts/seed-emulator.ts'])
if (seedCode !== 0) console.log('    seed failed (continuing anyway)')

console.log('\n✅ Ready — start the web app in another terminal: pnpm dev:web\n')

// Keep process alive so emulators stay up
await new Promise(() => {})

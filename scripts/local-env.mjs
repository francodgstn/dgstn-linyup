#!/usr/bin/env node
/**
 * scripts/local-env.mjs — the control surface for the LOCAL stack.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * This repo is developed from several git worktrees at once (`.claude/worktrees/*`
 * plus the main checkout), and every one of them wants the same emulator suite on
 * the same ports. Two failure modes follow, and both are SILENT:
 *
 *   1. A second suite cannot bind :8080, so the seeder — which wipes Firestore and
 *      Auth as its first act — writes into WHOEVER is already listening. Another
 *      session's data is gone and the banner still says "Ready".
 *   2. The functions emulator serves `packages/functions/dist` from the checkout
 *      that STARTED it, and never reloads it. A worktree can rebuild all day and
 *      keep testing another branch's code, with no error anywhere.
 *
 * So ports are assigned by SLOT, one slot per checkout, and everything here reports
 * WHICH CHECKOUT owns a running service rather than merely whether a port answers.
 *
 * Slot 0 is the main checkout on the documented default ports. Slots 1..3 are
 * worktrees, offset by slot*10000. The ceiling is 3 because slot 4 would put auth
 * on :49099, inside Windows' dynamic port range (49152 is the default floor, and
 * the floor is configurable downward) — a stack that works until the day the OS
 * happened to take the port first is worse than no fourth slot.
 *
 * Usage:
 *   node scripts/local-env.mjs status [--json]
 *   node scripts/local-env.mjs init [--slot N] [--no-copy]
 *   node scripts/local-env.mjs env [--slot N] [--shell bash|pwsh]
 *   node scripts/local-env.mjs stop  [--slot N|--all] [--yes]
 *   node scripts/local-env.mjs kill  [--slot N|--all] [--yes]
 *   node scripts/local-env.mjs reset [--slot N] --yes [--force]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILT_PACKAGES, distState } from './lib/distState.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const MAX_SLOT = 3
const OFFSET = 10_000
const SLOT_FILE = '.local-env.json'
const FIREBASE_LOCAL = 'firebase.local.json'

// Every port the local stack can hold, at slot 0. `emulator: true` means the
// Firebase CLI binds it and a collision is fatal to the whole suite.
const SERVICES = {
  web: { port: 3000, label: 'web (Next)' },
  hostingEm: { port: 3001, label: 'hosting emu', emulator: true },
  admin: { port: 3002, label: 'admin (Next)' },
  ui: { port: 4000, label: 'emulator UI', emulator: true },
  landing: { port: 4321, label: 'landing (Astro)' },
  hub: { port: 4400, label: 'emulator hub', emulator: true },
  logging: { port: 4500, label: 'emulator logging', emulator: true },
  functions: { port: 5001, label: 'functions', emulator: true },
  metro: { port: 8081, label: 'metro (Expo)' },
  firestore: { port: 8080, label: 'firestore', emulator: true },
  database: { port: 9000, label: 'RTDB', emulator: true },
  auth: { port: 9099, label: 'auth', emulator: true },
  fsws: { port: 9150, label: 'firestore ws', emulator: true },
  storage: { port: 9199, label: 'storage', emulator: true },
  tasks: { port: 9499, label: 'tasks', emulator: true },
}

// The ports whose presence means "a stack is running here". A stray Next dev
// server is not a running stack; a listening Firestore or Auth emulator is.
const KEY_SERVICES = ['firestore', 'auth', 'functions', 'ui']

const portFor = (svc, slot) => SERVICES[svc].port + slot * OFFSET

// ── shell helpers ────────────────────────────────────────────────────────────

function git(args, cwd = ROOT) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

let PWSH = null
function powershell(script) {
  if (!WIN) return ''
  if (PWSH === null) {
    PWSH =
      spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0
        ? 'pwsh'
        : 'powershell'
  }
  const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return r.stdout || ''
}

/** Every worktree of this repo, main checkout first (git guarantees that order). */
function worktrees() {
  const out = git(['worktree', 'list', '--porcelain'])
  const list = []
  for (const block of out.split(/\r?\n\r?\n+/)) {
    const path = block.match(/^worktree (.+)$/m)
    if (!path) continue
    const branch = block.match(/^branch (.+)$/m)
    list.push({
      path: resolve(path[1].trim()),
      branch: branch ? branch[1].trim().replace('refs/heads/', '') : '(detached)',
    })
  }
  return list
}

function slotOfCheckout(path) {
  const f = join(path, SLOT_FILE)
  if (!existsSync(f)) return null
  try {
    const v = JSON.parse(readFileSync(f, 'utf8')).slot
    return Number.isInteger(v) ? v : null
  } catch {
    return null
  }
}

// ── who is listening ─────────────────────────────────────────────────────────

/** port -> pid, for every LISTENING TCP socket on the machine. */
function listeners() {
  const map = new Map()
  if (WIN) {
    const out =
      spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).stdout || ''
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+?:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
      if (m && !map.has(Number(m[1]))) map.set(Number(m[1]), Number(m[2]))
    }
  } else {
    const out = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' }).stdout || ''
    let pid = null
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      else if (line.startsWith('n')) {
        const m = line.match(/:(\d+)$/)
        if (m && pid && !map.has(Number(m[1]))) map.set(Number(m[1]), pid)
      }
    }
  }
  return map
}

/** pid -> {pid, ppid, name, started:Date|null, cmd} */
function processInfo(pids) {
  const info = new Map()
  const uniq = [...new Set(pids)].filter(Boolean)
  if (!uniq.length) return info
  if (WIN) {
    const filter = uniq.map((p) => `ProcessId=${p}`).join(' OR ')
    const json = powershell(
      `@(Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,Name,CommandLine,` +
        `@{n='Started';e={$_.CreationDate.ToString('o')}}) | ConvertTo-Json -Compress -Depth 3`
    )
    try {
      const parsed = JSON.parse(json || '[]')
      for (const p of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!p) continue
        info.set(p.ProcessId, {
          pid: p.ProcessId,
          ppid: p.ParentProcessId,
          name: p.Name,
          started: p.Started ? new Date(p.Started) : null,
          cmd: p.CommandLine || '',
        })
      }
    } catch {
      /* leave what we have — status degrades to ports-only rather than failing */
    }
  } else {
    const out =
      spawnSync('ps', ['-o', 'pid=,ppid=,lstart=,comm=,args=', '-p', uniq.join(',')], { encoding: 'utf8' })
        .stdout || ''
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.*)$/)
      if (!m) continue
      const d = new Date(m[3])
      info.set(Number(m[1]), {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        name: m[4],
        started: isNaN(d.getTime()) ? null : d,
        cmd: m[5],
      })
    }
  }
  return info
}

/** Walk up from a listener to the `firebase … emulators:start` supervisor. */
function findSupervisor(pid, info) {
  let cur = info.get(pid)
  let hops = 0
  while (cur && hops++ < 8) {
    if (/emulators:start/.test(cur.cmd)) return cur
    const parent = processInfo([cur.ppid]).get(cur.ppid)
    if (!parent) return null
    info.set(parent.pid, parent)
    cur = parent
  }
  return null
}

// ── health probes ────────────────────────────────────────────────────────────

async function probe(url, init, timeoutMs = 4000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    return { ok: true, status: res.status, body: await res.text() }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally {
    clearTimeout(t)
  }
}

/**
 * THE probe that matters. The functions emulator can start with an EMPTY registry
 * — discovery timing out, or an unanswered `defineString` prompt in a non-TTY —
 * and say nothing at all. Every callable then answers a bare `internal`, which
 * reads as an app bug. Asking for a function that cannot exist makes the CLI list
 * the ones that do.
 */
async function functionsRegistry(port) {
  const r = await probe(`http://127.0.0.1:${port}/demo-linyup/europe-west6/__localEnvProbe__`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"data":{}}',
  })
  if (!r.ok) return { reachable: false }
  const m = (r.body || '').match(/valid functions are:\s*([^"]*)/i)
  if (!m) return { reachable: true, count: null }
  const names = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return { reachable: true, count: names.length }
}

// ── slot model ───────────────────────────────────────────────────────────────

function describeSlots(listen, info) {
  const wts = worktrees()
  const owners = new Map() // slot -> checkout path (claimed, not necessarily running)
  const mainPath = wts[0]?.path
  if (mainPath) owners.set(0, mainPath)
  for (const wt of wts.slice(1)) {
    const s = slotOfCheckout(wt.path)
    if (s !== null && !owners.has(s)) owners.set(s, wt.path)
  }
  const slots = []
  for (let slot = 0; slot <= MAX_SLOT; slot++) {
    const services = {}
    for (const [name, def] of Object.entries(SERVICES)) {
      const port = portFor(name, slot)
      const pid = listen.get(port) ?? null
      services[name] = { name, label: def.label, port, pid, up: pid !== null }
    }
    const anchor = services.firestore.pid ?? services.auth.pid ?? services.ui.pid
    const owner = owners.get(slot) ?? null
    slots.push({
      slot,
      owner,
      branch: wts.find((w) => w.path === owner)?.branch ?? null,
      services,
      running: KEY_SERVICES.some((k) => services[k].up),
      supervisor: anchor ? findSupervisor(anchor, info) : null,
    })
  }
  return { slots, worktrees: wts }
}

function fmtAge(d) {
  if (!d) return 'unknown'
  const ms = Date.now() - d.getTime()
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h ago` : h ? `${h}h ${m}m ago` : `${m}m ago`
}

function distMtime(checkout) {
  try {
    return statSync(join(checkout, 'packages', 'functions', 'dist', 'index.js')).mtime
  } catch {
    return null
  }
}

const rel = (p) => (p.startsWith(ROOT) ? '.' + p.slice(ROOT.length) : p)

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdStatus(flags) {
  const listen = listeners()
  const info = processInfo([...listen.values()])
  const { slots } = describeSlots(listen, info)
  const mySlot = slotOfCheckout(ROOT)

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          checkout: ROOT,
          slot: mySlot,
          slots: slots.map((s) => ({
            slot: s.slot,
            owner: s.owner,
            branch: s.branch,
            running: s.running,
            supervisorPid: s.supervisor?.pid ?? null,
            supervisorStarted: s.supervisor?.started?.toISOString() ?? null,
            services: Object.fromEntries(
              Object.entries(s.services).map(([k, v]) => [k, { port: v.port, up: v.up, pid: v.pid }])
            ),
          })),
        },
        null,
        2
      )
    )
    return
  }

  console.log('')
  console.log(`  checkout  ${ROOT}`)
  console.log(`  branch    ${git(['branch', '--show-current']) || '(detached)'}`)
  console.log(`  slot      ${mySlot === null ? 'UNCLAIMED — run `node scripts/local-env.mjs init`' : mySlot}`)
  // A dist older than its src is served as-is by everything that bypasses turbo
  // (dev servers, the emulator, seeders, backfills) — and fails as an app bug.
  for (const pkg of BUILT_PACKAGES) {
    const d = distState(ROOT, pkg)
    if (d.state === 'fresh') continue
    console.log(
      `  ! ${d.state === 'missing' ? 'MISSING' : 'STALE'}   ${pkg.dir}/dist ${
        d.state === 'missing' ? 'has never been built' : `is older than its src (built ${fmtAge(d.built)}, src changed ${fmtAge(d.srcChanged)})`
      } — run \`pnpm bootstrap\``
    )
  }
  console.log('')

  for (const s of slots) {
    const mine = s.owner === ROOT
    const head = `slot ${s.slot}${s.slot === 0 ? ' (main checkout)' : ''}`
    if (!s.running && !s.owner) {
      console.log(`  ${head}  free`)
      continue
    }
    console.log(`  ${head}  ${s.running ? 'RUNNING' : 'idle'}${mine ? '   <- this checkout' : ''}`)
    if (s.owner) console.log(`    owner      ${s.owner}${s.branch ? `  [${s.branch}]` : ''}`)
    if (!s.running) {
      console.log('')
      continue
    }

    const up = Object.values(s.services).filter((x) => x.up)
    console.log(`    listening  ${up.map((x) => `${x.name}:${x.port}`).join('  ')}`)

    if (s.supervisor) {
      const cfg = s.supervisor.cmd.match(/--config[= ](\S+)/)
      console.log(
        `    emulators  pid ${s.supervisor.pid}, started ${
          s.supervisor.started?.toLocaleString() ?? '?'
        } (${fmtAge(s.supervisor.started)})${cfg ? `, --config ${cfg[1]}` : ''}`
      )
      const imp = s.supervisor.cmd.match(/--import[= ](\S+)/)
      const exp = s.supervisor.cmd.match(/--export-on-exit[= ](\S+)/)
      if (imp || exp) {
        console.log(`    SNAPSHOT   ${imp ? `import ${imp[1]}` : ''}${exp ? `  export-on-exit ${exp[1]}` : ''}`)
        console.log('               Reseeding or wiping this slot destroys that snapshot on exit.')
      }
      // Is it serving code older than the owning checkout's last build?
      if (s.owner) {
        const built = distMtime(s.owner)
        if (built && s.supervisor.started && built > s.supervisor.started) {
          console.log(`    ! STALE    packages/functions/dist was rebuilt ${fmtAge(built)}, AFTER this emulator started.`)
          console.log('               The functions emulator never reloads dist — it is serving the older build.')
          console.log('               Restart the slot before trusting anything observed through a callable.')
        }
      }
    } else {
      console.log('    emulators  supervisor not identified (the listener may be an orphan — use `kill`)')
    }

    if (s.services.functions.up) {
      const reg = await functionsRegistry(s.services.functions.port)
      if (!reg.reachable) console.log('    functions  UNREACHABLE on its port')
      else if (reg.count === null) console.log('    functions  reachable (registry not enumerable)')
      else if (reg.count === 0) {
        console.log('    ! EMPTY    the functions registry holds ZERO functions. Every callable will answer a')
        console.log('               bare `internal`. Cause is almost always a packages/functions/.env.local')
        console.log('               param missing (an unanswered prompt) or a discovery timeout.')
      } else console.log(`    functions  ${reg.count} loaded`)
    }

    for (const app of ['web', 'admin', 'landing', 'metro']) {
      if (!s.services[app].up) continue
      const path = app === 'metro' ? '/status' : '/'
      const r = await probe(`http://127.0.0.1:${s.services[app].port}${path}`, { redirect: 'manual' }, 3000)
      console.log(`    ${app.padEnd(9)}  :${s.services[app].port} -> ${r.ok ? `HTTP ${r.status}` : 'not answering'}`)
    }
    console.log('')
  }

  const free = slots.filter((s) => !s.running && !s.owner).map((s) => s.slot)
  if (free.length) console.log(`  free slots: ${free.join(', ')}`)
  console.log('')
}

function pickSlot() {
  const existing = slotOfCheckout(ROOT)
  if (existing !== null) return existing
  const wts = worktrees()
  if (wts[0] && wts[0].path === ROOT) return 0
  const taken = new Set([0])
  for (const wt of wts.slice(1)) {
    const s = slotOfCheckout(wt.path)
    if (s !== null) taken.add(s)
  }
  const listen = listeners()
  for (let s = 1; s <= MAX_SLOT; s++) {
    if (taken.has(s)) continue
    if (KEY_SERVICES.some((k) => listen.has(portFor(k, s)))) continue
    return s
  }
  return null
}

// Files the main checkout has and a worktree does not: they are gitignored, so a
// fresh worktree starts with no env vars, no provider secrets and no lead
// profile — and every failure that causes looks like a code bug.
const IMPORTS = [
  { path: 'apps/web/.env.local', why: 'web Firebase config + NEXT_PUBLIC_USE_EMULATORS' },
  { path: 'apps/admin/.env.local', why: 'admin Firebase config + OPERATOR_EMAILS' },
  { path: 'packages/functions/.env.local', why: 'EVERY defineString param — one missing hangs function discovery' },
  { path: 'apps/mobile/.env.staging', why: 'the staging web API key the member app targets by default' },
  { path: 'apps/landing/.env', why: 'landing site URLs + optional PostHog key' },
  { path: 'scripts/leads/.env.local', why: 'lead demo passwords + Stripe test account ids' },
  { path: 'scripts/leads', why: 'lead profiles (each lead dir is gitignored)', subdirsOnly: true },
  { path: 'keys', why: 'service-account keys (migrate:hmd source creds)', dir: true },
]

function cmdInit(flags) {
  const wts = worktrees()
  const main = wts[0]?.path
  if (!main) {
    console.error('Not a git worktree — cannot locate the main checkout.')
    process.exit(1)
  }
  const isMain = main === ROOT
  const slot = flags.slot ?? pickSlot()
  if (slot === null) {
    console.error(`All slots 0..${MAX_SLOT} are claimed. Free one with \`stop\`, or delete a stale ${SLOT_FILE}.`)
    process.exit(1)
  }
  console.log('')
  console.log(`  checkout ${ROOT}`)
  console.log(`  slot     ${slot}${isMain ? ' (main checkout — default ports)' : ''}`)
  console.log('')

  // 1. Import the untracked files only the main checkout has.
  if (!isMain && !flags['no-copy']) {
    console.log('  importing untracked files from the main checkout:')
    for (const item of IMPORTS) {
      const from = join(main, item.path)
      const to = join(ROOT, item.path)
      if (!existsSync(from)) {
        console.log(`    -  ${item.path}  (absent in the main checkout too)`)
        continue
      }
      if (item.subdirsOnly) {
        let copied = 0
        for (const entry of readdirSync(from, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const dst = join(to, entry.name)
          if (existsSync(dst)) continue
          cpSync(join(from, entry.name), dst, { recursive: true })
          copied++
          console.log(`    +  ${item.path}/${entry.name}/`)
        }
        if (!copied) console.log(`    =  ${item.path}/*  (already present)`)
        continue
      }
      if (existsSync(to)) {
        console.log(`    =  ${item.path}  (kept — already present)`)
        continue
      }
      mkdirSync(dirname(to), { recursive: true })
      cpSync(from, to, { recursive: !!item.dir })
      console.log(`    +  ${item.path}   — ${item.why}`)
    }
    console.log('')
  }

  // 2. Record the slot.
  writeFileSync(join(ROOT, SLOT_FILE), JSON.stringify({ slot, checkout: ROOT }, null, 2) + '\n')
  console.log(`  wrote ${SLOT_FILE}`)

  // 3. Generate the offset emulator config (slot 0 uses firebase.json as-is).
  if (slot > 0) {
    const base = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'))
    delete base.hosting // the landing site target — never wanted in a worktree suite
    const em = base.emulators
    for (const def of Object.values(em)) {
      if (def && typeof def === 'object' && typeof def.port === 'number') def.port += slot * OFFSET
    }
    // The CLI binds these two even though firebase.json never declares them, and a
    // port declared in the config never auto-shifts — so an undeclared hub is a
    // hard collision with slot 0. Same story for the Firestore UI websocket.
    em.hub = { host: '0.0.0.0', port: portFor('hub', slot) }
    em.logging = { host: '0.0.0.0', port: portFor('logging', slot) }
    em.firestore.websocketPort = portFor('fsws', slot)
    base._comment = `GENERATED by scripts/local-env.mjs for slot ${slot} — do not edit, do not commit.`
    writeFileSync(join(ROOT, FIREBASE_LOCAL), JSON.stringify(base, null, 2) + '\n')
    console.log(`  wrote ${FIREBASE_LOCAL}  (every emulator port +${slot * OFFSET})`)
  }

  // 4. Point the apps at this slot's emulator.
  writeEnvBlock(join(ROOT, 'apps/web/.env.local'), slot, {
    NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: portFor('firestore', slot),
    NEXT_PUBLIC_AUTH_EMULATOR_PORT: portFor('auth', slot),
    NEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT: portFor('functions', slot),
    NEXT_PUBLIC_STORAGE_EMULATOR_PORT: portFor('storage', slot),
  })
  writeEnvBlock(join(ROOT, 'apps/admin/.env.local'), slot, {
    NEXT_PUBLIC_AUTH_EMULATOR_PORT: portFor('auth', slot),
    NEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT: portFor('functions', slot),
    FIRESTORE_EMULATOR_HOST: `localhost:${portFor('firestore', slot)}`,
    FIREBASE_AUTH_EMULATOR_HOST: `localhost:${portFor('auth', slot)}`,
  })
  // Expo loads .env.local on its own (before app.config.js runs), for every
  // start mode; the ports only take effect under the emulator target, so the
  // block is harmless to `pnpm dev:mobile` against staging. No template owns
  // this file, so it is created here.
  writeEnvBlock(
    join(ROOT, 'apps/mobile/.env.local'),
    slot,
    {
      EXPO_PUBLIC_FIRESTORE_EMULATOR_PORT: portFor('firestore', slot),
      EXPO_PUBLIC_AUTH_EMULATOR_PORT: portFor('auth', slot),
      EXPO_PUBLIC_FUNCTIONS_EMULATOR_PORT: portFor('functions', slot),
    },
    { create: true }
  )

  console.log('')
  console.log('  start this slot with:')
  console.log('')
  printStartCommands(slot)
}

/**
 * Replace a managed block in a .env.local, removing any loose earlier definition
 * of the same keys first. dotenv takes the LAST definition in a file, so an
 * appended block does win — but a leftover line above it makes the file lie to
 * whoever reads it, and reading it is exactly what happens when the ports are
 * suspected.
 */
function writeEnvBlock(file, slot, vars, { create = false } = {}) {
  if (!existsSync(file)) {
    if (!create) {
      console.log(`  !  ${rel(file)} missing — nothing to patch (run \`pnpm bootstrap\` first)`)
      return
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '# Local overrides for this checkout (gitignored).\n')
  }
  const BEGIN = '# >>> local-env slot'
  const END = '# <<< local-env <<<'
  let text = readFileSync(file, 'utf8')
  text = text.replace(new RegExp(`\\r?\\n?${BEGIN}[\\s\\S]*?${END}\\r?\\n?`, 'g'), '\n')
  for (const key of Object.keys(vars)) {
    text = text.replace(new RegExp(`^${key}=.*$\\r?\\n?`, 'gm'), '')
  }
  const block =
    `${BEGIN} ${slot} — generated by scripts/local-env.mjs, safe to regenerate >>>\n` +
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') +
    `\n${END}\n`
  writeFileSync(file, text.replace(/\s*$/, '\n\n') + block)
  console.log(`  patched ${rel(file)}  -> slot ${slot} ports`)
}

function printStartCommands(slot) {
  if (slot === 0) {
    console.log('    pnpm emulators:seed          # wipes + seeds, then stays up')
    console.log('    pnpm dev:web                 # :3000')
    console.log('    pnpm dev:admin               # :3002')
    console.log('    pnpm dev:mobile:emulators    # Expo/Metro :8081, against this stack')
  } else {
    console.log(
      `    node scripts/emulators-run.mjs --config ${FIREBASE_LOCAL} --only auth,firestore,functions,storage --project demo-linyup`
    )
    console.log(`    PORT=${portFor('web', slot)} pnpm dev:web`)
    console.log(`    pnpm --filter @linyup/admin exec next dev --turbopack --port ${portFor('admin', slot)}`)
    console.log(`    pnpm dev:mobile:emulators -- --port ${portFor('metro', slot)}`)
    console.log('')
    console.log(`    # then seed it:  node scripts/local-env.mjs reset --slot ${slot} --yes`)
  }
  console.log('')
  console.log(`    Emulator UI  http://localhost:${portFor('ui', slot)}`)
  console.log(`    web          http://localhost:${portFor('web', slot)}`)
  console.log('')
}

function cmdEnv(flags) {
  const slot = flags.slot ?? slotOfCheckout(ROOT) ?? 0
  const vars = {
    FIRESTORE_EMULATOR_HOST: `localhost:${portFor('firestore', slot)}`,
    FIREBASE_AUTH_EMULATOR_HOST: `localhost:${portFor('auth', slot)}`,
    FIREBASE_STORAGE_EMULATOR_HOST: `localhost:${portFor('storage', slot)}`,
    FIREBASE_DATABASE_EMULATOR_HOST: `localhost:${portFor('database', slot)}`,
  }
  const shell = flags.shell || (WIN ? 'pwsh' : 'bash')
  for (const [k, v] of Object.entries(vars)) {
    console.log(shell === 'pwsh' ? `$env:${k} = '${v}'` : `export ${k}=${v}`)
  }
}

function targetSlots(flags, verb) {
  if (flags.all) {
    if (!flags.yes) {
      console.error(`Refusing to ${verb} EVERY slot without --yes. Another checkout may be mid-demo.`)
      process.exit(1)
    }
    return Array.from({ length: MAX_SLOT + 1 }, (_, i) => i)
  }
  const mine = slotOfCheckout(ROOT)
  const slot = flags.slot ?? mine
  if (slot === null || slot === undefined) {
    console.error('No slot for this checkout. Pass --slot N, or run `init` first.')
    process.exit(1)
  }
  if (slot !== mine && !flags.yes) {
    console.error(
      `Slot ${slot} is not this checkout's slot (${mine === null ? 'unclaimed' : mine}).\n` +
        'Another session may be using it — re-run with --yes if you mean it.'
    )
    process.exit(1)
  }
  return [slot]
}

function cmdStopKill(flags, force) {
  const verb = force ? 'kill' : 'stop'
  const slots = targetSlots(flags, verb)
  const listen = listeners()
  let survivors = 0
  for (const slot of slots) {
    const pids = new Set()
    for (const name of Object.keys(SERVICES)) {
      const pid = listen.get(portFor(name, slot))
      if (pid) pids.add(pid)
    }
    if (!pids.size) {
      console.log(`  slot ${slot}: nothing listening`)
      continue
    }
    const info = processInfo([...pids])
    // Take the supervisor down first: it carries its own children with it, so the
    // per-port pass afterwards only ever mops up genuine orphans. Set order gives
    // that for free, and de-duplicates a supervisor that is itself a listener.
    const supervisors = new Set()
    for (const pid of pids) {
      const s = findSupervisor(pid, info)
      if (s) supervisors.add(s.pid)
    }
    const targets = [...new Set([...supervisors, ...pids])]

    // A forced kill skips the CLI's shutdown hook, and that hook is what writes
    // an --export-on-exit snapshot. Losing one is not recoverable, so make the
    // caller say it means to.
    const exporter = [...supervisors]
      .map((pid) => info.get(pid))
      .find((p) => p && /--export-on-exit/.test(p.cmd))
    if (force && exporter && !flags.force) {
      const m = exporter.cmd.match(/--export-on-exit[= ](\S+)/)
      console.error('')
      console.error(`  slot ${slot} was started with --export-on-exit ${m ? m[1] : ''}.`)
      console.error('  A forced kill skips the export — that snapshot keeps whatever it held last time.')
      console.error('  Press Ctrl+C in the terminal that owns it, or re-run with --force to accept the loss.')
      process.exit(1)
    }

    for (const pid of targets) {
      const p = info.get(pid)
      const label = p ? `${p.name} ${pid}` : `pid ${pid}`
      if (WIN) {
        const args = ['/PID', String(pid), '/T']
        if (force) args.push('/F')
        const r = spawnSync('taskkill', args, { encoding: 'utf8' })
        const err = ((r.stderr || '') + (r.status === 0 ? '' : r.stdout || '')).trim()
        // taskkill without /F asks politely via a window message, which a node or
        // java process has no way to receive — so "graceful" simply is not on
        // offer here. Report that in one line rather than eleven of its stderr.
        const detail =
          r.status === 0
            ? 'ok'
            : /only be terminated forcefully|child processes/i.test(err)
              ? 'needs `kill` (no graceful path on Windows)'
              : /not found|no running/i.test(err)
                ? 'already gone'
                : err.split('\n')[0] || 'failed'
        if (detail !== 'ok' && detail !== 'already gone') survivors++
        console.log(`  slot ${slot}: ${verb} ${label} — ${detail}`)
      } else {
        try {
          process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
          console.log(`  slot ${slot}: ${verb} ${label} — ok`)
        } catch {
          console.log(`  slot ${slot}: ${label} — already gone`)
        }
      }
    }
  }
  console.log('')
  if (survivors) {
    console.log('  Some processes refused a graceful stop. Run `kill` to force them,')
    console.log('  or press Ctrl+C in the terminal that owns the emulator.')
  } else {
    console.log('  Re-run `status` in a few seconds to confirm the ports are free.')
  }
}

function cmdReset(flags) {
  const mine = slotOfCheckout(ROOT)
  const slot = flags.slot ?? mine
  if (slot === null || slot === undefined) {
    console.error('No slot for this checkout. Pass --slot N, or run `init` first.')
    process.exit(1)
  }
  if (slot !== mine) {
    console.error(`Slot ${slot} belongs to another checkout — reset it from there, where its code lives.`)
    process.exit(1)
  }
  if (!flags.yes) {
    console.error(
      `reset WIPES Firestore + Auth on slot ${slot} and reseeds the demo tiers.\n` +
        'Re-run with --yes if that is what you want.'
    )
    process.exit(1)
  }
  const listen = listeners()
  const fsPort = portFor('firestore', slot)
  const authPort = portFor('auth', slot)
  if (!listen.has(fsPort) || !listen.has(authPort)) {
    console.error(
      `Slot ${slot} is not running (need firestore :${fsPort} and auth :${authPort}).\n` +
        'Start it first — reset seeds a live emulator, it does not launch one.'
    )
    process.exit(1)
  }
  const info = processInfo([listen.get(fsPort), listen.get(authPort)])
  const sup = findSupervisor(listen.get(fsPort), info)
  if (sup && /--(import|export-on-exit)/.test(sup.cmd) && !flags.force) {
    console.error('')
    console.error(`Slot ${slot} was started against a SNAPSHOT:`)
    console.error(`  ${sup.cmd.slice(0, 300)}`)
    console.error('')
    console.error('Reseeding wipes it, and --export-on-exit then overwrites the snapshot on disk when that')
    console.error('emulator stops. Lead and demo tenants live in those snapshots. Pass --force only once you')
    console.error('have confirmed the snapshot is expendable.')
    process.exit(1)
  }
  console.log('')
  console.log(`  reseeding slot ${slot} (firestore :${fsPort}, auth :${authPort})`)
  console.log('')
  const r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/seed-emulator.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      FIRESTORE_EMULATOR_HOST: `localhost:${fsPort}`,
      FIREBASE_AUTH_EMULATOR_HOST: `localhost:${authPort}`,
      FIREBASE_STORAGE_EMULATOR_HOST: `localhost:${portFor('storage', slot)}`,
      // Hold the seed until the trigger queue it causes has drained — minutes,
      // not seconds. An explicitly empty value opts out. See lib/triggerDrain.ts.
      SEED_FUNCTIONS_EMULATOR_HOST:
        process.env.SEED_FUNCTIONS_EMULATOR_HOST ?? `127.0.0.1:${portFor('functions', slot)}`,
    },
  })
  process.exit(r.status ?? 1)
}

// ── entry ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const [k, inline] = a.slice(2).split('=')
    if (inline !== undefined) flags[k] = inline
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
    else flags[k] = true
  }
  if (flags.slot !== undefined && flags.slot !== true) flags.slot = Number(flags.slot)
  return flags
}

const [cmd, ...rest] = process.argv.slice(2)
const flags = parseArgs(rest)

switch (cmd) {
  case 'status':
    await cmdStatus(flags)
    break
  case 'init':
    cmdInit(flags)
    break
  case 'env':
    cmdEnv(flags)
    break
  case 'stop':
    cmdStopKill(flags, false)
    break
  case 'kill':
    cmdStopKill(flags, true)
    break
  case 'reset':
    cmdReset(flags)
    break
  default:
    console.log(`
  local-env — the LOCAL stack's control surface (emulators + dev servers, one slot per checkout)

    status [--json]                      what is running, in which slot, owned by which checkout
    init [--slot N] [--no-copy]          claim a slot; import the main checkout's untracked env /
                                         lead / key files; generate ${FIREBASE_LOCAL}; point the
                                         apps at this slot's ports
    env [--slot N] [--shell bash|pwsh]   emulator-host exports, for running a script against a slot
    stop [--slot N|--all] [--yes]        graceful shutdown
    kill [--slot N|--all] [--yes]        forced, plus orphaned listeners
    reset [--slot N] --yes [--force]     wipe + reseed a RUNNING slot

  Slots 0..${MAX_SLOT}. Slot 0 is the main checkout on default ports; slot N offsets every port by N*${OFFSET}.
`)
    process.exit(cmd ? 1 : 0)
}

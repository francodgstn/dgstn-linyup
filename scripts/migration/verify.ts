import type { Firestore } from 'firebase-admin/firestore'
import type { ReadonlyFirestore } from './config'
import { sourceDb, targetDb, EXCLUDED_SOURCE_TEAMS } from './config'

interface CountResult { collection: string; src: number; tgt: number; ok: boolean }

async function countCollection(db: ReadonlyFirestore | Firestore, name: string): Promise<number> {
  const snap = await db.collection(name).count().get()
  return snap.data().count
}

export async function verify(teamIds: string[], sampled = false): Promise<void> {
  console.log('\n=== Verification ===')
  const src = sourceDb()
  const tgt = targetDb()

  // COUNT LIKE WITH LIKE, OR THE CHECK CRIES WOLF FOREVER.
  //
  // These collections are team-scoped, and the migration only carries documents
  // belonging to a team it actually migrated. HMD's production data has 596
  // contacts whose `teamId` points at a DELETED team — correctly skipped, and
  // counted as missing by a raw collection-count comparison. That is not a
  // near-miss: the first real run reported "2 collection(s) have fewer docs in
  // target than source" and looked exactly like 596 lost contacts until the
  // orphans were counted by hand.
  //
  // So the source side is scoped to the migrated teams, the same population the
  // migration was ever going to write.
  const teamScoped = ['activities', 'session_series', 'contacts', 'sessions', 'events']
  const results: CountResult[] = []

  async function countScoped(name: string): Promise<number> {
    let total = 0
    for (const teamId of teamIds) {
      const snap = await src.collection(name).where('teamId', '==', teamId).count().get()
      total += snap.data().count
    }
    return total
  }

  for (const col of ['users', 'teams', 'activities', 'session_series', 'contacts', 'sessions', 'events', 'referrals']) {
    // `users` is filtered a different way — pass 1 migrates ACTIVE users only —
    // so a raw count over-reports there too. It is left raw and flagged rather
    // than silently reconciled, because "how many users are active" is the
    // migration's own judgment and not something this check should re-derive.
    // A SAMPLE IMPORTS THREE CLUBS OUT OF SIXTEEN, and `teams` is the one row
    // that would call that a failure: its source side is a raw collection count,
    // so it compares the whole federation against the handful that was asked
    // for. The expected number under `--teams` is the size of the sample.
    //
    // Every other row already survives sampling — the team-scoped ones are
    // scoped to the same ids, and `users` and `referrals` are migrated whole
    // either way.
    // AND THE EXCLUDED CLUBS ARE NOT MISSING DATA. `EXCLUDED_SOURCE_TEAMS` is
    // deliberately not copied, so the raw source count is higher than the target
    // by exactly that many and the row would read as a failed migration forever.
    // Subtracted rather than special-cased per collection: the excluded club's
    // contacts and sessions are already absent from `countScoped`, which walks
    // the MIGRATED team ids.
    const s =
      sampled && col === 'teams'
        ? teamIds.length
        : teamScoped.includes(col)
          ? await countScoped(col)
          : col === 'teams'
            ? (await countCollection(src, col)) - EXCLUDED_SOURCE_TEAMS.length
            : await countCollection(src, col)
    const t = await countCollection(tgt, col)
    results.push({ collection: col, src: s, tgt: t, ok: col === 'users' ? true : t >= s })
  }

  console.table(results)

  // AN EMPTY SOURCE IS A FAILED RUN, NOT A CLEAN ONE.
  //
  // `ok` is `tgt >= src`, so every row passes trivially when the source returns
  // nothing — and the run then prints "All counts OK" and "Migration complete"
  // having read zero documents. That is not hypothetical: it happens the moment
  // FIRESTORE_EMULATOR_HOST is exported before the script starts, because
  // `initApps` locks in the SOURCE connection while those vars are still unset
  // and an already-set one silently points the source at the emulator too.
  // Losing an hour to a green migration that moved nothing is the cheap version
  // of that mistake; trusting one is the expensive version.
  if (results.every((r) => r.src === 0)) {
    console.error('FAIL: every source collection is EMPTY - the source read nothing,' + ' so this run proved nothing.')
    console.error('      Check the service-account key, and make sure' + ' FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are NOT set in the' + ' environment: --target-emulator sets them itself, after the source' + ' connection is established.')
    process.exitCode = 1
    return
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.warn(`WARN: ${failed.length} collection(s) have fewer docs in target than source`)
  } else {
    console.log('All counts OK')
  }
  console.log(
    "  note: team-scoped rows count only source docs on a MIGRATED team; 'users' is raw," +
      ' and the target legitimately exceeds it (pass 1 migrates active users only).'
  )
  if (sampled) {
    console.log(
      `  note: SAMPLE run — ${teamIds.length} club(s) of the source's total. Counts are` +
        ' scoped to them, so this proves the sample is complete, NOT the federation.'
    )
  }

  // Spot-check: 3 contacts per team
  for (const teamId of teamIds.slice(0, 3)) {
    const snap = await src.collection('contacts').where('teamId', '==', teamId).limit(3).get()
    for (const d of snap.docs) {
      const tgtDoc   = await tgt.collection('contacts').doc(d.id).get()
      const goalsSnap = await tgt.collection('contacts').doc(d.id).collection('goals').get()
      const histSnap  = await tgt.collection('contacts').doc(d.id).collection('subscription_history').get()
      console.log(
        `  contact ${d.id} (team ${teamId}):`,
        tgtDoc.exists ? 'exists' : 'MISSING',
        `goals=${goalsSnap.size}`,
        `sub_history=${histSnap.size}`,
      )
    }
  }
}

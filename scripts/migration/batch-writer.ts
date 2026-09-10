import type { Firestore, DocumentReference, DocumentData, WriteBatch } from 'firebase-admin/firestore'

const BATCH_LIMIT = 499

export class BatchWriter {
  private db: Firestore
  private dryRun: boolean
  private batch: WriteBatch
  private opCount = 0
  private pendingFlushes: Promise<void>[] = []
  totalWritten = 0
  totalSkipped = 0

  constructor(db: Firestore, dryRun: boolean) {
    this.db = db
    this.dryRun = dryRun
    this.batch = db.batch()
  }

  set(ref: DocumentReference, data: DocumentData) {
    if (this.dryRun) { this.totalWritten++; return }
    this.batch.set(ref, data)
    this.opCount++
    if (this.opCount >= BATCH_LIMIT) this.rotate()
  }

  merge(ref: DocumentReference, data: DocumentData) {
    if (this.dryRun) { this.totalWritten++; return }
    this.batch.set(ref, data, { merge: true })
    this.opCount++
    if (this.opCount >= BATCH_LIMIT) this.rotate()
  }

  delete(ref: DocumentReference) {
    if (this.dryRun) { this.totalWritten++; return }
    this.batch.delete(ref)
    this.opCount++
    if (this.opCount >= BATCH_LIMIT) this.rotate()
  }

  skip() { this.totalSkipped++ }

  private rotate() {
    const batch = this.batch
    const count = this.opCount
    // Swap to a fresh batch synchronously so the next set() call never touches
    // the batch that is about to be committed.
    this.batch = this.db.batch()
    this.opCount = 0
    this.pendingFlushes.push(
      batch.commit().then(() => { this.totalWritten += count })
    )
  }

  async done() {
    if (!this.dryRun && this.opCount > 0) {
      await this.batch.commit()
      this.totalWritten += this.opCount
      this.opCount = 0
    }
    await Promise.all(this.pendingFlushes)
    console.log(`  → wrote ${this.totalWritten}, skipped ${this.totalSkipped}`)
  }
}

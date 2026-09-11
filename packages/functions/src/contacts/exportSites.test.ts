import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// EVERY CSV A STUDIO CAN DOWNLOAD, AND WHAT IT READS.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// A client-side export writes out the array the page is holding. That is
// correct only while the page holds the WHOLE set — and Phase 1 of
// docs/scalability-2026-09.md paged several lists that exports were reading
// (§18, point 4). The forms CSV was one of them: paging the Responses tab
// silently turned "export all responses" into "export the first fifty", with
// no error and nothing on screen to notice. It now reads the whole set itself,
// on the click.
//
// So: an export whose source list is UNBOUNDED belongs on a callable; one whose
// source is bounded by a single entity (one event's check-ins) or one period
// (a month's journal) may stay in the browser. This file is the gate on that
// rule — it spans the functions/web boundary on purpose, exactly like
// connect/commitSites.test.ts, because that boundary is where corrections stop
// travelling.
//
// ── WHY IT IS A TEST AND NOT A COMMENT ──────────────────────────────────────
// CLAUDE.md forbids a comment that asserts a COUNT of code sites, and allows a
// test to, because there the number is executable. A new export lands here as a
// failure with its file named, and the author either justifies it in the list
// below or moves it to a callable.

const WEB_SRC = resolve(__dirname, '../../../../apps/web/src')

/** A file that builds a CSV blob in the browser, and why that is allowed. */
const CLIENT_SIDE_EXPORTS: Record<string, string> = {
  'components/events/CheckinPanel.tsx':
    'one event\u2019s check-ins \u2014 bounded by that event\u2019s attendance',
  'app/[locale]/(auth)/plugins/custom-forms/[formId]/page.tsx':
    'reads the whole set itself via fetchAllSubmissions; the LIST beside it is paged',
  'app/[locale]/(auth)/plugins/finance/entries/page.tsx':
    'one accounting period\u2019s entries \u2014 the query is period-scoped',
  'app/[locale]/(auth)/plugins/finance/reports/page.tsx':
    'monthly rollups \u2014 one row per month',
  'app/[locale]/(auth)/plugins/asset-register/page.tsx':
    'the asset register \u2014 config-scale, authored by the studio',
  'plugins/hmd-fighting-cup/csvExport.ts':
    'one competition\u2019s competitors \u2014 bounded by the event',
}

/** Exports that go through a callable, so the browser never holds the set. */
const CALLABLE_BACKED = [
  'components/contacts/ExportContactsButton.tsx',
  'components/payments/ExportFinanceCsvButton.tsx',
]

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue
      yield* walk(p)
    } else if (/\.tsx?$/.test(name)) {
      yield p
    }
  }
}

function csvBuilders(): string[] {
  const out: string[] = []
  for (const file of walk(WEB_SRC)) {
    const src = readFileSync(file, 'utf8')
    if (/new Blob\(\[[^\]]*\],\s*\{\s*type:\s*'text\/csv/.test(src)) {
      out.push(relative(WEB_SRC, file).split('\\').join('/'))
    }
  }
  return out.sort()
}

describe('CSV exports', () => {
  it('every CSV the browser builds is from a bounded or self-fetched source', () => {
    const found = csvBuilders()
    const allowed = new Set([...Object.keys(CLIENT_SIDE_EXPORTS), ...CALLABLE_BACKED])
    const unlisted = found.filter((f) => !allowed.has(f))
    assert.deepEqual(
      unlisted,
      [],
      'a new CSV export appeared in apps/web \u2014 if its source list is paged or unbounded, ' +
        'move it to a callable (see contacts/exportContacts.ts); otherwise add it to ' +
        'CLIENT_SIDE_EXPORTS with the reason it is bounded',
    )
  })

  it('every listed export still exists — a stale entry is a rotted claim', () => {
    const found = new Set(csvBuilders())
    const missing = [...Object.keys(CLIENT_SIDE_EXPORTS), ...CALLABLE_BACKED].filter(
      (f) => !found.has(f),
    )
    assert.deepEqual(missing, [], 'these listed exports are gone — remove them from this file')
  })

  // The one that was actually wrong, pinned by name: the Responses tab pages,
  // so its export must not read the page.
  it('the forms export fetches the whole set rather than the rendered page', () => {
    const src = readFileSync(
      join(WEB_SRC, 'app/[locale]/(auth)/plugins/custom-forms/[formId]/page.tsx'),
      'utf8',
    )
    assert.match(src, /fetchAllSubmissions\(form\.id\)/)
    assert.doesNotMatch(src, /exportCsv\(form, submissions\)/)
  })
})

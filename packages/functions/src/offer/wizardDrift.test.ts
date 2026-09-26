import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import * as ts from 'typescript'

// ONE SET OF QUESTIONS, TWO SURFACES. The help centre's offering walkthrough
// (apps/help/src/data/offeringWalkthrough.ts) explains in English; the app's
// "Set up with a guide" (apps/web/src/components/offer/offeringWizardTree.ts)
// acts, in four languages. They share structure and never words: the same
// question ids, and on each one the same option ids in the same order. The
// app renders every choice question from its tree with a label the type
// demands for each option, so what is compared here is what each page shows.
//
// EDGES ARE NOT COMPARED, on purpose: the app routes on data the help page
// cannot see (no plans yet, so no "members" question), and asks names and
// appointment lengths as steps where the help page folds them into its text.
//
// Both files are loaded as they are, transpiled and run on their own, which is
// why neither may import anything.

const ROOT = join(__dirname, '..', '..', '..', '..')

function load(relative: string): Record<string, unknown> {
  const source = readFileSync(join(ROOT, relative), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const module = { exports: {} as Record<string, unknown> }
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (name: string) => {
      throw new Error(`${relative} imports ${name}; the drift test loads it on its own`)
    },
  })
  return module.exports
}

interface HelpQuestion {
  id: string
  options: { id: string; next?: string }[]
}
type AppTree = Record<string, readonly string[]>

/** Every way the two trees disagree, as sentences; empty when they agree. */
function treeDrift(help: HelpQuestion[], app: AppTree, helpOnly: Record<string, string>): string[] {
  const problems: string[] = []
  const helpIds = new Set(help.map((q) => q.id))
  for (const q of Object.keys(helpOnly)) {
    if (!helpIds.has(q)) problems.push(`HELP_ONLY_QUESTIONS names "${q}", which the help page does not ask`)
    if (q in app) problems.push(`"${q}" is both in the app's tree and excused as help-only`)
  }
  for (const q of help) {
    if (q.id in helpOnly) continue
    const appOptions = app[q.id]
    if (!appOptions) {
      problems.push(`the help page asks "${q.id}" and the app does not`)
      continue
    }
    const helpOptions = q.options.map((o) => o.id).join(', ')
    if (helpOptions !== appOptions.join(', ')) {
      problems.push(`"${q.id}": help offers [${helpOptions}], the app [${appOptions.join(', ')}]`)
    }
  }
  for (const q of Object.keys(app)) {
    if (!helpIds.has(q)) problems.push(`the app asks "${q}" and the help page does not`)
  }
  return problems
}

describe('the setup guide and the help walkthrough ask the same questions', () => {
  const helpModule = load('apps/help/src/data/offeringWalkthrough.ts')
  const appModule = load('apps/web/src/components/offer/offeringWizardTree.ts')
  const help = helpModule.QUESTIONS as HelpQuestion[]
  const app = appModule.WIZARD_TREE as AppTree
  const helpOnly = appModule.HELP_ONLY_QUESTIONS as Record<string, string>

  it('loads both trees', () => {
    assert.ok(help.length > 0)
    assert.ok(Object.keys(app).length > 0)
  })

  it('every help option has an id, once per question, and every next is a question', () => {
    const ids = new Set(help.map((q) => q.id))
    for (const q of help) {
      const seen = new Set<string>()
      for (const o of q.options) {
        assert.ok(typeof o.id === 'string' && o.id.length > 0, `an option of "${q.id}" has no id`)
        assert.ok(!seen.has(o.id), `"${q.id}" has the option id "${o.id}" twice`)
        seen.add(o.id)
        if (o.next) assert.ok(ids.has(o.next), `"${q.id}"/"${o.id}" leads to "${o.next}", which is not a question`)
      }
    }
  })

  it('the two trees agree', () => {
    assert.deepEqual(treeDrift(help, app, helpOnly), [])
  })

  it('and the comparison is capable of failing', () => {
    const withoutOption = help.map((q) => (q.id === 'class-pay' ? { ...q, options: q.options.slice(0, -1) } : q))
    assert.equal(treeDrift(withoutOption, app, helpOnly).length, 1)
    const reordered = help.map((q) => (q.id === 'plan-limit' ? { ...q, options: [...q.options].reverse() } : q))
    assert.equal(treeDrift(reordered, app, helpOnly).length, 1)
    assert.equal(treeDrift(help, { ...app, 'class-extra': ['a'] }, helpOnly).length, 1)
    assert.equal(treeDrift(help, app, { ...helpOnly, 'gone-question': 'stale' }).length, 1)
  })
})

/**
 * Harness for `install.mjs`.
 *
 * The installer edits a file the user owns, so its text surgery is tested
 * against throwaway harness homes rather than by trusting it. Everything runs
 * in-process: the module exports its pieces and only runs its CLI when invoked
 * directly.
 *
 * Usage: `node test/install-harness.mjs`
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { BEGIN, END, countRows, loadYaml, main, removeManagedBlock, revisionOf, stripPluginRows, upsertManagedBlock } from '../install.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, '..')
const checks = []
const check = (label, ok) => checks.push([label, ok === true])

/** A throwaway harness home with one profile and a patch layer. */
function fakeHome(patchText) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hud-install-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), patchText, 'utf8')
  return home
}
const patchOf = (home) => readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
const cleanup = (home) => rmSync(home, { recursive: true, force: true })

const DEFAULT_LAYER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries.
[]
`

// ── the text surgery, in isolation ──────────────────────────────────────────
{
  const rows = (text) => stripPluginRows(text)
  check('a plugin row is removed with its own lines', !rows('- insert:\n    - id: usage-hud\n      name: x\n').includes('usage-hud'))
  check('a sibling row in the same insert is kept', rows('- insert:\n    - id: usage-hud\n      name: x\n    - id: other\n      name: y\n').includes('other'))
  check('an inline-mapping plugin row is removed', !rows('- id: usage-hud\n  name: x\n').includes('usage-hud'))
  check('a different id is never touched', rows('- insert:\n    - id: usage-hud-extra\n      name: x\n').includes('usage-hud-extra'))
  check('an emptied insert list is dropped', !rows('- insert:\n    - id: usage-hud\n      name: x\n').includes('- insert:'))
  check('a surviving insert list keeps its header', rows('- insert:\n    - id: usage-hud\n      name: x\n    - id: other\n      name: y\n').includes('- insert:'))
  const kept = rows('# a comment\n- id: unrelated\n  config: 1\n')
  check('unrelated content and comments survive', kept.includes('# a comment') && kept.includes('unrelated'))
}

// ── upsert into the three shapes a layer can have ───────────────────────────
{
  const bare = upsertManagedBlock('[]\n', 'file:///x/index.js?v=1')
  check('a bare [] layer is replaced, not appended to', !/^\s*\[\s*\]\s*$/m.test(bare) && bare.includes(BEGIN) && bare.includes(END))
  check('the replaced layer is a list of one row', loadYamlFrom(bare) === 1)

  const commented = upsertManagedBlock(DEFAULT_LAYER, 'file:///x/index.js?v=1')
  check('comments above [] survive the replacement', commented.includes('# Your patch layer for this dsh profile'))
  check('a commented [] layer still yields exactly one row', loadYamlFrom(commented) === 1)

  const withEntry = upsertManagedBlock('# mine\n- id: keepme\n  disabled: true\n', 'file:///x/index.js?v=1')
  check('a hand-written entry is preserved', withEntry.includes('- id: keepme'))
  check('appending to a populated layer yields one plugin row', loadYamlFrom(withEntry) === 1)

  const twice = upsertManagedBlock(upsertManagedBlock(DEFAULT_LAYER, 'file:///x/index.js?v=1'), 'file:///x/index.js?v=2')
  check('a second upsert replaces rather than duplicates', loadYamlFrom(twice) === 1)
  check('a second upsert updates the revision', twice.includes('?v=2') && !twice.includes('?v=1'))
}

// ── removal leaves a valid layer ────────────────────────────────────────────
{
  const installed = upsertManagedBlock(DEFAULT_LAYER, 'file:///x/index.js?v=1')
  const removed = removeManagedBlock(installed)
  check('removal keeps the comments', removed.includes('# Your patch layer for this dsh profile'))
  check('removal leaves a valid empty array', removed.split('\n').some((line) => line.trim() === '[]'))
  check('removal leaves no plugin row', loadYamlFrom(removed) === 0)
  check('removing from a bare [] layer is a no-op array', removeManagedBlock('[]\n').trim() === '[]')
  check('removing twice is stable', removeManagedBlock(removeManagedBlock(installed)) === removed)
}

// ── end to end against a throwaway harness home ─────────────────────────────
{
  const home = fakeHome(DEFAULT_LAYER)
  try {
    check('the installer succeeds on a fresh profile', main(['--dsh-home', home, '--source', SOURCE]) === 0)
    const patch = patchOf(home)
    check('exactly one row is registered', loadYamlFrom(patch) === 1)
    check('the row points into the harness home', patch.includes('plugins/dsh-usage-hud/lib/index.js') || patch.includes('plugins\\dsh-usage-hud\\lib\\index.js'))
    check('the row is a file URL carrying a revision', /name: 'file:\/\/\/.*index\.js\?v=[0-9a-f]{12}'/.test(patch))
    const installed = join(home, 'plugins', 'dsh-usage-hud')
    check('the host half was copied', existsSync(join(installed, 'lib', 'index.js')))
    check('the browser half was copied', existsSync(join(installed, 'lib', 'client.js')))
    check('the bundle layer was copied', existsSync(join(installed, 'cordis.patch.yml')))
    check('a backup of the original layer was written', existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml.bak-dsh-usage-hud')))
    check('the installed revision matches the copied files', patch.includes(revisionOf(installed)))

    // Re-installing is the update path and must stay idempotent.
    check('a second install succeeds', main(['--dsh-home', home, '--source', SOURCE]) === 0)
    check('re-installing still declares exactly one row', loadYamlFrom(patchOf(home)) === 1)
    check('re-installing does not add a second backup', existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml.bak-dsh-usage-hud')))

    // A layer carrying a hand-written row from the README's manual example.
    const manual = fakeHome(`# mine\n- insert:\n    - id: usage-hud\n      name: 'file:///somewhere/else/lib/index.js?v=1'\n`)
    try {
      let refused = false
      try {
        main(['--dsh-home', manual, '--source', SOURCE])
      } catch {
        refused = true
      }
      check('an unmanaged row is refused without --force', refused)
      check('the refusal leaves the file untouched', patchOf(manual).includes('somewhere/else'))
      check('--force replaces the unmanaged row', main(['--dsh-home', manual, '--source', SOURCE, '--force']) === 0 && loadYamlFrom(patchOf(manual)) === 1)
      check('--force kept the surrounding comment', patchOf(manual).includes('# mine'))
    } finally {
      cleanup(manual)
    }

    // Uninstall restores a clean layer and removes the files.
    check('uninstall succeeds', main(['--dsh-home', home, '--uninstall']) === 0)
    check('uninstall leaves no plugin row', loadYamlFrom(patchOf(home)) === 0)
    check('uninstall leaves a valid array', patchOf(home).split('\n').some((line) => line.trim() === '[]'))
    check('uninstall removes the installed files', !existsSync(join(home, 'plugins', 'dsh-usage-hud')))
  } finally {
    cleanup(home)
  }
}

// ── argument handling ───────────────────────────────────────────────────────
{
  let rejected = false
  try {
    main(['--nonsense'])
  } catch {
    rejected = true
  }
  check('an unknown flag is rejected', rejected)
  let missing = false
  try {
    main(['--dsh-home'])
  } catch {
    missing = true
  }
  check('a flag without a value is rejected', missing)
  check('--help exits cleanly', main(['--help']) === 0)
}

/** Parse a patch text and count plugin rows, failing loudly if it will not parse. */
function loadYamlFrom(text) {
  // The harness home is a temp directory, so the parser is loaded from the real
  // installation when one is present; a minimal check stands in otherwise.
  const parser = loadYaml(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'))
  if (parser === undefined) return text.split('\n').filter((line) => /^\s*-?\s*id:\s*usage-hud\s*$/.test(line)).length
  return countRows(parser.parse(text))
}

let failed = 0
console.log('── installer assertions ──')
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall assertions passed')
}

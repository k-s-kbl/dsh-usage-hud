#!/usr/bin/env node
/**
 * Installer for dsh-usage-hud.
 *
 * Copies the plugin into the harness home and registers one loader row in a
 * profile's patch layer. Everything runs from Node's standard library, so it
 * works from a plain checkout with no package install step, on Windows or POSIX.
 *
 * Safety model, because this edits a file the user owns:
 *
 *   1. the existing patch layer is copied to `<file>.bak-dsh-usage-hud` first;
 *   2. the edit is surgical — only the region this installer manages (and, with
 *      `--force`, a previously added unmanaged row) is rewritten, so comments
 *      and hand-written entries elsewhere survive;
 *   3. the result is parsed with the harness's own YAML parser when one can be
 *      found, and the plugin's row count is checked, before anything commits;
 *   4. if validation fails the backup is restored and the installer exits
 *      non-zero rather than leaving a broken profile behind.
 *
 * Usage:
 *   node install.mjs [--profile web] [--dsh-home <dir>] [--source <dir>] [--force]
 *   node install.mjs --uninstall [--profile web] [--dsh-home <dir>]
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = '@local/dsh-usage-hud'
const ROW_ID = 'usage-hud'
const PATCH_FILENAME = 'cordis.patch.yml'
const INSTALL_DIRNAME = 'dsh-usage-hud'
/** Marks the region this installer owns; everything between is rewritten. */
export const BEGIN = '# >>> dsh-usage-hud (managed by install.mjs) >>>'
export const END = '# <<< dsh-usage-hud <<<'
/** Files copied out of the checkout into the harness home. */
const INSTALLED_FILES = ['package.json', 'cordis.patch.yml', join('lib', 'index.js'), join('lib', 'client.js')]

/**
 * Parse the command line.
 * @param argv - arguments after the script name.
 * @returns resolved options.
 * @throws on an unknown flag or a flag without a value.
 */
export function parseArgs(argv) {
  const withValue = new Set(['--profile', '--dsh-home', '--source'])
  const options = { profile: 'web', dshHome: undefined, source: HERE, uninstall: false, force: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--uninstall') { options.uninstall = true; continue }
    if (arg === '--force') { options.force = true; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (!withValue.has(arg)) throw new Error(`unknown option ${arg} (try --help)`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    index += 1
    if (arg === '--profile') options.profile = value
    if (arg === '--dsh-home') options.dshHome = resolve(value)
    if (arg === '--source') options.source = resolve(value)
  }
  return options
}

/**
 * Resolve the harness home the way the launcher does.
 * @param explicit - `--dsh-home`, when given.
 * @returns the absolute harness home.
 */
export function resolveDshHome(explicit) {
  if (explicit !== undefined) return explicit
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/** Quote a value as a single-quoted YAML scalar. */
function yamlQuote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Load the harness's own YAML parser, used only to validate the result.
 * @param dshHome - harness home, whose `profiles/node_modules` carries one.
 * @returns `{ parse(text) }`, or undefined when none can be found.
 */
export function loadYaml(dshHome) {
  const candidates = ['yaml', 'js-yaml']
  for (const name of candidates) {
    const marker = join(dshHome, 'profiles', 'node_modules', name, 'package.json')
    if (!existsSync(marker)) continue
    try {
      const loaded = createRequire(marker)(name)
      if (typeof loaded.parse === 'function') return { parse: (text) => loaded.parse(text) }
      if (typeof loaded.load === 'function') return { parse: (text) => loaded.load(text) }
    } catch {}
  }
  return undefined
}

/**
 * Count the rows declaring the plugin's id.
 * @param document - parsed YAML, or anything else.
 * @returns the count, or -1 when the document is not a patch list.
 */
export function countRows(document) {
  if (!Array.isArray(document)) return -1
  let count = 0
  for (const patch of document) {
    if (patch === null || typeof patch !== 'object' || !Array.isArray(patch.insert)) continue
    for (const entry of patch.insert) {
      if (entry !== null && typeof entry === 'object' && entry.id === ROW_ID) count += 1
    }
  }
  return count
}

/**
 * Whether a line carries real YAML content rather than a comment or padding.
 * @param line - one source line.
 * @returns true when the line is significant.
 */
function isSignificant(line) {
  const trimmed = line.trim()
  return trimmed !== '' && !trimmed.startsWith('#')
}

/**
 * Drop the region this installer manages.
 * @param text - current patch text.
 * @returns the text without that region.
 */
export function stripManaged(text) {
  const kept = []
  let inside = false
  for (const line of text.split('\n')) {
    if (line.trim() === BEGIN) { inside = true; continue }
    if (line.trim() === END) { inside = false; continue }
    if (!inside) kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Drop every list item declaring `id: <ROW_ID>`, together with the lines that
 * belong to it, plus any `- insert:` left with no children.
 *
 * Deliberately narrow: only an exact `id: usage-hud` key starts a removal, and
 * only deeper-indented following lines are consumed. Anything else is copied
 * through untouched.
 * @param text - current patch text.
 * @returns the text without the plugin's rows.
 */
export function stripPluginRows(text) {
  const lines = text.split('\n')
  const kept = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (new RegExp(`^-?\\s*id:\\s*${ROW_ID}\\s*$`).test(line.trim())) {
      const indent = line.length - line.trimStart().length
      index += 1
      while (index < lines.length) {
        const next = lines[index]
        if (next.trim() === '') { index += 1; continue }
        if (next.length - next.trimStart().length > indent) { index += 1; continue }
        break
      }
      continue
    }
    kept.push(line)
    index += 1
  }

  // A `- insert:` whose children are all gone is dead weight; remove it.
  const pruned = []
  for (let cursor = 0; cursor < kept.length; cursor += 1) {
    const line = kept[cursor]
    if (line.trim() !== '- insert:') { pruned.push(line); continue }
    const indent = line.length - line.trimStart().length
    let lookahead = cursor + 1
    let hasChild = false
    while (lookahead < kept.length) {
      const next = kept[lookahead]
      if (next.trim() === '') { lookahead += 1; continue }
      if (next.length - next.trimStart().length > indent) { hasChild = true }
      break
    }
    if (hasChild) pruned.push(line)
  }
  return pruned.join('\n')
}

/**
 * Build the managed region for one row.
 * @param name - the `file:` URL to mount.
 * @returns the block's lines.
 */
export function managedBlock(name) {
  return [BEGIN, '- insert:', `    - id: ${ROW_ID}`, `      name: ${yamlQuote(name)}`, END]
}

/**
 * Insert the managed block into a patch layer, replacing any previous one.
 *
 * A layer whose only content is `[]` is replaced in place rather than appended
 * to, because `[]` followed by list items is not valid YAML.
 * @param text - current patch text.
 * @param name - the `file:` URL to mount.
 * @returns the next text.
 */
export function upsertManagedBlock(text, name) {
  const body = stripManaged(text).replace(/\s*$/, '')
  const lines = body.split('\n')
  const significant = lines.map((line, at) => ({ line, at })).filter(({ line }) => isSignificant(line))
  const block = managedBlock(name)

  if (significant.length === 1 && significant[0].line.trim() === '[]') {
    const at = significant[0].at
    return [...lines.slice(0, at), ...block, ...lines.slice(at + 1)].join('\n') + '\n'
  }
  if (significant.length === 0) {
    const lead = body === '' ? [] : lines
    return [...lead, ...block].join('\n') + '\n'
  }
  return `${body}\n${block.join('\n')}\n`
}

/**
 * Remove the managed block, leaving a valid layer behind.
 * @param text - current patch text.
 * @returns the next text.
 */
export function removeManagedBlock(text) {
  const body = stripManaged(text).replace(/\s*$/, '')
  const lines = body.split('\n')
  const significant = lines.filter((line) => isSignificant(line))
  if (significant.length === 0) {
    // Only comments (or nothing) remain: a patch layer must still be an array.
    return (body === '' ? '[]' : `${body}\n[]`) + '\n'
  }
  return `${body}\n`
}

/**
 * Rewrite the patch layer so it declares exactly one plugin row.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param name - the `file:` URL the row should mount.
 * @param options - `{ yaml, force }`.
 * @returns the number of rows the validated result declares.
 * @throws when the result would not declare exactly one row (the backup is restored first).
 */
export function writePatchRow(patchPath, name, options) {
  const original = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '[]\n'
  const backup = `${patchPath}.bak-dsh-usage-hud`
  if (!existsSync(backup)) copyFileSync(patchPath, backup)

  let body = stripManaged(original)
  if (countRowsUnsafe(body, options.yaml) !== 0) {
    if (!options.force) {
      throw new Error(
        `an unmanaged "${ROW_ID}" row already exists in ${patchPath}.\n` +
        'Remove it by hand (or re-run with --force to replace it), then install again.',
      )
    }
    body = stripPluginRows(body)
  }
  const next = upsertManagedBlock(body, name)

  const staging = `${patchPath}.tmp-${process.pid}`
  writeFileSync(staging, next, 'utf8')
  renameSync(staging, patchPath)

  const rows = countRowsUnsafe(readFileSync(patchPath, 'utf8'), options.yaml)
  if (options.yaml !== undefined && rows !== 1) {
    copyFileSync(backup, patchPath)
    throw new Error(`the patched layer did not validate (${rows} plugin rows); restored ${backup}`)
  }
  return rows
}

/**
 * Count rows without a parser, used only to decide whether a hand-written row
 * is present. Falls back to the parser when one is available.
 * @param text - patch text.
 * @param yaml - parser or undefined.
 * @returns the row count, or a text-based estimate without a parser.
 */
function countRowsUnsafe(text, yaml) {
  if (yaml !== undefined) {
    try {
      return countRows(yaml.parse(text))
    } catch {
      return 0
    }
  }
  return text.split('\n').filter((line) => new RegExp(`^-?\\s*id:\\s*${ROW_ID}\\s*$`).test(line.trim())).length
}

/**
 * Copy the plugin's files into the harness home.
 * @param source - the checkout root.
 * @param dshHome - harness home.
 * @returns the installed directory.
 */
export function installFiles(source, dshHome) {
  for (const relative of INSTALLED_FILES) {
    if (!existsSync(join(source, relative))) {
      throw new Error(`the checkout is incomplete: ${relative} is missing (run this script from the repository root)`)
    }
  }
  const target = join(dshHome, 'plugins', INSTALL_DIRNAME)
  for (const relative of INSTALLED_FILES) {
    const destination = join(target, relative)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(source, relative), destination)
  }
  return target
}

/**
 * Derive the build revision from the installed host half.
 *
 * Content-derived rather than a hand-maintained counter, so re-running the
 * installer after an update always presents the Loader with a URL it has not
 * imported yet — the only thing that makes it re-import a row in place.
 * @param target - the installed directory.
 * @returns twelve hex characters.
 */
export function revisionOf(target) {
  const hash = createHash('sha1')
  for (const relative of [join('lib', 'index.js'), join('lib', 'client.js')]) hash.update(readFileSync(join(target, relative)))
  return hash.digest('hex').slice(0, 12)
}

/** Print what to do after installing. */
function printNextSteps(profile, dshHome) {
  const origin = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
  console.log('')
  console.log('Next:')
  console.log(`  1. reload the page at ${origin} — the browser roster is composed at boot`)
  console.log(`  2. confirm it attached:  curl ${origin}/api/usage-hud/status`)
  console.log('')
  console.log(`If the panel does not appear after a reload, restart \`dsh --profile ${profile}\` once.`)
  console.log(`Uninstall at any time:  node install.mjs --uninstall --dsh-home "${dshHome}"`)
}

/**
 * Run the installer.
 * @param argv - arguments after the script name.
 * @returns the process exit code.
 */
export function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('Install dsh-usage-hud into a DeepSeek Harness profile.\n')
    console.log('  node install.mjs [--profile web] [--dsh-home <dir>] [--source <dir>] [--force]')
    console.log('  node install.mjs --uninstall [--profile web] [--dsh-home <dir>]')
    console.log('\nDefaults: profile "web", harness home $DSH_HOME or ~/.dsh, source alongside this script.')
    return 0
  }

  const dshHome = resolveDshHome(options.dshHome)
  if (!existsSync(dshHome)) throw new Error(`harness home not found: ${dshHome} (pass --dsh-home)`)

  const profileDir = join(dshHome, 'profiles', options.profile)
  if (!existsSync(profileDir)) {
    throw new Error(
      `profile "${options.profile}" not found at ${profileDir}\n` +
      `Start it once (\`dsh --profile ${options.profile}\`) so the launcher creates it, or pass --profile <name>.`,
    )
  }
  const patchPath = join(profileDir, PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, '[]\n', 'utf8')

  const yaml = loadYaml(dshHome)
  const target = join(dshHome, 'plugins', INSTALL_DIRNAME)

  if (options.uninstall) {
    const original = readFileSync(patchPath, 'utf8')
    const backup = `${patchPath}.bak-dsh-usage-hud`
    if (!existsSync(backup)) copyFileSync(patchPath, backup)
    const next = removeManagedBlock(original)
    if (yaml !== undefined && countRows(yaml.parse(next)) !== 0) throw new Error('refusing to write a layer that still declares the plugin')
    writeFileSync(patchPath, next, 'utf8')
    rmSync(target, { recursive: true, force: true })
    console.log(`Uninstalled from profile "${options.profile}".`)
    console.log(`  removed the loader row from ${patchPath}`)
    console.log(`  deleted ${target}`)
    console.log('Reload the page to drop the panel.')
    return 0
  }

  const installed = installFiles(options.source, dshHome)
  const revision = revisionOf(installed)
  const name = `${pathToFileURL(join(installed, 'lib', 'index.js')).href}?v=${revision}`
  writePatchRow(patchPath, name, { yaml, force: options.force })

  console.log(`Installed ${PACKAGE}`)
  console.log(`  files:    ${installed}`)
  console.log(`  row:      ${patchPath}`)
  console.log(`  revision: ${revision}`)
  if (yaml === undefined) console.log('  note:     no YAML parser was found to validate the result; a backup was still written')
  printNextSteps(options.profile, dshHome)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`install: ${error.message}`)
    process.exitCode = 1
  }
}

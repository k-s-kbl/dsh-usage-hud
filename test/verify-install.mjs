/**
 * End-to-end install verification against the running GUI.
 *
 * Authenticates exactly as the browser launcher does — it mints the same
 * signed `dsh-auth-<authority>` session cookie from the operator's own stored
 * `client-connection/browser-session` secret — then reads the served index and
 * asserts that:
 *
 *   1. the running server answers on the expected URL,
 *   2. `window.__DSH_BOOT__` contains the `@local/dsh-usage-hud` row,
 *   3. the row's combo script really serves this package's client bundle,
 *   4. the host half's balance route answers with a well-formed payload.
 *
 * The secret is read from disk and never printed. The harness home is
 * `$DSH_HOME` when set, otherwise `~/.dsh`.
 *
 * Usage: `node test/verify-install.mjs [http://127.0.0.1:3080] [--cookie-file <path>]`
 *
 * `--cookie-file` writes the minted `{ name, value }` pair to a file instead of
 * driving the checks, so a browser driver can be handed the session without the
 * value ever appearing on a command line. Delete the file afterwards.
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'

const argv = process.argv.slice(2)
const cookieFileIndex = argv.indexOf('--cookie-file')
const cookieFile = cookieFileIndex === -1 ? undefined : argv[cookieFileIndex + 1]
const origin = (argv.find((value, index) => !value.startsWith('--') && index !== cookieFileIndex + 1) ?? 'http://127.0.0.1:3080').replace(/\/+$/u, '')
const authority = new URL(origin).host
const PLUGIN_ID = '@local/dsh-usage-hud'

const checks = []
const check = (label, ok) => checks.push([label, ok === true])

// ── mint the browser session cookie ─────────────────────────────────────────
// The harness home is `$DSH_HOME` when it is set: that variable *is* the home
// directory, not a parent of it. Hard-coding `~/.dsh` minted a cookie from the
// wrong home's secret on any machine whose operator moved the home elsewhere,
// and the server rejected it with a bare 401.
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const require = createRequire(join(home, 'profiles', 'node_modules', 'x.js'))
const YAML = require('yaml')
const credentials = YAML.parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))
const record = credentials?.records?.['client-connection/browser-session']
const storedSecret = record?.payload?.secret
if (typeof storedSecret !== 'string' || storedSecret.length === 0) throw new Error('no stored browser-session secret; open the GUI through its launch URL first')

const base64url = (buffer) => buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
/** The stored secret is base64url text; the cookie HMAC key is its decoded bytes. */
const decodeBase64Url = (value) => {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}
const secret = decodeBase64Url(storedSecret)
if (secret.byteLength !== 32) throw new Error(`unexpected stored secret length ${secret.byteLength}; expected 32 bytes`)

const cookieName = `dsh-auth-${base64url(createHash('sha256').update(authority).digest())}`
const issuedAt = Date.now()
const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 3_600_000 }
const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
const cookie = `${cookieName}=v1.${body}.${base64url(createHmac('sha256', secret).update(body).digest())}`
check('a signed session cookie was minted from the stored secret', cookie.startsWith(`${cookieName}=v1.`))

if (cookieFile !== undefined) {
  writeFileSync(cookieFile, JSON.stringify({ name: cookieName, value: `v1.${body}.${base64url(createHmac('sha256', secret).update(body).digest())}` }), 'utf8')
  console.log(`session cookie written to ${cookieFile}; delete it when finished`)
  process.exit(0)
}

/**
 * Issue one request with `node:http`. `fetch` is unusable here: undici treats
 * `Cookie` as a forbidden request header and drops it silently.
 * @param path - request path, query included.
 * @param headers - extra request headers.
 * @returns status and body text.
 */
function get(path, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, origin)
    const req = request(
      { hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET', headers },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// ── read the served index ───────────────────────────────────────────────────
const indexResponse = await get('/', { cookie })
check(`the GUI answers on ${origin}`, indexResponse.status === 200)
const html = indexResponse.text
check('the index carries the boot graph', html.includes('__DSH_BOOT__'))

// The host injects `globalThis["__DSH_BOOT__"] = {...}</script>`; take the
// literal between the first brace after the marker and the script close.
const marker = html.indexOf('__DSH_BOOT__')
const literalStart = marker < 0 ? -1 : html.indexOf('{', marker)
const literalEnd = literalStart < 0 ? -1 : html.indexOf('</script>', literalStart)
const match = literalStart < 0 || literalEnd < 0 ? null : [null, html.slice(literalStart, literalEnd).trim().replace(/;$/u, '')]
if (match === null) {
  console.error('could not locate window.__DSH_BOOT__ in the index response')
  console.error(`html length: ${html.length}; marker at: ${marker}`)
  console.error(html.slice(Math.max(0, marker - 200), marker + 600))
  process.exit(1)
}
// The host escapes `<` inside the injected JSON literal; JSON.parse is fine
// with the raw braces because the payload itself is valid JSON.
const graph = JSON.parse(match[1])
check('the boot graph parsed', Array.isArray(graph.entries) && graph.entries.length > 0)

const row = graph.entries.find((entry) => entry.id === PLUGIN_ID)
check(`the boot graph contains the ${PLUGIN_ID} row`, row !== undefined)

if (row !== undefined) {
  check('the row declares the client bundle URL', typeof row.url === 'string' && row.url.includes('/client.js'))
  check('the row is not marked for immediate prefetch', row.immediately !== true)
  check('the row waits for the slot owner and the locale seat', Array.isArray(row.inject) && row.inject.includes('@deepseek-ai/dsh-client-ui-conversation') && row.inject.includes('@deepseek-ai/dsh-client-locale'))
  console.log(`\nboot row:\n  ${JSON.stringify(row)}`)
}

// The served artifact must be this checkout's bundle, not a stale snapshot.
const localBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\s+$/u, '')

// ── the combo script really serves this bundle ──────────────────────────────
if (row !== undefined) {
  const batches = (graph.batches ?? []).filter((batch) => (batch.entries ?? []).includes(PLUGIN_ID))
  check('the row belongs to exactly one combo batch', batches.length === 1)
  for (const batch of batches) {
    const bundleResponse = await get(batch.url, {})
    check('the combo script answers 200', bundleResponse.status === 200)
    const source = bundleResponse.text
    check('the combo script carries the plugin registration', source.includes(`"${PLUGIN_ID}"`))
    check('the combo script carries the slot entry', source.includes('conversation.input.overlay'))
    check('the combo script carries the balance route path', source.includes('/api/usage-hud/balance'))
    check('the served bytes are this checkout\'s bundle, not a stale snapshot', source.includes(localBundle))
    console.log(`\ncombo script: ${batch.url.slice(0, 80)}…\n  phase=${batch.phase} bytes=${source.length}`)
  }
}

// ── the host route ──────────────────────────────────────────────────────────
const balanceResponse = await get('/api/usage-hud/balance?refresh=1', { 'sec-fetch-site': 'same-origin' })
check('the balance route answers 200', balanceResponse.status === 200)
const balance = JSON.parse(balanceResponse.text)
check('the balance route returns JSON', typeof balance === 'object' && balance !== null)
check('the balance payload is well-formed', typeof balance.ok === 'boolean')
console.log(`\nbalance payload:\n  ${JSON.stringify(balance)}`)
if (balance.ok === true) {
  check('a live balance figure is present', typeof balance.total === 'string' && balance.total.length > 0)
  check('the payload names the endpoint it queried', typeof balance.baseURL === 'string')
  check('the payload reports credential provenance', typeof balance.keySource === 'string')
} else {
  check('the failure is classified, not thrown', typeof balance.code === 'string')
}

// ── the pricing route ───────────────────────────────────────────────────────
const pricingResponse = await get('/api/usage-hud/pricing', { 'sec-fetch-site': 'same-origin' })
check('the pricing route answers 200', pricingResponse.status === 200)
const pricing = JSON.parse(pricingResponse.text)
check('the pricing payload is well-formed', pricing.ok === true && pricing.currency === 'CNY' && pricing.unit === 1_000_000)
check('the current billing regime is resolved', pricing.regime === 'peak' || pricing.regime === 'offPeak')
check('the default model is priced', pricing.defaultModel !== undefined && pricing.models[pricing.defaultModel] !== undefined)
const defaultRates = pricing.models[pricing.defaultModel]
check('the default model carries both regimes', defaultRates.offPeak !== undefined && defaultRates.peak !== undefined)
check('every rate the client multiplies exists', ['inputCached', 'inputUncached', 'output', 'inputCacheWrite'].every((rate) => typeof defaultRates.offPeak[rate] === 'number' && typeof defaultRates.peak[rate] === 'number'))
console.log(`\npricing payload:\n  regime=${pricing.regime} default=${pricing.defaultModel} models=${Object.keys(pricing.models).join(', ')}\n  ${JSON.stringify(defaultRates[pricing.regime])}`)

// ── report ──────────────────────────────────────────────────────────────────
let failed = 0
console.log('\n── install verification ──')
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nplugin installed and composed; reload the page to mount the panel')
}

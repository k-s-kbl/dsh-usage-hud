/**
 * Offline harness for the usage-HUD host half.
 *
 * Loads `lib/index.js` and drives its single route through a stub Cordis
 * context and a stub upstream, covering the happy path, both failure classes,
 * credential resolution order, the response cache, and the request guards.
 *
 * Usage: `node test/host-harness.mjs`
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const module_ = await import(new URL(`file:///${join(here, '..', 'lib', 'index.js').replaceAll('\\', '/')}`).href)

const checks = []
const check = (label, ok) => {
  checks.push([label, ok === true])
}

// ── stubs ───────────────────────────────────────────────────────────────────
const KEY = 'sk-test-key-never-logged'
let route
let upstreamCalls = 0
let upstreamResponse = { status: 200, body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '0.00', topped_up_balance: '110.00' }] } }
let credentialHit
/** Last request the host half issued upstream. */
let lastUpstream

const warnings = []
let nowOffset = 0
const realNow = Date.now
Date.now = () => realNow() + nowOffset

globalThis.fetch = async (url, init) => {
  upstreamCalls += 1
  lastUpstream = { url, init }
  if (upstreamResponse.status !== 200) {
    return { ok: false, status: upstreamResponse.status, text: async () => upstreamResponse.body }
  }
  return { ok: true, status: 200, json: async () => upstreamResponse.body }
}

/** Every route the plugin registered, keyed by path. */
const routes = new Map()

/** Definition the plugin handed to the projection registry, if any. */
let projectionSink
/** Whether the composition provides the projection registry at all. */
let registryMounted = true
/** Services the plugin waited for through `ctx.inject`. */
const injected = []

const registry = {
  register(definition) {
    projectionSink = definition
    return () => {
      projectionSink = undefined
    }
  },
}

const ctx = {
  logger: { info() {}, warn: (...args) => warnings.push(args.join(' ')), error() {} },
  get(service) {
    if (service === 'credentials') {
      return {
        async resolve(ref) {
          check('credential ref is the configured variable', ref === 'DEEPSEEK_API_KEY')
          return credentialHit
        },
      }
    }
    if (service === 'sessionProjections') return registryMounted ? registry : undefined
    return undefined
  },
  inject(names, callback) {
    injected.push(names.join(','))
    if (names.includes('sessionProjections')) callback({ sessionProjections: registry, effect: (fn) => { fn(); return () => {} } })
  },
  sessionProjections: registry,
  effect(fn) {
    fn()
    return () => {}
  },
  webServer: {
    register(entry) {
      routes.set(entry.path, entry)
      // The balance route is the subject of most assertions; keep `route`
      // pointing at it while the pricing route accumulates alongside.
      if (entry.path.endsWith('/balance')) route = entry
      return () => {}
    },
  },
}

// ── a request/response pair with just enough surface for the handler ────────
function exchange(method = 'GET', url = '/api/usage-hud/balance', headers = {}) {
  const captured = { status: 0, headers: {}, body: undefined, ended: false }
  const req = { method, url, headers }
  const res = {
    writeHead(status, extra) {
      captured.status = status
      captured.headers = extra ?? {}
    },
    end(chunk) {
      captured.body = chunk
      captured.ended = true
    },
  }
  return { req, res, captured }
}

// ── happy path ──────────────────────────────────────────────────────────────
credentialHit = { value: KEY, source: 'file' }
module_.apply(ctx, {})

check('plugin exports a name', module_.name === 'usage-hud')
check('plugin injects webServer', Array.isArray(module_.inject) && module_.inject.includes('webServer'))
check('route is exact', route.kind === 'exact')
check('route path is the balance route', route.path === '/api/usage-hud/balance')

{
  const { req, res, captured } = exchange()
  await route.handler(req, res)
  const payload = JSON.parse(captured.body)
  check('happy path answers 200', captured.status === 200)
  check('response is not cacheable', captured.headers['cache-control'] === 'no-store')
  check('payload is parsed for the UI', payload.ok === true && payload.total === '110.00' && payload.currency === 'CNY' && payload.toppedUp === '110.00')
  check('payload reports availability', payload.isAvailable === true)
  check('payload reports the credential provenance', payload.keySource === 'file')
  check('payload never carries the secret', !captured.body.includes(KEY))
  check('payload names the credential variable', payload.apiKeyEnv === 'DEEPSEEK_API_KEY')
  check('upstream URL is the balance endpoint', lastUpstream.url === 'https://api.deepseek.com/user/balance')
  check('bearer credential is sent', lastUpstream.init.headers.authorization === `Bearer ${KEY}`)
}

// ── cache ───────────────────────────────────────────────────────────────────
{
  const before = upstreamCalls
  const { req, res, captured } = exchange()
  await route.handler(req, res)
  check('a second poll inside the TTL serves from cache', upstreamCalls === before)
  check('the cached answer is flagged', JSON.parse(captured.body).cached === true)
}
{
  const before = upstreamCalls
  const { req, res } = exchange('GET', '/api/usage-hud/balance?refresh=1')
  await route.handler(req, res)
  check('refresh=1 bypasses the cache', upstreamCalls === before + 1)
}
{
  nowOffset = 31_000
  const before = upstreamCalls
  const { req, res } = exchange()
  await route.handler(req, res)
  check('an expired TTL re-reads upstream', upstreamCalls === before + 1)
  nowOffset = 0
}

// ── absent credential ───────────────────────────────────────────────────────
{
  credentialHit = undefined
  const savedKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  const { req, res, captured } = exchange('GET', '/api/usage-hud/balance?refresh=1')
  await route.handler(req, res)
  const payload = JSON.parse(captured.body)
  check('a missing credential is reported, not thrown', captured.status === 200 && payload.ok === false && payload.code === 'NO_CREDENTIAL')
  if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
  credentialHit = { value: KEY, source: 'file' }
}

// ── upstream failures ───────────────────────────────────────────────────────
{
  upstreamResponse = { status: 401, body: 'Authentication Fails' }
  const { req, res, captured } = exchange('GET', '/api/usage-hud/balance?refresh=1')
  await route.handler(req, res)
  const payload = JSON.parse(captured.body)
  check('an upstream status is surfaced with its code', payload.ok === false && payload.code === 'HTTP_401')
  check('an upstream status carries an excerpt', payload.message === 'Authentication Fails')
}
{
  upstreamResponse = { status: 200, body: { is_available: true, balance_infos: [] } }
  const { req, res, captured } = exchange('GET', '/api/usage-hud/balance?refresh=1')
  await route.handler(req, res)
  check('an empty balance document is refused', JSON.parse(captured.body).code === 'NO_BALANCE_ROW')
}
{
  upstreamResponse = { status: 200, body: { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] } }
  const { req, res, captured } = exchange('GET', '/api/usage-hud/balance?refresh=1')
  await route.handler(req, res)
  const payload = JSON.parse(captured.body)
  check('a depleted account still renders', payload.ok === true && payload.currency === 'USD' && payload.isAvailable === false)
}
{
  upstreamResponse = { status: 200, body: null }
  const restore = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('socket hang up')
  }
  const { req, res, captured } = exchange('GET', '/api/usage-hud/balance?refresh=1')
  await route.handler(req, res)
  check('a transport failure is classified', JSON.parse(captured.body).code === 'TRANSPORT')
  globalThis.fetch = restore
}

// ── request guards ──────────────────────────────────────────────────────────
{
  const { req, res, captured } = exchange('POST')
  await route.handler(req, res)
  check('non-GET methods are refused', captured.status === 405)
}
{
  const { req, res, captured } = exchange('GET', '/api/usage-hud/balance', { 'sec-fetch-site': 'cross-site' })
  await route.handler(req, res)
  check('cross-site reads are refused', captured.status === 403)
}
{
  const { req, res, captured } = exchange('GET', '/api/usage-hud/balance', { 'sec-fetch-site': 'same-origin' })
  await route.handler(req, res)
  check('same-origin reads are allowed', captured.status === 200)
}
{
  const { req, res, captured } = exchange('HEAD')
  await route.handler(req, res)
  check('HEAD is allowed', captured.status === 200)
}

// ── config overrides ────────────────────────────────────────────────────────
{
  const savedKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  upstreamResponse = { status: 200, body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.00', granted_balance: '0.00', topped_up_balance: '42.00' }] } }
  const second = { ...ctx, get: () => undefined }
  module_.apply(second, { apiKeyEnv: 'ACME_KEY', baseURL: 'https://gateway.example/v1/' })
  process.env.ACME_KEY = 'sk-acme'
  const { req, res, captured } = exchange('GET', '/api/usage-hud/balance?refresh=1')
  await route.handler(req, res)
  const payload = JSON.parse(captured.body)
  check('a configured variable is honoured without the credentials service', payload.ok === true && payload.keySource === 'env')
  check('a configured variable reaches the upstream call', lastUpstream.init.headers.authorization === 'Bearer sk-acme')
  check('a configured base URL is normalised', payload.baseURL === 'https://gateway.example/v1')
  check('a configured base URL reaches the upstream call', lastUpstream.url === 'https://gateway.example/v1/user/balance')
  delete process.env.ACME_KEY
  if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
}

// ── pricing route ───────────────────────────────────────────────────────────
/** Freeze the clock at one instant so the billing-regime rule is deterministic. */
function atInstant(ms) {
  nowOffset = ms - realNow()
}
const pricingRoute = () => {
  const entry = routes.get('/api/usage-hud/pricing')
  if (entry === undefined) throw new Error('the pricing route was never registered')
  return entry
}

{
  // 2026-01-05 is a Monday and 2026-01-03 a Saturday; assert the fixture itself
  // so a wrong weekday can never masquerade as a passing regime test.
  check('the regime fixtures land on the intended weekdays', new Date(Date.UTC(2026, 0, 5)).getUTCDay() === 1 && new Date(Date.UTC(2026, 0, 3)).getUTCDay() === 6)

  const { req, res, captured } = exchange('GET', '/api/usage-hud/pricing')
  await pricingRoute().handler(req, res)
  const payload = JSON.parse(captured.body)
  check('the pricing route answers 200', captured.status === 200)
  check('the pricing payload is well-formed', payload.ok === true && payload.currency === 'CNY' && payload.unit === 1_000_000)
  check('the pricing payload carries both regimes per model', payload.models['deepseek-flash'].offPeak !== undefined && payload.models['deepseek-flash'].peak !== undefined)
  check('the peak rate is twice the off-peak rate', payload.models['deepseek-flash'].peak.output === payload.models['deepseek-flash'].offPeak.output * 2)
  check('the pro model is priced higher than flash', payload.models['deepseek-v4-pro'].offPeak.output > payload.models['deepseek-flash'].offPeak.output)
  check('cache writes are free on every DeepSeek route', Object.values(payload.models).every((regimes) => regimes.offPeak.inputCacheWrite === 0 && regimes.peak.inputCacheWrite === 0))
  check('the pricing payload declares a default model', payload.defaultModel === 'deepseek-flash')
  check('the pricing payload publishes the peak-hour rule', Array.isArray(payload.peakHours.windows) && payload.peakHours.windows.length === 2)
  check('the pricing payload never carries a credential', !captured.body.includes(KEY) && payload.apiKeyEnv === undefined)

  // Beijing = UTC+8. Peak windows are 09:00-12:00 and 14:00-18:00 on weekdays.
  const regimes = [
    ['Monday 10:00 Beijing', Date.UTC(2026, 0, 5, 2, 0), 'peak'],
    ['Monday 09:00 Beijing (window opens)', Date.UTC(2026, 0, 5, 1, 0), 'peak'],
    ['Monday 12:00 Beijing (window closes)', Date.UTC(2026, 0, 5, 4, 0), 'offPeak'],
    ['Monday 13:00 Beijing (between windows)', Date.UTC(2026, 0, 5, 5, 0), 'offPeak'],
    ['Monday 15:00 Beijing', Date.UTC(2026, 0, 5, 7, 0), 'peak'],
    ['Monday 18:00 Beijing (window closes)', Date.UTC(2026, 0, 5, 10, 0), 'offPeak'],
    ['Monday 08:59 Beijing', Date.UTC(2026, 0, 5, 0, 59), 'offPeak'],
    ['Saturday 10:00 Beijing (weekend)', Date.UTC(2026, 0, 3, 2, 0), 'offPeak'],
    ['Sunday 15:00 Beijing (weekend)', Date.UTC(2026, 0, 4, 7, 0), 'offPeak'],
  ]
  for (const [label, instant, expected] of regimes) {
    atInstant(instant)
    const probe = exchange('GET', '/api/usage-hud/pricing')
    await pricingRoute().handler(probe.req, probe.res)
    check(`${label} is ${expected}`, JSON.parse(probe.captured.body).regime === expected)
  }
  atInstant(realNow())
}

// ── the status route ────────────────────────────────────────────────────────
{
  const statusRoute = routes.get('/api/usage-hud/status')
  check('the status route is registered', statusRoute !== undefined)
  const { req, res, captured } = exchange('GET', '/api/usage-hud/status')
  await statusRoute.handler(req, res)
  const payload = JSON.parse(captured.body)
  check('the status route answers 200', captured.status === 200)
  check('the status route reports a build revision', typeof payload.revision === 'string' && payload.revision.length > 0)
  check('the status route reports whether the cost projection attached', payload.projection.registered === true)
  check('the status route reports the priced model set', Array.isArray(payload.pricing.models) && payload.pricing.models.includes('deepseek-flash'))
  check('the status route never carries the credential', !captured.body.includes(KEY))
  const unadmitted = exchange('POST', '/api/usage-hud/status')
  await statusRoute.handler(unadmitted.req, unadmitted.res)
  check('the status route refuses non-GET methods', unadmitted.captured.status === 405)
}

// ── pricing configuration ───────────────────────────────────────────────────
{
  const savedKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'sk-x'
  const third = { ...ctx, get: () => undefined }
  module_.apply(third, {
    pricing: { 'deepseek-flash': { peak: { output: 99 } }, 'acme-large': { offPeak: { inputCached: 1, inputUncached: 2, output: 3, inputCacheWrite: 4 } } },
    defaultModel: 'acme-large',
    peakHours: { utcOffsetMinutes: 0, weekdays: [2], windows: [['01:00', '02:00']] },
  })
  const { req, res, captured } = exchange('GET', '/api/usage-hud/pricing')
  await pricingRoute().handler(req, res)
  const payload = JSON.parse(captured.body)
  check('a single overridden rate merges onto the defaults', payload.models['deepseek-flash'].peak.output === 99)
  check('an unmentioned rate keeps its default', payload.models['deepseek-flash'].peak.inputUncached === 2 && payload.models['deepseek-flash'].offPeak.output === 4)
  check('a new model is added whole', payload.models['acme-large'].offPeak.inputCacheWrite === 4)
  check('the default model is configurable', payload.defaultModel === 'acme-large')
  check('the peak-hour rule is configurable', payload.peakHours.utcOffsetMinutes === 0 && payload.peakHours.weekdays.length === 1)

  // 2026-01-06 is a Tuesday; 01:30 UTC falls inside the configured window.
  check('the configured weekday fixture is a Tuesday', new Date(Date.UTC(2026, 0, 6)).getUTCDay() === 2)
  atInstant(Date.UTC(2026, 0, 6, 1, 30))
  const inside = exchange('GET', '/api/usage-hud/pricing')
  await pricingRoute().handler(inside.req, inside.res)
  check('a configured window is honoured', JSON.parse(inside.captured.body).regime === 'peak')
  atInstant(Date.UTC(2026, 0, 7, 1, 30))
  const outside = exchange('GET', '/api/usage-hud/pricing')
  await pricingRoute().handler(outside.req, outside.res)
  check('a configured weekday outside the list is off-peak', JSON.parse(outside.captured.body).regime === 'offPeak')
  atInstant(realNow())

  delete process.env.DEEPSEEK_API_KEY
  if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
}

// ── malformed pricing config fails loud ─────────────────────────────────────
{
  const attempts = [
    ['a non-object table', { pricing: 'cheap' }],
    ['a non-object regime', { pricing: { 'deepseek-flash': { peak: 1 } } }],
    ['a negative rate', { pricing: { 'deepseek-flash': { peak: { output: -1 } } } }],
    ['a non-numeric rate', { pricing: { 'deepseek-flash': { peak: { output: 'free' } } } }],
    ['a malformed window', { peakHours: { windows: [['9am', '12pm']] } }],
    ['an out-of-range weekday', { peakHours: { weekdays: [9] } }],
    ['an out-of-range offset', { peakHours: { utcOffsetMinutes: 5000 } }],
  ]
  for (const [label, badConfig] of attempts) {
    let threw = false
    try {
      module_.apply({ ...ctx, get: () => undefined }, badConfig)
    } catch {
      threw = true
    }
    check(`${label} is rejected at load`, threw)
  }
}

// ── request guards on the pricing route ─────────────────────────────────────
{
  // Re-registered by the last successful apply() above; keep one valid instance.
  const fourth = { ...ctx, get: () => undefined }
  module_.apply(fourth, {})
  const post = exchange('POST', '/api/usage-hud/pricing')
  await pricingRoute().handler(post.req, post.res)
  check('the pricing route refuses non-GET methods', post.captured.status === 405)
  const crossSite = exchange('GET', '/api/usage-hud/pricing', { 'sec-fetch-site': 'cross-site' })
  await pricingRoute().handler(crossSite.req, crossSite.res)
  check('the pricing route refuses cross-site reads', crossSite.captured.status === 403)
}

// ── the usageCost projection ────────────────────────────────────────────────
// Beijing peak is 09:00-12:00 and 14:00-18:00, i.e. 01:00-04:00 and 06:00-10:00
// UTC on a weekday. These two instants sit on opposite sides of it.
const PEAK_INSTANT = Date.UTC(2026, 0, 5, 2, 0)
const OFFPEAK_INSTANT = Date.UTC(2026, 0, 5, 5, 0)

let seq = 0
const headerEvent = (model, time) => ({ type: 'request/header', seq: (seq += 1), time, data: { header: { config: { provider: 'deepseek-official', model } } } })
const usageEvent = (turn, step, usage, time, type = 'assistant/message') => ({ type, seq: (seq += 1), time, data: { turn, step, usage } })
const retryEvent = (turn, step, time) => ({ type: 'llm/retry-started', seq: (seq += 1), time, data: { turn, step } })
/** Fold a whole event list through a fresh projection state. */
const foldCost = (definition, events) => {
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return { state, view: definition.wire.view(state) }
}

{
  module_.apply(ctx, {})
  check('the cost projection registers under its own key', projectionSink !== undefined && projectionSink.key === 'usageCost')
  check('the cost projection is client-visible', projectionSink !== undefined && projectionSink.wire !== undefined)
  check('the cost projection declares a state version', Number.isInteger(projectionSink.stateVersion) && projectionSink.stateVersion >= 1)
  const definition = projectionSink

  // A session that straddles the boundary, exactly like the live screenshot.
  const straddle = foldCost(definition, [
    headerEvent('deepseek-flash', PEAK_INSTANT),
    usageEvent(1, 1, { inputTokens: 400, outputTokens: 30000, cacheReadTokens: 100000, cacheWriteTokens: 0 }, PEAK_INSTANT),
    usageEvent(2, 1, { inputTokens: 840, outputTokens: 15310, cacheReadTokens: 138400, cacheWriteTokens: 0 }, OFFPEAK_INSTANT),
  ])
  check('tokens are attributed to the peak window they were consumed in', Math.abs(straddle.view.byRegime.peak.cost - 30000 * 8 / 1e6 - 400 * 2 / 1e6 - 100000 * 0.04 / 1e6) < 1e-12)
  check('tokens are attributed to the off-peak window likewise', Math.abs(straddle.view.byRegime.offPeak.cost - 15310 * 4 / 1e6 - 840 * 1 / 1e6 - 138400 * 0.02 / 1e6) < 1e-12)
  check('the total is the sum of both windows, not one rate applied to all', Math.abs(straddle.view.total - (straddle.view.byRegime.peak.cost + straddle.view.byRegime.offPeak.cost)) < 1e-12)
  check('a straddling session costs strictly between the all-off-peak and all-peak figures', straddle.view.total > 45310 * 4 / 1e6 && straddle.view.total < 45310 * 8 / 1e6 + 1)
  check('whole-log token totals match the tokenUsage buckets', straddle.view.totals.output === 45310 && straddle.view.totals.cached === 238400 && straddle.view.totals.uncached === 1240)
  check('per-bucket costs sum to the total', Math.abs((straddle.view.byBucket.cached + straddle.view.byBucket.uncached + straddle.view.byBucket.output + straddle.view.byBucket.cacheWrite) - straddle.view.total) < 1e-12)
  check('the sample count is reported', straddle.view.samples === 2)

  // Model switching mid-session — the other half of "does it adapt".
  const switched = foldCost(definition, [
    headerEvent('deepseek-flash', OFFPEAK_INSTANT),
    usageEvent(1, 1, { inputTokens: 0, outputTokens: 1000 }, OFFPEAK_INSTANT),
    headerEvent('deepseek-v4-pro', OFFPEAK_INSTANT),
    usageEvent(2, 1, { inputTokens: 0, outputTokens: 1000 }, OFFPEAK_INSTANT),
  ])
  const byModel = Object.fromEntries(switched.view.byModel.map((entry) => [entry.model, entry.cost]))
  check('a mid-session model switch prices each request at its own route', Math.abs(byModel['deepseek-flash'] - 1000 * 4 / 1e6) < 1e-12 && Math.abs(byModel['deepseek-v4-pro'] - 1000 * 13.5 / 1e6) < 1e-12)
  check('the switched session names both models in its view', switched.view.byModel.length === 2)

  // Same step, no retry: the later sample REPLACES the earlier one.
  const replaced = foldCost(definition, [
    headerEvent('deepseek-flash', OFFPEAK_INSTANT),
    usageEvent(1, 1, { inputTokens: 0, outputTokens: 1000 }, OFFPEAK_INSTANT),
    usageEvent(1, 1, { inputTokens: 0, outputTokens: 2000 }, OFFPEAK_INSTANT),
  ])
  check('a repeated sample for one step replaces rather than double-counts', replaced.view.totals.output === 2000 && replaced.view.samples === 1)
  check('a replaced sample leaves no stale regime attribution', replaced.view.byRegime.peak.cost === 0)

  // Same step across a retry: both attempts are billed, so the samples ADD.
  const retried = foldCost(definition, [
    headerEvent('deepseek-flash', OFFPEAK_INSTANT),
    usageEvent(1, 1, { inputTokens: 0, outputTokens: 1000 }, OFFPEAK_INSTANT),
    retryEvent(1, 1, OFFPEAK_INSTANT),
    usageEvent(1, 1, { inputTokens: 0, outputTokens: 2000 }, OFFPEAK_INSTANT),
  ])
  check('a retried attempt adds to the total rather than replacing it', retried.view.totals.output === 3000 && retried.view.samples === 2)

  // Replacement across the boundary must move the tokens between windows.
  const moved = foldCost(definition, [
    headerEvent('deepseek-flash', OFFPEAK_INSTANT),
    usageEvent(1, 1, { inputTokens: 0, outputTokens: 1000 }, OFFPEAK_INSTANT),
    usageEvent(1, 1, { inputTokens: 0, outputTokens: 1000 }, PEAK_INSTANT),
  ])
  check('a replacement re-attributes the tokens to the newer window', moved.view.byRegime.offPeak.tokens.output === 0 && moved.view.byRegime.peak.tokens.output === 1000)

  // A model with no rates contributes nothing and says so.
  const unpriced = foldCost(definition, [
    headerEvent('acme-unknown', OFFPEAK_INSTANT),
    usageEvent(1, 1, { inputTokens: 0, outputTokens: 1000 }, OFFPEAK_INSTANT),
  ])
  check('an unpriced model is named rather than silently priced at zero', unpriced.view.unpricedModels.length === 1 && unpriced.view.unpricedModels[0] === 'acme-unknown')
  check('an unpriced model still reports its tokens', unpriced.view.totals.output === 1000)

  // Before any request header, the configured default row applies.
  const headerless = foldCost(definition, [usageEvent(1, 1, { inputTokens: 0, outputTokens: 1000 }, OFFPEAK_INSTANT)])
  check('a sample before any request header uses the default model row', headerless.view.unpricedModels.length === 0 && Math.abs(headerless.view.total - 1000 * 4 / 1e6) < 1e-12)

  // Unrelated events must not publish (the view is memoized by state identity).
  const before = definition.apply(definition.init(), headerEvent('deepseek-flash', OFFPEAK_INSTANT))
  const ignored = definition.apply(before, { type: 'tool/result', seq: 99, time: OFFPEAK_INSTANT, data: {} })
  check('an unrelated event leaves the state reference untouched', ignored === before)
  check('identical state yields an identical view reference', definition.wire.view(before) === definition.wire.view(before))
  const after = definition.apply(before, usageEvent(1, 1, { inputTokens: 0, outputTokens: 1 }, OFFPEAK_INSTANT))
  check('a changed state yields a new view reference', definition.wire.view(after) !== definition.wire.view(before))

  // The fold must be total over malformed input rather than throwing mid-stream.
  check('a usage-less assistant message is a no-op', definition.apply(before, { type: 'assistant/message', seq: 98, time: OFFPEAK_INSTANT, data: { turn: 1, step: 1, stream: [] } }) === before)
  check('a malformed event is a no-op', definition.apply(before, { type: 'request/header', seq: 97, time: OFFPEAK_INSTANT, data: {} }) === before)

  // Restored checkpoints are validated, not trusted.
  const restored = definition.stateSchema.parse(JSON.parse(JSON.stringify(straddle.state)))
  check('a checkpoint round-trips through its schema', definition.wire.view(restored).total === straddle.view.total)
  const rejects = [null, 'x', {}, { cells: null }, { cells: { peak: 1, offPeak: {} } }, { cells: { peak: { m: 'x' }, offPeak: {} } }]
  check('a malformed checkpoint is rejected', rejects.every((candidate) => {
    try {
      definition.stateSchema.parse(candidate)
      return false
    } catch {
      return true
    }
  }))
  check('the view schema rejects a malformed view', (() => {
    try {
      definition.wire.viewSchema.parse({ total: 'free' })
      return false
    } catch {
      return true
    }
  })())

  // Differential check against the reference implementation. The cost fold must
  // count exactly the tokens `dsh-token-meter` counts, or the panel would show a
  // cost that disagrees with the token figures printed beside it.
  //
  // The reference is shipped inside the harness installation rather than as a
  // dependency of this plugin, so it is located through the harness home and the
  // check is skipped when it is not there (a plain clone, or CI).
  const referencePath = [
    process.env.DSH_HOME,
    join(homedir(), '.dsh'),
  ]
    .filter((home) => typeof home === 'string' && home.length > 0)
    .map((home) => join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-token-meter', 'lib', 'types', 'usage-projection.js'))
    .find((candidate) => existsSync(candidate))
  const referenceDefinition = referencePath === undefined
    ? undefined
    : (await import(pathToFileURL(referencePath).href)).tokenUsageProjectionDefinition
  if (referenceDefinition === undefined) {
    console.log('SKIP  the differential check needs a local dsh installation (set DSH_HOME)')
  }
  const mixed = [
    headerEvent('deepseek-flash', PEAK_INSTANT),
    // A settled message that reports usage outright.
    usageEvent(1, 1, { inputTokens: 500, outputTokens: 200, cacheReadTokens: 90000, cacheWriteTokens: 0 }, PEAK_INSTANT),
    // An attempt whose usage lives only in its unassembled stream.
    { type: 'assistant/attempt', seq: (seq += 1), time: OFFPEAK_INSTANT, data: { turn: 2, step: 1, stream: [{ type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } }, { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 300, outputTokens: 700, cacheReadTokens: 1000 } } }] } },
    // A retry then a fresh attempt for the same step: both are billed.
    retryEvent(2, 1, OFFPEAK_INSTANT),
    usageEvent(2, 1, { inputTokens: 100, outputTokens: 50 }, OFFPEAK_INSTANT),
    // A silent replacement for a later step.
    usageEvent(3, 1, { inputTokens: 10, outputTokens: 5 }, OFFPEAK_INSTANT),
    usageEvent(3, 1, { inputTokens: 20, outputTokens: 9 }, PEAK_INSTANT),
  ]
  let mine = definition.init()
  let theirs = referenceDefinition === undefined ? undefined : referenceDefinition.init()
  for (const event of mixed) {
    mine = definition.apply(mine, event)
    if (referenceDefinition !== undefined) theirs = referenceDefinition.apply(theirs, event)
  }
  const mineView = definition.wire.view(mine)
  if (referenceDefinition !== undefined) {
    const referenceView = referenceDefinition.wire.view(theirs)
    check('the cost fold counts exactly what dsh-token-meter counts', mineView.totals.uncached === referenceView.uncachedInputTokens && mineView.totals.output === referenceView.outputTokens && mineView.totals.cached === referenceView.cacheReadTokens && mineView.totals.cacheWrite === referenceView.cacheWriteTokens)
  }
  // 200 + 700 (stream-carried) + 50 (post-retry) − 5 + 9 (silent replacement).
  check('the differential fixture exercised stream usage, a retry and a replacement', mineView.totals.output === 959)
}

// The peak-hour rule is part of the fold's identity: changing it must discard
// checkpoints whose timestamps were classified under the old rule.
{
  const build = (peakHours) => {
    module_.apply(ctx, { peakHours })
    return projectionSink
  }
  const base = build(undefined)
  check('the state version is stable for one rule', build(undefined).stateVersion === base.stateVersion)
  check('the state version changes with the peak-hour rule', build({ windows: [['01:00', '02:00']] }).stateVersion !== base.stateVersion)
}

// A composition without the registry must still mount, and must say it waited.
{
  registryMounted = false
  injected.length = 0
  projectionSink = undefined
  module_.apply(ctx, {})
  check('a composition without the registry still mounts the routes', routes.has('/api/usage-hud/pricing'))
  check('the plugin waits for the registry through ctx.inject', injected.includes('sessionProjections'))
  registryMounted = true
}

// ── re-mount safety ─────────────────────────────────────────────────────────
// A Loader re-import may mount the new instance before disposing the old one.
// The route table throws on a duplicate (kind, path), so apply() must retire the
// previous mount itself; otherwise a reload leaves the plugin unmounted.
{
  delete globalThis[Symbol.for('dsh.usage-hud.mount')]
  const live = new Set()
  let registrations = 0
  const strictCtx = {
    ...ctx,
    get: () => undefined,
    inject: () => {},
    webServer: {
      register(entry) {
        if (live.has(entry.path)) throw new Error(`duplicate route ${entry.path}`)
        live.add(entry.path)
        registrations += 1
        return () => live.delete(entry.path)
      },
    },
  }
  module_.apply(strictCtx, {})
  check('a first mount registers every route', live.size === 3)
  // Mount again WITHOUT disposing the first, exactly as a hot re-import may.
  module_.apply(strictCtx, {})
  check('a re-mount succeeds while the previous instance is still mounted', live.size === 3)
  check('a re-mount registers the routes again rather than throwing', registrations === 6)
  // The previous instance's own teardown must be a harmless no-op afterwards.
  globalThis[Symbol.for('dsh.usage-hud.mount')]()
  check('tearing down twice leaves no route behind', live.size === 0)
  globalThis[Symbol.for('dsh.usage-hud.mount')]()
  check('a repeated teardown is a no-op', live.size === 0)
  delete globalThis[Symbol.for('dsh.usage-hud.mount')]
}

// ── report ──────────────────────────────────────────────────────────────────
Date.now = realNow
let failed = 0
console.log('── host assertions ──')
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(`\nupstream calls made: ${upstreamCalls}`)
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('all assertions passed')
}

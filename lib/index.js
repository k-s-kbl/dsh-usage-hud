/**
 * Usage HUD, host half.
 *
 * Owns exactly one capability the browser cannot: reading the provider API
 * credential (which never leaves the host) and calling the provider's account
 * endpoint with it. It exposes one read-only JSON route, `/api/usage-hud/balance`,
 * and nothing else; every token / context figure the HUD shows is folded in the
 * browser from the Session Controller's own projections, so this half adds no
 * model-visible surface, no prompt section, and no tool.
 *
 * Credential resolution deliberately mirrors `@deepseek-ai/dsh-llm-deepseek`:
 * the `credentials` service first (inherited environment over the managed
 * `$DSH_HOME/.credentials.yaml`, with `.env` fallbacks), then the process
 * environment directly when that service is absent. Whatever key the running
 * model calls use is therefore the key this route reports on.
 *
 * The module is intentionally dependency-free (node builtins and globals only)
 * so it can be loaded straight from a checkout path without a node_modules
 * closure of its own.
 * @module @local/dsh-usage-hud
 */

/** Cordis plugin name. */
export const name = 'usage-hud'

/** The one service this half waits for: the HTTP route registry. */
export const inject = ['webServer']

/** Absolute path of the balance route (exact match, so it outranks the `/api` prefix route). */
const BALANCE_PATH = '/api/usage-hud/balance'

/** Absolute path of the price-table route. */
const PRICING_PATH = '/api/usage-hud/pricing'

/** Absolute path of the status route. */
const STATUS_PATH = '/api/usage-hud/status'

/**
 * Build revision of this host half, reported by the status route.
 *
 * Loader entries are re-imported only when a row's `name` changes, so the
 * profile patch carries this revision as a `?v=` query. Reloading a row is not
 * instantaneous and is not guaranteed to be observed on the first filesystem
 * event, so the revision is also served over HTTP: bump it with every host-side
 * edit, then poll the status route to confirm the running process actually
 * picked the change up instead of assuming it did.
 */
const MODULE_REVISION = 'usage-hud/12'

/**
 * Process-global key holding the mounted instance's teardown.
 *
 * A Loader re-import mounts a fresh instance, and it may do so before the old
 * instance is disposed. Both register the same three exact route paths and
 * `webServer.register` throws on a duplicate `(kind, path)`, so the naive
 * ordering fails: the new instance's `apply` throws, its effects unwind, and the
 * row is left unmounted. Parking the teardown on a shared symbol lets whichever
 * instance mounts second retire the first, making a re-import safe in either
 * order — and a repeated teardown a no-op, because the list drains.
 */
const MOUNT_KEY = Symbol.for('dsh.usage-hud.mount')

/** Credential reference used when the plugin config names none. */
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Environment variable naming an alternative endpoint base. */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/** Public DeepSeek endpoint; the balance document lives at `/user/balance`. */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Upstream read timeout; a hung account endpoint must not hold a socket open. */
const TIMEOUT_MS = 10_000

/**
 * Successful responses are reused for this long. The cache exists to absorb
 * bursts — several tabs, or a spend-driven read racing the idle poll — never to
 * stand in for a fresh read: the client forces past it whenever the session's
 * cost has moved, which is exactly when the figure matters.
 */
const CACHE_TTL_MS = 10_000

/** Longest upstream error excerpt echoed back to the browser. */
const MAX_ERROR_EXCERPT = 300

/**
 * Published DeepSeek list prices, CNY per million tokens, per billing regime.
 *
 * Source: <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> — the
 * public price page is the authority, and these defaults are a snapshot of it.
 * The host serves this table rather than the browser bundle carrying it,
 * because a price is a deployment fact: point the plugin at a gateway or a
 * renegotiated rate and only the loader row changes.
 *
 * `inputCacheWrite` is zero for every DeepSeek route: its context cache is
 * written automatically and is not billed separately. The field exists so a
 * provider that does charge for cache writes (Anthropic-style) can be priced
 * without a code change.
 */
const DEFAULT_PRICING = {
  'deepseek-flash': {
    offPeak: { inputCached: 0.02, inputUncached: 1, output: 4, inputCacheWrite: 0 },
    peak: { inputCached: 0.04, inputUncached: 2, output: 8, inputCacheWrite: 0 },
  },
  'deepseek-v4-pro': {
    offPeak: { inputCached: 0.15, inputUncached: 4.5, output: 13.5, inputCacheWrite: 0 },
    peak: { inputCached: 0.3, inputUncached: 9, output: 27, inputCacheWrite: 0 },
  },
  'deepseek-v4-flash': {
    offPeak: { inputCached: 0.02, inputUncached: 1, output: 4, inputCacheWrite: 0 },
    peak: { inputCached: 0.04, inputUncached: 2, output: 8, inputCacheWrite: 0 },
  },
  'deepseek-v4-flash-vision-exp': {
    offPeak: { inputCached: 0.02, inputUncached: 1, output: 4, inputCacheWrite: 0 },
    peak: { inputCached: 0.04, inputUncached: 2, output: 8, inputCacheWrite: 0 },
  },
}

/** Route used when a Session has not reported which model served it. */
const DEFAULT_PRICING_MODEL = 'deepseek-flash'

/**
 * When DeepSeek charges the peak rate. Beijing time is a fixed UTC+8 offset
 * with no daylight saving, so the rule needs no timezone database; Chinese
 * public holidays are deliberately NOT modeled, which makes the estimate
 * conservative (a holiday is priced as if it were a working day).
 */
const DEFAULT_PEAK_HOURS = {
  utcOffsetMinutes: 480,
  weekdays: [1, 2, 3, 4, 5],
  windows: [['09:00', '12:00'], ['14:00', '18:00']],
}

/**
 * Read one non-empty string field from untrusted JSON.
 * @param value - raw field value.
 * @returns the string, or undefined when absent, empty, or not a string.
 */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Pick the balance row a human should see: the provider may report several
 * currencies, and the first entry is the account's own primary currency.
 * @param body - parsed `/user/balance` document.
 * @returns normalized figures, or undefined when the document carries no row.
 */
function primaryBalance(body) {
  const infos = body !== null && typeof body === 'object' ? body.balance_infos : undefined
  if (!Array.isArray(infos) || infos.length === 0) return undefined
  const row = infos[0]
  if (row === null || typeof row !== 'object') return undefined
  return {
    currency: optionalString(row.currency) ?? 'CNY',
    total: optionalString(row.total_balance) ?? '0',
    granted: optionalString(row.granted_balance) ?? '0',
    toppedUp: optionalString(row.topped_up_balance) ?? '0',
  }
}

/**
 * Normalize the provider's availability flag.
 * @param body - parsed `/user/balance` document.
 * @returns true only when the provider explicitly affirms availability.
 */
function available(body) {
  return body !== null && typeof body === 'object' && body.is_available === true
}

/**
 * Normalize one caller-supplied price table onto the built-in defaults.
 *
 * Merging is field-by-field rather than replacing: a deployment that only
 * renegotiated output pricing restates that one number, and a model the
 * defaults do not know is added whole. Under-specified rates stay absent, and
 * the route reports them as absent so the panel can say "unpriced" instead of
 * silently charging zero.
 * @param override - `config.pricing`, or undefined to keep the defaults.
 * @returns a detached model-id-to-regime table.
 * @throws when the override is malformed — a mispriced panel is worse than none.
 */
function resolvePricing(override) {
  const table = {}
  for (const [model, regimes] of Object.entries(DEFAULT_PRICING)) {
    table[model] = { offPeak: { ...regimes.offPeak }, peak: { ...regimes.peak } }
  }
  if (override === undefined) return table
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    throw new Error('usage-hud: config.pricing must be a mapping of model id to { offPeak, peak }')
  }
  for (const [model, regimes] of Object.entries(override)) {
    if (regimes === null || typeof regimes !== 'object' || Array.isArray(regimes)) {
      throw new Error(`usage-hud: config.pricing["${model}"] must be a mapping with offPeak and/or peak`)
    }
    const target = table[model] ?? (table[model] = {})
    for (const regime of ['offPeak', 'peak']) {
      const rates = regimes[regime]
      if (rates === undefined) continue
      if (rates === null || typeof rates !== 'object' || Array.isArray(rates)) {
        throw new Error(`usage-hud: config.pricing["${model}"].${regime} must be a mapping of rate to number`)
      }
      const merged = { ...(target[regime] ?? {}) }
      for (const [rate, value] of Object.entries(rates)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new Error(`usage-hud: config.pricing["${model}"].${regime}.${rate} must be a non-negative finite number`)
        }
        merged[rate] = value
      }
      target[regime] = merged
    }
  }
  return table
}

/**
 * Parse one `HH:MM` window bound into minutes past midnight.
 * @param value - the literal from `config.peakHours.windows`.
 * @returns minutes past midnight.
 * @throws when the literal is not `HH:MM`.
 */
function windowBound(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(String(value))
  if (match === null) throw new Error(`usage-hud: peakHours window bound "${String(value)}" must be HH:MM`)
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Normalize the peak-hour rule, converting window literals to minutes once.
 * @param override - `config.peakHours`, or undefined to keep the defaults.
 * @returns the rule with minute bounds.
 * @throws when the override is malformed.
 */
function resolvePeakHours(override) {
  const source = override === undefined ? DEFAULT_PEAK_HOURS : override
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('usage-hud: config.peakHours must be a mapping')
  }
  const utcOffsetMinutes = source.utcOffsetMinutes ?? DEFAULT_PEAK_HOURS.utcOffsetMinutes
  if (!Number.isInteger(utcOffsetMinutes) || utcOffsetMinutes < -720 || utcOffsetMinutes > 840) {
    throw new Error('usage-hud: config.peakHours.utcOffsetMinutes must be an integer from -720 through 840')
  }
  const weekdays = source.weekdays ?? DEFAULT_PEAK_HOURS.weekdays
  if (!Array.isArray(weekdays) || weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('usage-hud: config.peakHours.weekdays must be a non-empty array of 0..6 (0 = Sunday)')
  }
  const windows = source.windows ?? DEFAULT_PEAK_HOURS.windows
  if (!Array.isArray(windows) || windows.some((window) => !Array.isArray(window) || window.length !== 2)) {
    throw new Error('usage-hud: config.peakHours.windows must be an array of [start, end] HH:MM pairs')
  }
  return {
    utcOffsetMinutes,
    weekdays,
    windows: windows.map(([start, end]) => [windowBound(start), windowBound(end)]),
  }
}

/**
 * Classify one instant against the peak-hour rule.
 * @param now - epoch milliseconds.
 * @param peakHours - a rule from {@link resolvePeakHours}.
 * @returns `'peak'` or `'offPeak'`.
 */
function regimeAt(now, peakHours) {
  // Shift the instant into the billing timezone, then read it as UTC fields.
  const shifted = new Date(now + peakHours.utcOffsetMinutes * 60_000)
  if (!peakHours.weekdays.includes(shifted.getUTCDay())) return 'offPeak'
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  for (const [start, end] of peakHours.windows) {
    if (minutes >= start && minutes < end) return 'peak'
  }
  return 'offPeak'
}

/** One regime bucket set: tokens attributed to peak or off-peak consumption. */
function zeroBuckets() {
  return { cached: 0, uncached: 0, output: 0, cacheWrite: 0 }
}

/** Token bucket keys, in display order. */
const BUCKET_KEYS = ['cached', 'uncached', 'output', 'cacheWrite']

/** Coerce an untrusted token count to a non-negative finite number. */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Bucket one provider usage sample the way `dsh-token-meter` does, so this
 * fold and the `tokenUsage` projection cannot disagree about what a token is.
 * @param usage - the sample's `TokenUsage`.
 * @returns the four token buckets.
 */
function bucketsOf(usage) {
  return {
    cached: tokenCount(usage.cacheReadTokens),
    uncached: tokenCount(usage.inputTokens),
    output: tokenCount(usage.outputTokens),
    cacheWrite: tokenCount(usage.cacheWriteTokens),
  }
}

/** Add two bucket sets into a fresh one. */
function addBuckets(left, right) {
  const sum = {}
  for (const key of BUCKET_KEYS) sum[key] = left[key] + right[key]
  return sum
}

/** Subtract one bucket set from another into a fresh one, never going negative. */
function subBuckets(left, right) {
  const difference = {}
  for (const key of BUCKET_KEYS) difference[key] = Math.max(0, left[key] - right[key])
  return difference
}

/** Whether two bucket sets are identical. */
function bucketsEqual(left, right) {
  return BUCKET_KEYS.every((key) => left[key] === right[key])
}

/**
 * Extract the usage one durable Assistant settlement reports, mirroring
 * `dsh-token-meter`'s rule exactly: an explicit `data.usage` first, otherwise
 * the last `usage` chunk of the still-unassembled stream. Duplicated here
 * rather than imported so this half keeps resolving from a bare checkout path.
 * @param event - one committed session event.
 * @returns the usage sample, or undefined when the event carries none.
 */
function usageOf(event) {
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (event.type === 'assistant/message' && data.usage !== undefined && data.usage !== null) return data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = Array.isArray(data.stream) ? data.stream : []
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === null || typeof record !== 'object' || record.type !== 'chunk') continue
    const chunk = record.chunk
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage !== undefined) return chunk.usage
  }
  return undefined
}

/**
 * The provider/model one request header routed to.
 * @param event - a `request/header` event.
 * @returns the model id, or undefined when the header is malformed.
 */
function modelOfHeader(event) {
  const config = event.data === null || typeof event.data !== 'object' ? undefined : event.data.header?.config
  const model = config === null || typeof config !== 'object' ? undefined : config.model
  return typeof model === 'string' && model.length > 0 ? model : undefined
}

/**
 * Derive the fold's `stateVersion` from the peak-hour rule.
 *
 * A checkpoint is discarded on a version mismatch, which is what makes a
 * changed window definition re-fold the log instead of keeping timestamps
 * classified under the old rule. Costs need no such treatment: they are
 * computed in the view from the current table, so a rate change re-prices a
 * restored checkpoint correctly.
 * @param peakHours - the normalized rule.
 * @returns a stable positive integer.
 */
function stateVersionFor(peakHours) {
  const text = JSON.stringify(peakHours)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return 1 + ((hash >>> 0) % 100000)
}

/** Structural validation for a restored cost checkpoint; throws to discard it. */
function parseCostState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('usage-hud: cost state must be an object')
  const cells = value.cells
  if (cells === null || typeof cells !== 'object' || Array.isArray(cells)) throw new TypeError('usage-hud: cost state needs a cells object')
  const normalized = { model: typeof value.model === 'string' ? value.model : null, samples: tokenCount(value.samples), last: null, cells: { peak: {}, offPeak: {} } }
  for (const regime of ['peak', 'offPeak']) {
    const byModel = cells[regime]
    if (byModel === null || typeof byModel !== 'object' || Array.isArray(byModel)) throw new TypeError(`usage-hud: cost state cells.${regime} must be an object`)
    for (const [model, buckets] of Object.entries(byModel)) {
      if (buckets === null || typeof buckets !== 'object') throw new TypeError(`usage-hud: cost state cells.${regime}["${model}"] must be a bucket set`)
      const clean = zeroBuckets()
      for (const key of BUCKET_KEYS) clean[key] = tokenCount(buckets[key])
      normalized.cells[regime][model] = clean
    }
  }
  const last = value.last
  if (last !== null && last !== undefined && typeof last === 'object' && last.buckets !== undefined && (last.regime === 'peak' || last.regime === 'offPeak') && typeof last.model === 'string') {
    normalized.last = {
      turn: tokenCount(last.turn),
      step: tokenCount(last.step),
      regime: last.regime,
      model: last.model,
      buckets: BUCKET_KEYS.reduce((carry, key) => ({ ...carry, [key]: tokenCount(last.buckets[key]) }), {}),
    }
  }
  return normalized
}

/**
 * Build the `usageCost` projection unit: a pure fold over committed session
 * events that attributes every provider usage sample to **the billing regime at
 * the instant it was consumed** and to **the model the request routed to**.
 *
 * This is what makes the panel's cost figure correct rather than indicative: a
 * session that runs across a peak boundary is priced per sample, and a session
 * that switches models mid-way is priced per route. `tokenUsage` alone cannot
 * answer either question, because it is a whole-log aggregate with neither
 * timestamps nor model attribution.
 * @param pricing - the resolved model-id-to-regime rate table.
 * @param peakHours - the normalized peak-hour rule.
 * @param defaultModel - the model row used before any request header is seen.
 * @param stats - process-wide fold counters, reported by the status route.
 * @returns a definition for `ctx.sessionProjections.register`.
 */
function makeCostProjection(pricing, peakHours, defaultModel, stats) {
  /** Cost of one bucket set under one model's rates for one regime. */
  const priceBuckets = (buckets, model, regime) => {
    const rates = pricing[model] === undefined ? undefined : pricing[model][regime]
    if (rates === undefined) return { cost: 0, priced: false }
    let cost = 0
    // Each bucket's own rate; a missing one contributes nothing and is reported
    // through `priced: false` rather than silently understating.
    if (typeof rates.inputCached === 'number') cost += buckets.cached * rates.inputCached
    if (typeof rates.inputUncached === 'number') cost += buckets.uncached * rates.inputUncached
    if (typeof rates.output === 'number') cost += buckets.output * rates.output
    if (typeof rates.inputCacheWrite === 'number') cost += buckets.cacheWrite * rates.inputCacheWrite
    const complete = ['inputCached', 'inputUncached', 'output', 'inputCacheWrite'].every((key) => typeof rates[key] === 'number')
    return { cost, priced: complete }
  }

  // View memo keyed by state identity: the registry publishes only when the raw
  // view result changes by Object.is, and a fresh object per call would publish
  // on every unrelated event. A WeakMap keeps sessions independent.
  const views = new WeakMap()

  return {
    key: 'usageCost',
    stateVersion: stateVersionFor(peakHours),
    stateSchema: { parse: parseCostState },
    init: () => {
      stats.sessions += 1
      return { model: null, samples: 0, last: null, cells: { peak: {}, offPeak: {} } }
    },
    apply: (state, event) => {
      if (event === null || typeof event !== 'object') return state
      stats.events += 1

      if (event.type === 'request/header') {
        const model = modelOfHeader(event)
        if (model === undefined || model === state.model) return state
        return { ...state, model }
      }

      if (event.type === 'llm/retry-started') {
        // A retry re-reports the same step; closing the replacement slot makes
        // the retried attempt add to the total instead of replacing the first.
        const data = event.data
        const sameStep = state.last !== null && data !== null && typeof data === 'object' && state.last.turn === data.turn && state.last.step === data.step
        return sameStep ? { ...state, last: null } : state
      }

      const usage = usageOf(event)
      if (usage === undefined) return state
      stats.samples += 1

      const data = event.data
      const turn = tokenCount(data.turn)
      const step = tokenCount(data.step)
      const buckets = bucketsOf(usage)
      const regime = regimeAt(typeof event.time === 'number' ? event.time : Date.now(), peakHours)
      const model = state.model ?? defaultModel
      const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : undefined

      // Skip only when re-folding this sample would change nothing at all. A
      // settled message re-reports the attempt's own usage, and that repeat can
      // legitimately land in a later billing window: skipping on equal buckets
      // alone would strand those tokens in the window the attempt started in.
      if (previous !== undefined && previous.regime === regime && previous.model === model && bucketsEqual(previous.buckets, buckets)) return state

      const cells = { peak: { ...state.cells.peak }, offPeak: { ...state.cells.offPeak } }
      let samples = state.samples

      if (previous !== undefined) {
        cells[previous.regime][previous.model] = subBuckets(cells[previous.regime][previous.model] ?? zeroBuckets(), previous.buckets)
        samples -= 1
      }
      cells[regime][model] = addBuckets(cells[regime][model] ?? zeroBuckets(), buckets)
      samples += 1

      return { model: state.model, samples, last: { turn, step, regime, model, buckets }, cells }
    },
    wire: {
      // The view is built here from validated state, so validation is a shape
      // assertion against our own bug rather than against foreign input.
      viewSchema: {
        parse: (value) => {
          if (value === null || typeof value !== 'object' || !Number.isFinite(value.total) || !Number.isFinite(value.samples)) {
            throw new TypeError('usage-hud: cost view is malformed')
          }
          return value
        },
      },
      view: (state) => {
        const cached = views.get(state)
        if (cached !== undefined) return cached

        const totals = zeroBuckets()
        const byBucketCost = { cached: 0, uncached: 0, output: 0, cacheWrite: 0 }
        const modelTotals = new Map()
        const regimeTokens = { peak: zeroBuckets(), offPeak: zeroBuckets() }
        const regimeCost = { peak: 0, offPeak: 0 }
        const unpriced = new Set()
        let total = 0

        for (const regime of ['peak', 'offPeak']) {
          for (const [model, buckets] of Object.entries(state.cells[regime])) {
            const { cost, priced } = priceBuckets(buckets, model, regime)
            total += cost
            regimeCost[regime] += cost
            regimeTokens[regime] = addBuckets(regimeTokens[regime], buckets)
            totals.cached += buckets.cached
            totals.uncached += buckets.uncached
            totals.output += buckets.output
            totals.cacheWrite += buckets.cacheWrite
            const rates = pricing[model] === undefined ? undefined : pricing[model][regime]
            if (rates !== undefined) {
              if (typeof rates.inputCached === 'number') byBucketCost.cached += buckets.cached * rates.inputCached
              if (typeof rates.inputUncached === 'number') byBucketCost.uncached += buckets.uncached * rates.inputUncached
              if (typeof rates.output === 'number') byBucketCost.output += buckets.output * rates.output
              if (typeof rates.inputCacheWrite === 'number') byBucketCost.cacheWrite += buckets.cacheWrite * rates.inputCacheWrite
            }
            if (!priced) unpriced.add(model)
            const entry = modelTotals.get(model) ?? { model, tokens: zeroBuckets(), cost: 0, priced: priced }
            modelTotals.set(model, { model, tokens: addBuckets(entry.tokens, buckets), cost: entry.cost + cost, priced: entry.priced && priced })
          }
        }

        const view = {
          samples: state.samples,
          totals,
          total: total / 1_000_000,
          byBucket: {
            cached: byBucketCost.cached / 1_000_000,
            uncached: byBucketCost.uncached / 1_000_000,
            output: byBucketCost.output / 1_000_000,
            cacheWrite: byBucketCost.cacheWrite / 1_000_000,
          },
          byRegime: {
            peak: { tokens: regimeTokens.peak, cost: regimeCost.peak / 1_000_000 },
            offPeak: { tokens: regimeTokens.offPeak, cost: regimeCost.offPeak / 1_000_000 },
          },
          byModel: [...modelTotals.values()].map((entry) => ({ ...entry, cost: entry.cost / 1_000_000 })),
          unpricedModels: [...unpriced].sort(),
        }
        views.set(state, view)
        return view
      },
    },
  }
}

/**
 * Register the plugin's two read-only routes.
 * @param ctx - host context (must already provide `webServer`).
 * @param config - `{ apiKeyEnv?, baseURL?, pricing?, defaultModel?, peakHours? }` from the loader row.
 */
export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const apiKeyEnv = optionalString(settings.apiKeyEnv) ?? DEFAULT_API_KEY_ENV
  const configuredBase = optionalString(settings.baseURL)
  const pricing = resolvePricing(settings.pricing)
  const peakHours = resolvePeakHours(settings.peakHours)
  const defaultModel = optionalString(settings.defaultModel) ?? DEFAULT_PRICING_MODEL

  /** Whether the optional cost projection attached to the registry. */
  let registered = false
  /** Fold counters and attachment facts reported by the status route. */
  const stats = { sessions: 0, events: 0, samples: 0, sawService: false, injectFired: false, registerError: undefined }

  /** Resolved endpoint base for this process (config beats environment beats public). */
  const baseURL = (configuredBase ?? optionalString(process.env[BASE_URL_ENV]) ?? DEFAULT_BASE_URL).replace(/\/+$/u, '')

  /** Last successful payload plus its timestamp; only `ok` results are cached. */
  let cache
  /** Single in-flight read, so concurrent polls share one upstream call. */
  let inflight

  /**
   * Resolve the API key through the same seam the LLM adapter uses.
   * @returns the secret and its provenance, or undefined when nothing is stored.
   */
  async function resolveKey() {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(apiKeyEnv)
        const value = hit === undefined ? undefined : optionalString(hit.value)
        if (value !== undefined) return { value, source: optionalString(hit.source) ?? 'credentials' }
      } catch (error) {
        ctx.logger.warn(`usage-hud: credentials service refused ${apiKeyEnv}: ${String(error)}`)
      }
    }
    const ambient = optionalString(process.env[apiKeyEnv])
    if (ambient !== undefined) return { value: ambient, source: 'env' }
    return undefined
  }

  /**
   * Read the account balance once.
   * @returns the wire payload for the route (never carries the secret).
   */
  async function readBalance() {
    const key = await resolveKey()
    const common = { apiKeyEnv, baseURL }
    if (key === undefined) {
      return {
        ok: false,
        code: 'NO_CREDENTIAL',
        message: `no credential for ${apiKeyEnv} — store it on the Models settings page, or export it in the launching environment`,
        ...common,
      }
    }
    let response
    try {
      response = await fetch(`${baseURL}/user/balance`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key.value}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      const timedOut = error !== null && typeof error === 'object' && error.name === 'TimeoutError'
      return {
        ok: false,
        code: timedOut ? 'TIMEOUT' : 'TRANSPORT',
        message: timedOut ? `${baseURL} did not answer within ${String(TIMEOUT_MS)}ms` : String(error),
        ...common,
        keySource: key.source,
      }
    }
    if (!response.ok) {
      let excerpt = ''
      try {
        excerpt = (await response.text()).slice(0, MAX_ERROR_EXCERPT)
      } catch {
        excerpt = ''
      }
      return {
        ok: false,
        code: `HTTP_${String(response.status)}`,
        message: excerpt.length > 0 ? excerpt : `provider answered HTTP ${String(response.status)}`,
        ...common,
        keySource: key.source,
      }
    }
    let body
    try {
      body = await response.json()
    } catch (error) {
      return { ok: false, code: 'MALFORMED', message: `provider returned unparsable JSON: ${String(error)}`, ...common, keySource: key.source }
    }
    const row = primaryBalance(body)
    if (row === undefined) {
      return { ok: false, code: 'NO_BALANCE_ROW', message: 'provider returned no balance_infos entry', ...common, keySource: key.source }
    }
    return { ok: true, isAvailable: available(body), ...row, fetchedAt: Date.now(), ...common, keySource: key.source }
  }

  /**
   * Cache-and-dedupe wrapper around {@link readBalance}.
   * @param force - bypass a fresh cache entry (the UI's manual refresh).
   * @returns the payload and whether it was served from cache.
   */
  function balance(force) {
    const now = Date.now()
    if (!force && cache !== undefined && now - cache.at < CACHE_TTL_MS) {
      return Promise.resolve({ payload: cache.payload, cached: true })
    }
    if (inflight === undefined) {
      inflight = readBalance()
        .catch((error) => ({ ok: false, code: 'INTERNAL', message: String(error), apiKeyEnv, baseURL }))
        .then((payload) => {
          inflight = undefined
          if (payload.ok === true) cache = { at: Date.now(), payload }
          return payload
        })
    }
    return inflight.then((payload) => ({ payload, cached: false }))
  }

  /**
   * Apply the two guards both routes share: read-only methods, and a request
   * the browser did not mark as same-origin. A cross-site page can still *send*
   * a GET here; the header check is what keeps the account figure out of a
   * third-party document. An absent header (curl, tests) is allowed.
   * @param req - incoming request.
   * @param res - response owned by this handler.
   * @returns true when the request may proceed.
   */
  function admitted(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
      res.end('method not allowed')
      return false
    }
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return false
    }
    return true
  }

  /** Write one JSON payload with the no-store policy both routes use. */
  function sendJson(res, payload) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  /**
   * The balance route: current account balance at the configured endpoint.
   * @param req - incoming request.
   * @param res - response owned by this handler.
   */
  async function balanceHandler(req, res) {
    if (!admitted(req, res)) return
    let force = false
    try {
      force = new URL(req.url ?? BALANCE_PATH, 'http://127.0.0.1').searchParams.get('refresh') === '1'
    } catch {
      force = false
    }
    const { payload, cached } = await balance(force)
    sendJson(res, { ...payload, cached })
  }

  /**
   * The pricing route: the rate table plus the regime in force right now, so
   * the browser never carries a vendor price of its own and never has to model
   * the billing timezone. The regime is evaluated per request, which is what
   * makes the client's figure follow a peak boundary without a reload.
   * @param req - incoming request.
   * @param res - response owned by this handler.
   */
  function pricingHandler(req, res) {
    if (!admitted(req, res)) return
    sendJson(res, {
      ok: true,
      currency: 'CNY',
      unit: 1_000_000,
      regime: regimeAt(Date.now(), peakHours),
      models: pricing,
      defaultModel,
      peakHours,
      computedAt: Date.now(),
    })
  }

  /**
   * The status route: which build of this host half is actually running, and
   * whether the optional cost projection attached. Exists because a live row
   * reload can silently not be observed, and because "the split is missing" has
   * two very different causes worth telling apart.
   * @param req - incoming request.
   * @param res - response owned by this handler.
   */
  function statusHandler(req, res) {
    if (!admitted(req, res)) return
    sendJson(res, {
      ok: true,
      revision: MODULE_REVISION,
      credential: { apiKeyEnv, baseURL },
      pricing: { models: Object.keys(pricing), defaultModel, peakHours },
      projection: {
        registered,
        // Why the projection did or did not attach, and the process-wide fold
        // counters — enough to tell "the service was never in scope" apart from
        // "the fold is not being driven".
        sawService: stats.sawService,
        injectFired: stats.injectFired,
        registerError: stats.registerError,
        sessions: stats.sessions,
        events: stats.events,
        samples: stats.samples,
      },
    })
  }

  // Retire any instance a previous import left mounted, before touching the
  // route table. See MOUNT_KEY: without this a reload of this row fails on a
  // duplicate route registration and leaves the plugin unmounted.
  const mounted = []
  const teardown = () => {
    while (mounted.length > 0) {
      const dispose = mounted.pop()
      try {
        dispose()
      } catch (error) {
        ctx.logger.warn(`usage-hud: releasing a previous mount failed: ${String(error)}`)
      }
    }
  }
  if (globalThis[MOUNT_KEY] !== undefined) {
    try {
      globalThis[MOUNT_KEY]()
    } catch (error) {
      ctx.logger.warn(`usage-hud: retiring a previous mount failed: ${String(error)}`)
    }
  }
  globalThis[MOUNT_KEY] = teardown

  mounted.push(ctx.webServer.register({ kind: 'exact', path: BALANCE_PATH, handler: balanceHandler }))
  mounted.push(ctx.webServer.register({ kind: 'exact', path: PRICING_PATH, handler: pricingHandler }))
  mounted.push(ctx.webServer.register({ kind: 'exact', path: STATUS_PATH, handler: statusHandler }))
  ctx.logger.info(`usage-hud ${MODULE_REVISION}: routes at ${BALANCE_PATH}, ${PRICING_PATH}, ${STATUS_PATH} (credential ${apiKeyEnv}, endpoint ${baseURL}, ${Object.keys(pricing).length} priced models)`)

  // The cost split rides the session-projection registry rather than a fourth
  // route: the registry owns the event subscription, the per-session
  // checkpoint, fork inheritance, and the client push, and this unit is exactly
  // a pure fold over committed events. Optional, because a composition without
  // the registry still gets the client's single-regime estimate.
  // Always attach through `ctx.inject`, never by reading the property off this
  // context: cordis gates property access behind the plugin's `inject` list, so
  // `ctx.sessionProjections` throws "cannot get property ... without inject"
  // even when `ctx.get()` already returns the service. The inject callback
  // receives a context the service is properly injected into.
  const costProjection = makeCostProjection(pricing, peakHours, defaultModel, stats)
  stats.sawService = ctx.get('sessionProjections') !== undefined
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    stats.injectFired = true
    try {
      mounted.push(projectionCtx.sessionProjections.register(costProjection))
      registered = true
    } catch (error) {
      // The split is an enhancement, not the plugin: a registry that refuses
      // this unit must not take the balance and pricing routes down with it.
      stats.registerError = String(error !== null && error !== undefined && error.message !== undefined ? error.message : error)
      ctx.logger.warn(`usage-hud: the usageCost projection was refused: ${stats.registerError}`)
    }
  })

  ctx.effect(() => teardown, 'usage-hud: unmount')
}

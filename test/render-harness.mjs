/**
 * Offline render harness for the usage-HUD client bundle.
 *
 * The browser bundle cannot be opened here, so this script loads it exactly as
 * `window.__ModuleLoader__` would, then renders `HudBody` through a minimal
 * React shim that supports the hook subset the component uses. It exists to
 * catch reference errors, bad field access, wrong cost arithmetic, and
 * locale-key drift in every render branch — not to prove visual correctness.
 *
 * Usage: `node test/render-harness.mjs`
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

// ── browser globals the bundle touches at module scope ──────────────────────
const styleTags = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', appendChild() {}, remove() {} }),
  head: { appendChild: (tag) => styleTags.push(tag) },
  body: { appendChild() {}, removeChild() {} },
}
globalThis.localStorage = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null
  },
  setItem(key, value) {
    this.store.set(key, value)
  },
}
globalThis.innerWidth = 1440
globalThis.innerHeight = 900

// ── minimal React shim ──────────────────────────────────────────────────────
let hookCursor = 0
let stateOverrides = []

const React = {
  createElement(type, props, ...children) {
    const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { __el: true, type, props: { ...(props ?? {}), ...(flat === undefined ? {} : { children: flat }) } }
  },
  useState(initial) {
    const index = hookCursor++
    if (stateOverrides.length > index && stateOverrides[index] !== undefined) return [stateOverrides[index], () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useMemo(factory) {
    hookCursor++
    return factory()
  },
  useRef(initial) {
    hookCursor++
    return { current: initial }
  },
  useCallback(fn) {
    hookCursor++
    return fn
  },
}
const ReactDOM = {
  createPortal(children, container) {
    return { __el: true, type: 'portal', props: { children, container } }
  },
}

// ── load the bundle exactly as the module system does ───────────────────────
let registration
globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
new Function(readFileSync(bundlePath, 'utf8'))()

if (registration === undefined) throw new Error('bundle registered nothing through window.__ModuleLoader__.load')
if (registration.id !== '@local/dsh-usage-hud') throw new Error(`unexpected bundle id ${registration.id}`)

const require = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react-dom') return ReactDOM
  throw new Error(`harness: unexpected module request "${spec}"`)
}
const exports = registration.factory(require)
if (typeof exports.apply !== 'function') throw new Error('bundle exports no apply()')
if (!Array.isArray(exports.inject)) throw new Error('bundle exports no inject list')

// ── slot registration through a stub client context ─────────────────────────
const registered = []
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  locale: {
    register(namespace, dictionaries) {
      registered.push({ kind: 'locale', namespace, dictionaries })
      return () => {}
    },
  },
  slots: {
    inject(slotName, factory) {
      registered.push({ kind: 'inject', slotName })
      factory()
      return () => {}
    },
    register(options, component) {
      registered.push({ kind: 'slot', options, component })
      return () => {}
    },
  },
}
exports.apply(ctx)

const locale = registered.find((entry) => entry.kind === 'locale')
const slot = registered.find((entry) => entry.kind === 'slot')
if (locale === undefined) throw new Error('apply() registered no locale dictionaries')
if (slot === undefined) throw new Error('apply() registered no slot entry')
if (slot.options.name !== 'conversation.input.overlay') throw new Error(`unexpected slot ${slot.options.name}`)
if (slot.options.locale !== locale.namespace) throw new Error('slot locale namespace does not match the registered dictionaries')
if (registered.find((entry) => entry.kind === 'inject') === undefined) throw new Error('apply() did not wait for its slot through slots.inject')

const zhKeys = Object.keys(locale.dictionaries.zh).sort()
const enKeys = Object.keys(locale.dictionaries.en).sort()
if (zhKeys.join('|') !== enKeys.join('|')) {
  const missingEn = zhKeys.filter((key) => !enKeys.includes(key))
  const missingZh = enKeys.filter((key) => !zhKeys.includes(key))
  throw new Error(`locale drift — only zh: ${missingEn.join(', ')}; only en: ${missingZh.join(', ')}`)
}

const fill = (template, params) =>
  template.replace(/\{(\w+)\}/g, (_, name) => (params !== undefined && params[name] !== undefined ? String(params[name]) : `{${name}}`))

const asked = new Set()
const t = (key, params) => {
  asked.add(key)
  const template = locale.dictionaries.zh[key]
  if (template === undefined) throw new Error(`render asked for undefined locale key "${key}"`)
  return fill(template, params)
}

// ── fixtures ────────────────────────────────────────────────────────────────
/** The token totals every priced branch starts from. */
const TOTALS = { uncachedInputTokens: 1240, outputTokens: 45310, cacheReadTokens: 238400, cacheWriteTokens: 0 }

/** The live host pricing payload, reduced to two models. */
const pricingPayload = (regime) => ({
  ok: true,
  currency: 'CNY',
  unit: 1_000_000,
  regime,
  defaultModel: 'deepseek-flash',
  models: {
    'deepseek-flash': {
      offPeak: { inputCached: 0.02, inputUncached: 1, output: 4, inputCacheWrite: 0 },
      peak: { inputCached: 0.04, inputUncached: 2, output: 8, inputCacheWrite: 0 },
    },
    'deepseek-v4-pro': {
      offPeak: { inputCached: 0.15, inputUncached: 4.5, output: 13.5, inputCacheWrite: 0 },
      peak: { inputCached: 0.3, inputUncached: 9, output: 27, inputCacheWrite: 0 },
    },
  },
})

/** Independently computed expectations, so the assertion is not the code under test. */
const expectOffPeakFlash = 238400 * 0.02 / 1e6 + 1240 * 1 / 1e6 + 45310 * 4 / 1e6
const expectPeakFlash = 238400 * 0.04 / 1e6 + 1240 * 2 / 1e6 + 45310 * 8 / 1e6
const expectOffPeakPro = 238400 * 0.15 / 1e6 + 1240 * 4.5 / 1e6 + 45310 * 13.5 / 1e6
const money = (value) => `¥${value < 1 ? value.toFixed(4) : value.toFixed(2)}`

const balanceOk = {
  phase: 'done',
  at: Date.now(),
  payload: {
    ok: true,
    isAvailable: true,
    currency: 'CNY',
    total: '110.00',
    granted: '0.00',
    toppedUp: '110.00',
    fetchedAt: Date.now() - 5_000,
    cached: false,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com',
    keySource: 'env',
  },
}

/**
 * A session that genuinely straddled the peak boundary: 30k output tokens were
 * consumed during peak at ¥8/M and 15.31k during off-peak at ¥4/M. The
 * regime-split figure is the one the host's `usageCost` projection reports.
 */
const costSplit = {
  samples: 6,
  totals: { cached: 238400, uncached: 1240, output: 45310, cacheWrite: 0 },
  total: 0.309648,
  byBucket: { cached: 0.006768, uncached: 0.00164, output: 0.30124, cacheWrite: 0 },
  byRegime: {
    peak: { tokens: { cached: 100000, uncached: 400, output: 30000, cacheWrite: 0 }, cost: 0.2448 },
    offPeak: { tokens: { cached: 138400, uncached: 840, output: 15310, cacheWrite: 0 }, cost: 0.064848 },
  },
  byModel: [{ model: 'deepseek-flash', tokens: { cached: 238400, uncached: 1240, output: 45310, cacheWrite: 0 }, cost: 0.309648, priced: true }],
  unpricedModels: [],
}

/** The same session, but its model has no configured rates. */
const costSplitUnpriced = {
  ...costSplit,
  byModel: [{ model: 'acme-large', tokens: costSplit.totals, cost: 0, priced: false }],
  unpricedModels: ['acme-large'],
}

const baseProjections = {
  tokenUsage: TOTALS,
  contextPressure: { projectedTokens: 233_984, pressureTokens: 231_002, contextWindow: 1_000_000 },
  contextBreakdown: { systemTokens: 12_400, toolsTokens: 8_410, messageTokens: 213_174 },
  sessionStats: { turns: 3, steps: 12, llmMs: 92_400, toolMs: 12_000, ttftMs: 900, ttftSteps: 3, decodeMs: 40_000, decodeTokens: 45_310 },
  modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' }, next: null },
}
const projections = {}

// ── render the tree and collect text ────────────────────────────────────────
function render(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) {
    for (const child of node) render(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (node.__el !== true) return out
  if (node.type === 'portal') {
    render(node.props.children, out)
    return out
  }
  if (typeof node.type === 'function') {
    hookCursor = 0
    render(node.type(node.props), out)
    return out
  }
  render(node.props?.children, out)
  return out
}

let lastText = ''
/** Render one branch with seeded hook state and projection fixtures. */
function renderBranch(label, overrides, projectionPatch) {
  for (const key of Object.keys(projections)) delete projections[key]
  Object.assign(projections, baseProjections, projectionPatch ?? {})
  hookCursor = 0
  stateOverrides = overrides ?? []
  lastText = render(React.createElement(slot.component, { sessionId: 'session-test', useProjection: (key) => projections[key], t }))
    .filter((part) => part.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  console.log(`\n[${label}]\n${lastText}`)
  return lastText
}

const loading = renderBranch('expanded · loading', [undefined, undefined, { phase: 'loading' }])
const done = renderBranch('expanded · off-peak flash', [undefined, balanceOk, { phase: 'done', payload: pricingPayload('offPeak') }])
const peak = renderBranch('expanded · peak flash', [undefined, balanceOk, { phase: 'done', payload: pricingPayload('peak') }])
const proModel = renderBranch(
  'expanded · pro model',
  [undefined, balanceOk, { phase: 'done', payload: pricingPayload('offPeak') }],
  { modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, next: null } },
)
const unknownModel = renderBranch(
  'expanded · unknown model falls back to the default row',
  [undefined, balanceOk, { phase: 'done', payload: pricingPayload('offPeak') }],
  { modelSelection: { lastUsed: { provider: 'acme', model: 'mystery-1' }, next: null } },
)
const noPricing = renderBranch('expanded · pricing route unavailable', [undefined, balanceOk, { phase: 'error', message: 'boom' }])
const incomplete = renderBranch('expanded · partial rate set', [
  undefined,
  balanceOk,
  {
    phase: 'done',
    payload: {
      ...pricingPayload('offPeak'),
      models: { 'deepseek-flash': { offPeak: { inputCached: 0.02 }, peak: { inputCached: 0.04 } } },
    },
  },
])
const emptySession = renderBranch('expanded · no projections yet', [undefined, balanceOk, { phase: 'done', payload: pricingPayload('offPeak') }], {
  tokenUsage: undefined,
  contextPressure: undefined,
  contextBreakdown: undefined,
  sessionStats: undefined,
  modelSelection: undefined,
})
const zeroUsage = renderBranch('expanded · priced but nothing spent yet', [undefined, balanceOk, { phase: 'done', payload: pricingPayload('offPeak') }], {
  tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
})
const collapsed = renderBranch('collapsed pill', [
  { collapsed: true, right: 16, bottom: 96 },
  balanceOk,
  { phase: 'done', payload: pricingPayload('offPeak') },
])

// The regime-split branch: the host projection is authoritative and must win
// over the local single-regime estimate.
const splitPricing = renderBranch('expanded · regime-split cost from the host projection', [undefined, balanceOk, { phase: 'done', payload: pricingPayload('offPeak') }], { usageCost: costSplit })
const splitNoRates = renderBranch('expanded · split cost without the price table', [undefined, balanceOk, { phase: 'error', message: 'boom' }], { usageCost: costSplit })
const splitUnpriced = renderBranch('expanded · split cost for an unpriced model', [undefined, balanceOk, { phase: 'done', payload: pricingPayload('offPeak') }], { usageCost: costSplitUnpriced })
const splitEmpty = renderBranch('expanded · projection present but no samples', [undefined, balanceOk, { phase: 'done', payload: pricingPayload('offPeak') }], { usageCost: { ...costSplit, samples: 0, total: 0, byRegime: { peak: { tokens: {}, cost: 0 }, offPeak: { tokens: {}, cost: 0 } } } })

// ── the balance refresh cadence ─────────────────────────────────────────────
// The reported bug was that the balance lagged the cost; these drive the policy
// with a fake clock, since the React shim cannot run effects.
const cadenceChecks = []
const check = (label, ok) => cadenceChecks.push([label, ok === true])
{
  const { createBalanceScheduler, BALANCE_SETTLE_MS, BALANCE_MIN_GAP_MS, BALANCE_RETRY_MS, BALANCE_RETRY_BUDGET } = exports.internals
  /** A fake clock whose pending timers run only when the test advances it. */
  const harness = () => {
    let clock = 0
    let nextId = 1
    const timers = new Map()
    const reads = []
    const scheduler = createBalanceScheduler({
      run: (force) => reads.push({ at: clock, force }),
      now: () => clock,
      setTimeout: (fn, delay) => {
        const id = nextId++
        timers.set(id, { at: clock + delay, fn })
        return id
      },
      clearTimeout: (id) => timers.delete(id),
    })
    /** Advance the clock, firing every timer due on the way. */
    const advance = (ms) => {
      const target = clock + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        clock = due[1].at
        due[1].fn()
      }
      clock = target
    }
    return { scheduler, reads, advance, at: () => clock }
  }

  // A spend triggers exactly one read, after the settle delay, and forces it.
  {
    const h = harness()
    h.scheduler.onSpend()
    h.advance(BALANCE_SETTLE_MS - 1)
    check('a spend schedules no read before the burst settles', h.reads.length === 0)
    h.advance(1)
    check('a spend reads once the burst settles', h.reads.length === 1)
    check('a spend-driven read bypasses the host cache', h.reads[0].force === true)
  }

  // Many samples in one burst must still cost one upstream read.
  {
    const h = harness()
    for (let sample = 0; sample < 25; sample += 1) h.scheduler.onSpend()
    h.advance(BALANCE_SETTLE_MS)
    check('a burst of usage samples coalesces into one read', h.reads.length === 1)
  }

  // The minimum gap holds even if spends arrive back to back.
  {
    const h = harness()
    h.scheduler.onSpend()
    h.advance(BALANCE_SETTLE_MS)
    h.scheduler.onSpend()
    h.advance(BALANCE_SETTLE_MS)
    check('a second read waits out the minimum gap', h.reads.length === 1)
    h.advance(BALANCE_MIN_GAP_MS - BALANCE_SETTLE_MS)
    check('the second read lands exactly at the gap', h.reads.length === 2)
  }

  // The reported symptom: an unchanged total right after spending must be
  // retried while the provider settles, not deferred to the idle poll.
  {
    const h = harness()
    h.scheduler.onSpend()
    h.advance(BALANCE_SETTLE_MS)
    let followUps = 0
    check('an unchanged total asks for a follow-up', h.scheduler.onSettled(false) === true)
    followUps += 1
    for (let attempt = 0; attempt < BALANCE_RETRY_BUDGET + 2; attempt += 1) {
      h.advance(BALANCE_RETRY_MS)
      if (h.scheduler.onSettled(false)) followUps += 1
    }
    check('the retry budget is bounded', followUps === BALANCE_RETRY_BUDGET)
    check('a changed total stops the retries', h.scheduler.onSettled(true) === false)
    const settledCount = h.reads.length
    h.advance(120000)
    check('no further reads once the total moves', h.reads.length === settledCount)
  }

  // A long turn must not turn into a read storm.
  {
    const h = harness()
    for (let step = 0; step < 40; step += 1) {
      h.scheduler.onSpend()
      h.advance(1000)
      h.scheduler.onSettled(false)
    }
    const worstCaseGap = h.reads.slice(1).reduce((worst, read, index) => Math.max(worst, read.at - h.reads[index].at), 0)
    check('a 40-step turn stays under the minimum gap', h.reads.length <= Math.ceil((40 * 1000) / BALANCE_MIN_GAP_MS) + 2)
    check('no two reads are closer than the minimum gap', worstCaseGap === 0 || h.reads.slice(1).every((read, index) => read.at - h.reads[index].at >= BALANCE_MIN_GAP_MS))
  }

  // The idle floor never forces, and the manual gesture always reads at once.
  {
    const h = harness()
    h.scheduler.onIdle()
    h.advance(0)
    check('the idle floor reads without forcing', h.reads.length === 1 && h.reads[0].force === false)
    h.scheduler.onSpend()
    h.scheduler.onManual()
    check('a manual refresh reads immediately, not after the settle delay', h.reads.length === 2 && h.reads[1].force === true)
    h.advance(1000)
    check('a manual refresh cancels the pending spend-driven read', h.reads.length === 2)
  }
}

// ── drag clamping ───────────────────────────────────────────────────────────
// The reported bug: dragging the panel upward pushed its top edge out of the
// viewport, where the header could no longer be grabbed. The offset alone was
// clamped, without accounting for the panel's own height.
{
  const { clampOffsets, EDGE } = exports.internals
  const viewport = { width: 1440, height: 890 }
  const panel = { width: 296, height: 600 }

  const top = clampOffsets({ right: 16, bottom: 900 }, panel, viewport)
  check('dragging upward cannot push the top edge off-screen', viewport.height - top.bottom - panel.height >= EDGE)
  check('the clamped bottom leaves exactly the minimum gap', top.bottom === viewport.height - panel.height - EDGE)

  const offRight = clampOffsets({ right: 5000, bottom: 16 }, panel, viewport)
  check('dragging right cannot push the right edge off-screen', viewport.width - offRight.right - panel.width >= EDGE)

  const negative = clampOffsets({ right: -80, bottom: -80 }, panel, viewport)
  check('a negative offset is pulled back to the margin', negative.right === EDGE && negative.bottom === EDGE)

  check('a reachable position is left untouched', clampOffsets({ right: 16, bottom: 96 }, panel, viewport).bottom === 96)

  // A panel taller than the viewport must still yield a usable offset rather
  // than a negative one; the stylesheet caps the height so this stays reachable.
  const oversized = clampOffsets({ right: 16, bottom: 900 }, { width: 296, height: 2000 }, viewport)
  check('a panel taller than the viewport yields the margin, not a negative offset', oversized.bottom === EDGE)

  // A position stored on a large window, restored on a small one.
  const stored = { right: 1200, bottom: 700 }
  const smallViewport = { width: 800, height: 700 }
  const small = clampOffsets(stored, panel, smallViewport)
  check('a stored position is re-clamped into a smaller viewport', small.right <= smallViewport.width - panel.width - EDGE && small.bottom <= smallViewport.height - panel.height - EDGE)
  check('re-clamping is idempotent', (() => {
    const twice = clampOffsets(small, panel, smallViewport)
    return small.right === twice.right && small.bottom === twice.bottom
  })())

  // Whatever is asked for, the panel must end up wholly on screen.
  const fits = (candidate) => {
    const clamped = clampOffsets(candidate, panel, viewport)
    return clamped.right + panel.width <= viewport.width && clamped.bottom + panel.height <= viewport.height && clamped.right >= 0 && clamped.bottom >= 0
  }
  check('every clamped offset keeps the panel on screen', [{ right: 0, bottom: 0 }, { right: 9999, bottom: 9999 }, { right: 16, bottom: 96 }, { right: -5, bottom: 2000 }].every(fits))
}

// ── assertions ──────────────────────────────────────────────────────────────
const checks = [
  ...cadenceChecks,
  ['loading shows the placeholder', loading.includes('查询中')],
  ['ok balance renders the amount', done.includes('¥110.00')],
  ['ok balance renders the source', done.includes('来自环境变量')],
  ['ok balance renders granted and topped-up', done.includes('赠送额度') && done.includes('充值余额')],
  ['context shows the percentage', done.includes('23%')],
  ['context shows used / window', done.includes('234k / 1M')],
  ['breakdown rows are present', done.includes('系统提示') && done.includes('工具定义') && done.includes('对话消息')],
  ['cache hit rate is computed', done.includes('99.5%')],
  ['token total is formatted', done.includes('285k')],
  ['token buckets are present', done.includes('缓存命中读取') && done.includes('缓存写入')],

  // cost — the figure the user asked for
  ['cost section renders', done.includes('预估费用')],
  [`off-peak flash cost is ${money(expectOffPeakFlash)}`, done.includes(money(expectOffPeakFlash))],
  [`peak flash cost is ${money(expectPeakFlash)} (exactly 2×)`, peak.includes(money(expectPeakFlash))],
  ['peak and off-peak differ', money(expectPeakFlash) !== money(expectOffPeakFlash)],
  [`pro rates are used for the pro model (${money(expectOffPeakPro)})`, proModel.includes(money(expectOffPeakPro))],
  ['the pro model is named as the rate source', proModel.includes('按 deepseek-v4-pro 单价')],
  ['an unknown model falls back to the default row', unknownModel.includes('（默认）') && unknownModel.includes(money(expectOffPeakFlash))],
  ['the billing window is labelled', done.includes('空闲计价') && peak.includes('高峰计价')],
  ['the rates are shown for sanity-checking', done.includes('命中 0.02 · 未命中 1 · 输出 4 元/百万')],
  ['the cost section is marked an estimate', done.includes('非账单金额')],
  ['missing pricing degrades to 暂无单价', noPricing.includes('暂无单价') && noPricing.includes('计价时段未知')],
  ['an incomplete rate set warns instead of silently understating', incomplete.includes('部分单价未配置')],
  ['an incomplete rate set never prints "undefined"', !incomplete.includes('undefined')],

  ['session stats are present', done.includes('3 轮 · 12 步')],
  ['missing credential is named', renderBranch('expanded · no credential', [undefined, { phase: 'done', at: Date.now(), payload: { ok: false, code: 'NO_CREDENTIAL', message: 'no credential for DEEPSEEK_API_KEY' } }, { phase: 'done', payload: pricingPayload('offPeak') }]).includes('无可用密钥')],
  ['http failure surfaces the message and provenance', renderBranch('expanded · http 401', [undefined, { phase: 'done', at: Date.now(), payload: { ok: false, code: 'HTTP_401', message: 'Authentication Fails', keySource: 'file' } }, { phase: 'done', payload: pricingPayload('offPeak') }]).includes('Authentication Fails')],
  ['absent projections degrade quietly', emptySession.includes('暂无数据') && emptySession.includes('—')],
  ['an absent usage sample reads "—", not "no rates"', emptySession.includes('预估费用 —') && !emptySession.includes('预估费用 暂无单价')],
  ['a priced session with no spend yet costs ¥0.0000', zeroUsage.includes('预估费用 ¥0.0000')],
  ['collapsed pill summarises every figure', collapsed.includes('余额') && collapsed.includes('费用') && collapsed.includes('命中') && collapsed.includes('上下文') && collapsed.includes('Token')],
  ['pill shows the balance', collapsed.includes('¥110.00')],
  ['pill shows the cost', collapsed.includes(money(expectOffPeakFlash))],

  // The regime split
  ['the host split overrides the local estimate', splitPricing.includes('预估费用 ¥0.3096') && !splitPricing.includes(money(expectOffPeakFlash))],
  ['the split names both regimes and their spend', splitPricing.includes('高峰 ¥0.2448') && splitPricing.includes('空闲 ¥0.0648')],
  ['the split buckets come from the projection', splitPricing.includes('缓存命中读 ¥0.0068') && splitPricing.includes('输出 ¥0.3012')],
  ['the split states its basis', splitPricing.includes('按各请求实际消耗时段分档计价')],
  ['the split does not claim the whole-session basis', !splitPricing.includes('按当前计价时段估算')],
  ['the split names the model it was priced at', splitPricing.includes('按 deepseek-flash 单价')],
  ['a split figure survives without the price table', splitNoRates.includes('预估费用 ¥0.3096')],
  ['an unpriced model warns', splitUnpriced.includes('部分单价未配置')],
  ['an unpriced model still reports its tokens', splitUnpriced.includes('按 acme-large 单价')],
  ['an empty split falls back to the local estimate', splitEmpty.includes(money(expectOffPeakFlash)) && !splitEmpty.includes('高峰 ¥')],
]

let failed = 0
console.log('\n── assertions ──')
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

console.log(`\nlocale keys defined: ${zhKeys.length}; keys exercised by these renders: ${asked.size}`)
const unused = zhKeys.filter((key) => !asked.has(key))
if (unused.length > 0) console.log(`note: keys defined but not exercised here: ${unused.join(', ')}`)
const missing = [...asked].filter((key) => !zhKeys.includes(key))
if (missing.length > 0) {
  failed += 1
  console.log(`FAIL  undefined keys requested: ${missing.join(', ')}`)
}

console.log(`\nstyle tags injected: ${styleTags.length}`)
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall assertions passed')
}

# dsh-usage-hud

A DeepSeek Harness Web GUI plugin: one floating panel that shows, live, what the
session is costing you.

![the panel in the Web GUI](docs/screenshot.png)

| Figure | Meaning | Source |
|---|---|---|
| **API 余额** (balance) | Account balance, its currency, granted vs. topped-up split | Host route `GET /api/usage-hud/balance` → the provider's `/user/balance` |
| **预估费用** (estimated cost) | What the session's tokens cost in CNY, split by token bucket **and by billing window** | The host's `usageCost` session projection |
| **缓存命中率** (cache hit rate) | `cacheRead / (cacheRead + uncachedInput + cacheWrite)` over the whole log | `tokenUsage` session projection |
| **上下文占用** (context occupancy) | Used / window plus a per-part composition bar | `contextPressure` + `contextBreakdown` projections |
| **Token 消耗** | Uncached input, output, cache read, cache write, and their total | `tokenUsage` session projection |
| 轮次 / 步骤 / 模型耗时 | Turns, steps, and model wall time | `sessionStats` session projection |

The panel starts in the **top-right** corner and floats above the app's own
chrome. Both the position and the collapsed state persist in `localStorage`
under `dsh.usage-hud.v1`.

**Two ways to drag it.** Expanded, the panel is dragged by its header — a press
on one of the header's own buttons still works as a button. Collapsed, the pill
is its own handle, which means one gesture does two jobs: a press that travels
more than a few pixels repositions it, and a press released in place expands it.
The two are told apart by pointer travel, so ending a drag never also toggles
the panel.

Placement is constrained against the viewport, not just against the offset: a
clamp that only bounded the stored offset let a tall panel's top edge leave the
screen when dragged upward, which put the drag handle out of reach and made the
panel impossible to bring back. The clamp now uses the layer's measured size, so
every edge stays inside the window, and it re-applies on window resize, on
collapse/expand, and via a `ResizeObserver` as the panel's own height changes.
The bound is a bound and not a lock — dragging back down works.

Cost figures print at a fixed four decimals, total and parts alike, so the
breakdown visibly adds up to the headline instead of drifting by a cent where
two-decimal rounding used to kick in.

## How the cost adapts

Three questions decide whether a cost figure is worth showing, and the plugin
answers all three from the log rather than from assumptions.

**Does it follow the billing rules?** Rates, the peak/off-peak windows, the
timezone, and the working days are all host configuration
(`config.pricing`, `config.peakHours`), merged onto a built-in snapshot of
DeepSeek's published table. A price change is one loader-row edit; the table is
never compiled into the browser bundle. What is *not* configurable is the shape
of the formula — four token buckets times a rate — so a genuinely new billing
dimension (tiered context pricing, per-request fees, batch discounts) would need
code.

**Is peak and off-peak computed separately?** Yes — per request, not per
session. `usageCost` is a pure fold over committed session events: every
provider usage sample is classified by the window in force **at the instant
that sample was consumed**, so a session that straddles the boundary is priced
on both sides of it, and the panel prints the split (`高峰 ¥… · 空闲 ¥…`).
Doing this required a new projection rather than arithmetic on `tokenUsage`,
because `tokenUsage` is a whole-log aggregate carrying neither timestamps nor
model attribution — from it alone the peak/off-peak split is not merely
approximate, it is unknowable.

**Does it follow a model change?** Yes. Each sample is attributed to the model
of the request header in force when it was produced, so a session that switches
models mid-way is priced per route, with each model's own rates; the panel lists
the models it used. A model the table does not know is reported as such
(`部分单价未配置`) rather than silently priced at zero.

The client keeps a fallback for compositions without the projection registry:
it prices the whole session at the current window and says
`按当前计价时段估算` instead, so a degraded panel never masquerades as an exact
one.

## Keeping the balance in step with the cost

Spending is what makes a balance stale, so spending is what triggers the next
read. A rising cost marks the figure on screen out of date — the balance drops
to secondary styling and says `费用已增加，正在重新查询余额` — and schedules a
forced upstream read once the burst settles. The policy is deliberately bounded:

| Rule | Value | Why |
|---|---|---|
| Settle delay | 3 s | a turn reports usage many times; coalesce the burst |
| Minimum gap | 15 s | never hammer the provider |
| Follow-up reads | 3 × 20 s | the provider settles its own books slowly (measured: ~50–70 s), so one read right after a turn often predates the charge |
| Idle floor | 60 s | a cached read when nothing was spent |

Because the read is scheduled off the cost, the panel converges on the charge
soon after a turn instead of waiting out the poll period. The `数据时间` row
always shows how old the reading actually is — the honest number when the
provider itself lags.

## Why two halves

The plugin is deliberately split along the one boundary that matters.

**The browser half** (`lib/client.js`) folds every token, context, cache, and
step figure **locally** from the Session Controller's own projections. Nothing
about token accounting touches the host: no RPC, no duplicated fold, no second
source of truth. When a projection is absent — a brand-new session, or a
composition without `dsh-token-meter` — the panel degrades to `暂无数据` / `—`
instead of inventing a number.

**The host half** (`lib/index.js`) owns exactly the one capability the browser
cannot have: reading the provider API credential, which never leaves the
process, and calling the provider with it. It resolves that credential through
the *same* seam `dsh-llm-deepseek` uses —

```text
ctx.credentials.resolve(apiKeyEnv)        # inherited env > $DSH_HOME/.credentials.yaml > .env
  ↓ when the service is absent
process.env[apiKeyEnv]
```

— so whatever key the running model calls already use is the key the panel
reports on. It then exposes two read-only routes. The host half has **no npm
dependencies at all** (node builtins and globals only), which is what lets the
profile load it straight from a checkout path.

`apiKeyEnv` defaults to `DEEPSEEK_API_KEY`; the endpoint is
`config.baseURL` → `$DEEPSEEK_BASE_URL` → `https://api.deepseek.com`.

### Why the price table lives on the host

The harness has no text-token pricing of its own — `ctx.llm` exposes route
*image* pricing only — and the provider's API returns balances but not rates. So
the rates are configuration, served by the host rather than compiled into the
browser bundle: a deployment pointed at a gateway, or one that renegotiated a
rate, edits one loader row instead of shipping new JavaScript.

## Install

Installing needs no restart: the profile's patch layer
(`$DSH_HOME/profiles/web/cordis.patch.yml`) is hot-reloaded, and the launcher
registers that watcher itself.

**From a checkout path** (no package manager required — this is how it is
installed here). Merge `profile-patch.snippet.yml` into the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: usage-hud
      name: 'file:///D:/dsh的数据/plugins/dsh-usage-hud/lib/index.js?v=11'
```

Then **reload the browser page**: the shell composes `window.__DSH_BOOT__` once
at boot, so the browser roster only picks the row up on the next page load. The
browser *bundle* needs no attention at all — the host re-reads its bytes and
re-serves them under a content-addressed URL.

### Deploying a change to the host half

The Loader re-imports a row only when its `name`, `inject`, or `group` changes —
a config-only edit merely patches the live fiber — so the row's `name` carries a
build revision and bumping `?v=` is what deploys a host-side change.

Two things learned the hard way, both encoded in the code:

- **A reload can be silently dropped.** The profile patch watcher filters
  chokidar events by an exact path comparison, and an event reported in another
  form is discarded without a word. Writes with unchanged content are skipped by
  design, so retrying identical bytes achieves nothing.
- **A re-import can tear itself down.** Mounting the new instance before
  disposing the old one makes both register the same route paths, and
  `webServer.register` throws on a duplicate `(kind, path)`; the new `apply`
  aborts and the row is left unmounted. `index.js` therefore parks its teardown
  on a process-global symbol and retires the previous mount before registering,
  which makes a re-import safe in either order and a repeated teardown a no-op.

So the procedure is: bump `?v=`, save, then **verify** with
`GET /api/usage-hud/status` — never assume. That route reports the running
`revision`, the credential and pricing it resolved, and whether the cost
projection attached. If it still reports the old revision after a few attempts,
restart `dsh web`; the patch on disk is always the source of truth.

**As an installed package.** The manifest declares `dsh.bundle.patch`, so
`dsh plugin --profile web add <path>` appends the package to
`dsh.profile.bundles` and its own `cordis.patch.yml` supplies the row.

### Uninstall

Remove the `usage-hud` entry from the profile patch (a backup of the original
file sits next to it as `cordis.patch.yml.bak-usage-hud`), then reload the page.

## Configuration

The loader row accepts these optional keys:

```yaml
- insert:
    - id: usage-hud
      name: '.../lib/index.js?v=11'
      config:
        apiKeyEnv: DEEPSEEK_API_KEY   # credential reference to resolve
        baseURL: https://api.deepseek.com
        defaultModel: deepseek-flash  # row used before any request header is seen
        pricing:                      # merged onto the built-in table, field by field
          deepseek-flash:
            peak: { output: 8 }
        peakHours:                    # when the peak rate applies
          utcOffsetMinutes: 480
          weekdays: [1, 2, 3, 4, 5]
          windows: [['09:00', '12:00'], ['14:00', '18:00']]
```

`pricing` merges **field by field**, so restating one rate leaves the rest at
their defaults, and a model the built-in table does not know is added whole.
Rates are CNY per million tokens; `inputCached` prices cache hits,
`inputUncached` misses, and `inputCacheWrite` cache writes (zero on every
DeepSeek route, since its context cache is written automatically and not billed
separately). A malformed table or peak rule is rejected at load — a
misconfigured price silently shown as fact would be worse than a failure.

## Tests

```powershell
npm test                 # host route + every render branch, no browser needed
```

- `test/host-harness.mjs` — drives the routes through a stub context and a stub
  upstream: balance parsing, both failure classes, credential-resolution order,
  the response cache and its TTL, `refresh=1`, and the method / cross-site
  guards on each route. It asserts no payload carries the secret, and it pins
  nine billing-window boundaries (window opens/closes, the midday gap, both
  weekend days) against fixed instants so the peak rule cannot drift.
  It also folds the `usageCost` unit directly: window attribution, per-model
  rates across a mid-session model switch, replacement of a repeated sample, a
  retried attempt adding rather than replacing, re-attribution when a sample
  moves across the boundary, unpriced models, checkpoint validation, view
  memoization, and the state-version bump that discards checkpoints when the
  peak rule changes. Two checks are differential:
  - the fold's token totals are compared against **`dsh-token-meter`'s own
    projection** over a shared event list, so the cost cannot drift from the
    token figures printed beside it;
  - re-mounting while a previous instance is still mounted must succeed, which
    is the hot-reload failure described under Install.
- `test/render-harness.mjs` — loads the bundle exactly as
  `window.__ModuleLoader__` does and renders the component through a minimal
  React shim, covering the expanded panel in loading / ok / no-credential /
  HTTP-failure / no-projection / unpriced / partially-priced / split states and
  the collapsed pill. Cost expectations are computed independently in the
  harness, so the assertion is not the code under test; it also checks that the
  host split overrides the local estimate, that peak is exactly twice off-peak,
  that a model falls back to the default row, and that the `zh`/`en`
  dictionaries have identical key sets. The balance-refresh cadence is driven
  with a **fake clock** — settle-delay coalescing, the minimum gap, the bounded
  follow-up reads, the idle floor, and the manual override — since the React
  shim cannot run effects.

Live checks against a running GUI:

```powershell
node test/verify-install.mjs --cookie-file .cookie.json   # composes + serves + the routes
node test/browser-verify.mjs --cookie-file .cookie.json   # renders in real headless Edge
Remove-Item .cookie.json
```

`verify-install.mjs` also runs standalone (`node test/verify-install.mjs`) and
asserts the running server's boot graph contains the plugin row, that its combo
script serves *byte-identical* bundle bytes, and that the balance and pricing
routes answer with well-formed payloads. `browser-verify.mjs` drives real Edge
over CDP, opens a live session from the sidebar, checks that the cost rows are
scoped to the cost section and sum to the headline figure, asserts which of the
two pricing bases the panel actually used, and writes a screenshot. Both live
checkers need the browser-session cookie, which they mint from the operator's
own stored `client-connection/browser-session` secret; they never
print it, and the cookie file must be deleted afterwards.

## Trust boundary

All three routes are plain `webServer` exact routes, so they sit **outside** the
`/api` gateway's browser-session authentication. They are therefore reachable by
anything that can open a socket to the GUI's bind address. Four things contain
that:

- they return a balance figure, a rate table, a build revision, and credential
  *provenance* — never the key itself;
- every one refuses non-`GET`/`HEAD` methods and any request the browser marked
  as not same-origin (`Sec-Fetch-Site`), which blocks a third-party page from
  reading them;
- the server binds `127.0.0.1` by default in the shipped composition.

If you expose the GUI beyond loopback, put the routes behind your own
authentication or drop the balance section.

## Known limitations

- **The cost is an estimate, not a bill.** The window split is exact per
  request, but the *rates* are a snapshot of
  <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>, which is the
  authority; the panel says `非账单金额` for this reason.
- **Chinese public holidays are not modeled.** DeepSeek bills them off-peak; the
  built-in rule prices them as working days, so the estimate is conservative on
  those dates.
- **The balance is a floor, not a forecast.** It is the provider's figure as of
  the last successful read, and the provider only moves it every ~50–70 s
  (measured), so a turn in flight has spent money the panel cannot yet see. The
  `数据时间` row reports the reading's true age rather than hiding the lag.
- **Context and cache figures are estimates.** They come from `dsh-token-meter`,
  whose composition split is a heuristic (four characters per token), so
  `系统提示 + 工具定义 + 对话消息` will not sum exactly to the provider-anchored
  `已用` figure. Treat occupancy as a reference, not a billing record.
- **A new billing dimension needs code.** Rates and windows are configuration,
  but the formula is fixed at four token buckets times a rate.
- **The window at consumption time is derived from the event's own timestamp**,
  so a machine whose clock is wrong, or a log replayed long after the fact,
  would attribute windows against that clock.
- **Only DeepSeek's official endpoint is understood for balances.**
  `/user/balance` is a DeepSeek API shape; a pi-ai gateway route has no
  equivalent, so the balance section reports `查询失败` with the upstream
  message. Pricing still works there if you configure it.
- **The panel mounts only in a session view.** It registers into
  `conversation.input.overlay`, so the blank shell with no session shows nothing.

## Worked example

From the screenshot above, on a 217-step session at 99.6% cache hit rate:

```text
47.5M cache-hit input   × ¥0.02 / M  = ¥0.9495
197.1k uncached input   × ¥1    / M  = ¥0.1971
174.5k output           × ¥4    / M  = ¥0.6980
                                       ────────
                                       ¥1.8446
```

The panel matters here: 47.5M cached tokens cost less than 175k output tokens,
because DeepSeek's cache-hit rate is **1/200th** of its output rate. A
cache hit rate that looks like a success metric is also, at this ratio, the
only reason the bill is a rounding error rather than ¥95.

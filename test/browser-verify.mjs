/**
 * Real-browser verification of the usage HUD.
 *
 * Launches headless Edge with a workspace-private profile, attaches over the
 * Chrome DevTools Protocol, installs the minted browser-session cookie, loads
 * the GUI, waits for the panel to mount, asserts the rendered text, and writes
 * a screenshot. This is the only check that exercises the actual DOM, the real
 * slot kit, and the real projection wiring.
 *
 * Usage:
 *   node test/verify-install.mjs --cookie-file <path>   # mint the session
 *   node test/browser-verify.mjs --cookie-file <path> [--out <png>]
 *   # then delete the cookie file
 *
 * Needs no npm dependency: Node's global `WebSocket` carries CDP, and Edge is
 * discovered from its standard install locations.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const cookieFile = option('--cookie-file')
if (cookieFile === undefined) throw new Error('--cookie-file <path> is required (mint one with verify-install.mjs --cookie-file)')
const origin = (option('--origin', 'http://127.0.0.1:3080')).replace(/\/+$/u, '')
const outPng = option('--out', join(process.cwd(), 'usage-hud.png'))
const port = Number(option('--port', '9377'))
const PLUGIN_ROOT = join(import.meta.dirname, '..')
const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-hud-edge-'))

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const browser = EDGE_CANDIDATES.find((candidate) => existsSync(candidate))
if (browser === undefined) throw new Error('no Edge or Chrome installation found')

const checks = []
const check = (label, ok) => checks.push([label, ok === true])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll the CDP HTTP endpoint until the browser target is up. */
async function browserSocketUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      const info = await response.json()
      if (typeof info.webSocketDebuggerUrl === 'string') return info.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error(`the browser never exposed a CDP endpoint on port ${port}`)
}

/** Minimal CDP client over the browser-level websocket. */
function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  const events = []
  let nextId = 0

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('CDP websocket failed')))
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
      return
    }
    events.push(message)
  })

  /**
   * Send one CDP command.
   * @param method - CDP method name.
   * @param params - method parameters.
   * @param sessionId - optional flattened session.
   * @returns the command result.
   */
  const send = (method, params = {}, sessionId) => {
    const id = (nextId += 1)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  return { ready, send, close: () => socket.close() }
}

const child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1500,950',
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${port}`,
  // The browser is a child of a sandboxed shell, so its own OS sandbox cannot
  // be established; its output goes to files because piped stdio is denied here.
  '--no-sandbox',
  'about:blank',
], {
  stdio: ['ignore', openSync(`${outPng}.edge-out.log`, 'w'), openSync(`${outPng}.edge-err.log`, 'w')],
  detached: false,
})

/** Print the browser's own diagnostics when it fails to come up. */
function reportBrowserLog() {
  for (const suffix of ['edge-err.log', 'edge-out.log']) {
    const path = `${outPng}.${suffix}`
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8').trim()
    if (text.length === 0) continue
    console.error(`\n${suffix}:\n${text.split('\n').slice(-25).join('\n')}`)
  }
}

let client
try {
  try {
    client = connect(await browserSocketUrl())
  } catch (error) {
    reportBrowserLog()
    throw error
  }
  await client.ready
  check('attached to the browser over CDP', true)

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
  check('opened a page target', typeof sessionId === 'string')

  await client.send('Network.enable', {}, sessionId)
  await client.send('Page.enable', {}, sessionId)
  await client.send('Runtime.enable', {}, sessionId)

  const cookie = JSON.parse(readFileSync(cookieFile, 'utf8'))
  const host = new URL(origin).hostname
  await client.send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    domain: host,
    path: '/',
    httpOnly: false,
    sameSite: 'Strict',
  }, sessionId)
  check(`installed the browser-session cookie for ${host}`, true)

  const failures = []
  await client.send('Page.navigate', { url: `${origin}/` }, sessionId)
  await sleep(1000)

  // Wait for the shell to boot the plugin tree and mount the panel.
  let mounted = false
  let lastText = ''
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const host = document.querySelector('[data-dsh-usage-hud]');
        const pill = document.querySelector('.dshUh_pill');
        const panel = document.querySelector('.dshUh_panel');
        const node = panel ?? pill;
        return JSON.stringify({
          host: host !== null,
          pill: pill !== null,
          panel: panel !== null,
          text: node === null ? '' : node.innerText.replace(/\\s+/g, ' ').trim(),
          balance: (() => { const dd = document.querySelectorAll('.dshUh_row dd'); return dd.length > 0 ? dd[0].innerText : '' })(),
        });
      })()`,
      returnByValue: true,
    }, sessionId)
    const state = JSON.parse(probe.result.value)
    lastText = state.text
    if (state.host && (state.pill || state.panel)) {
      mounted = true
      break
    }
    if (attempt === 8 || attempt === 25) {
      // Nudge: a blank shell only opens the side panel once a session exists;
      // record console/page errors so a failure is diagnosable.
      const errs = await client.send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__dshHudErrors ?? [])', returnByValue: true }, sessionId)
      failures.push(errs.result.value)
    }
    await sleep(500)
  }

  check('the portal host is attached to document.body', mounted)
  check('the panel rendered text', lastText.length > 0)
  console.log(`\nrendered text:\n  ${lastText}`)

  // Best effort: open a session that already has usage, so the cost row shows a
  // real figure rather than the blank shell's zero. A fresh browser has no
  // session id, so this clicks the sidebar's first conversation entry.
  // Best effort: open a session that already has usage, so the cost row shows a
  // real figure rather than the blank shell's zero. A fresh browser carries no
  // session id and the SPA has no deep link, so this drives the sidebar: click
  // once to expand the workspace, then click the first conversation row.
  const sidebarScript = `(() => {
    return [...document.querySelectorAll('a, button, li, [role="button"], [role="option"], [role="treeitem"]')]
      .map((el) => ({ el, text: (el.innerText || '').trim(), box: el.getBoundingClientRect() }))
      .filter(({ text, box }) => box.x < 320 && box.width > 100 && box.height >= 16 && box.height <= 48 && box.top > 40 && text.length > 1 && text.length < 48)
      .filter(({ text }) => !/新会话|New session|^工作区|^Workspace|^设置$|^Settings$/.test(text));
  })()`
  const readSidebar = async () => {
    const probe = await client.send('Runtime.evaluate', { expression: `${sidebarScript}.map(({ text, box }) => text + '@' + Math.round(box.top)).join(' | ')`, returnByValue: true }, sessionId)
    return probe.result.value
  }
  // The session list arrives over the API after the shell boots, so poll for it
  // rather than assuming the sidebar is populated the moment the HUD mounts.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const rows = await readSidebar()
    if (rows.includes('|')) break
    await sleep(1000)
  }
  console.log(`\nsidebar rows: ${await readSidebar()}`)
  const opened = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const rows = ${sidebarScript};
      // The workspace row carries a directory path; a conversation row does not.
      const isPath = (text) => /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\\\');
      const target = rows.find(({ text }) => !isPath(text)) ?? rows[0];
      if (target === undefined) return 'none';
      target.el.click();
      return target.text;
    })()`,
    returnByValue: true,
  }, sessionId)
  console.log(`sidebar session opened: ${opened.result.value}`)
  if (opened.result.value !== 'none') await sleep(6000)

  check('the collapsed or expanded panel shows the balance label', /API 余额|余额/.test(lastText))
  check('the panel shows a cache hit rate', /命中率|命中/.test(lastText))

  // Expand so the screenshot shows the full panel.
  await client.send('Runtime.evaluate', {
    expression: `(() => { const pill = document.querySelector('.dshUh_pill'); if (pill !== null) pill.click(); return true })()`,
    returnByValue: true,
  }, sessionId)
  await sleep(1200)

  const expanded = await client.send('Runtime.evaluate', {
    expression: `(() => { const panel = document.querySelector('.dshUh_panel'); return panel === null ? '' : panel.innerText.replace(/\\s+/g, ' ').trim() })()`,
    returnByValue: true,
  }, sessionId)
  const expandedText = expanded.result.value
  console.log(`\nexpanded text:\n  ${expandedText}`)

  // Drag the panel as far up and right as a real pointer can go, then drag it
  // back down. Driven through CDP input rather than synthetic DOM events so the
  // browser generates the pointer sequence itself. The reported failure was the
  // header ending up off-screen, where it could no longer be grabbed.
  /** Read the panel rect and a grabbable point on its header. */
  const readPanel = async () => JSON.parse((await client.send('Runtime.evaluate', {
    expression: `(() => {
      const panel = document.querySelector('.dshUh_panel');
      const head = document.querySelector('.dshUh_head');
      if (panel === null || head === null) return 'null';
      const box = panel.getBoundingClientRect();
      const grip = head.getBoundingClientRect();
      return JSON.stringify({
        grip: { x: Math.round(grip.left + 40), y: Math.round(grip.top + grip.height / 2) },
        rect: { top: Math.round(box.top), left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(box.bottom), height: Math.round(box.height) },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
    })()`,
    returnByValue: true,
  }, sessionId)).result.value)
  /** Drag from the header by a delta, in steps, as a real pointer would. */
  const dragBy = async (from, dx, dy) => {
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.grip.x, y: from.grip.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, sessionId)
    for (const step of [0.25, 0.5, 0.75, 1]) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.grip.x + dx * step), y: Math.round(from.grip.y + dy * step), button: 'left', buttons: 1, pointerType: 'mouse' }, sessionId)
      await sleep(60)
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.grip.x + dx, y: from.grip.y + dy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }, sessionId)
    await sleep(400)
  }

  const start = await readPanel()
  if (start === null) {
    check('the panel was found for the drag test', false)
  } else {
    await dragBy(start, 800, -4000)
    const clamped = await readPanel()
    console.log(`\ndrag up-right: ${JSON.stringify(start.rect)} -> ${JSON.stringify(clamped.rect)} in ${JSON.stringify(start.viewport)}`)
    check('a drag to the top leaves the header on screen', clamped.rect.top >= 0)
    check('a drag cannot push the panel past the left edge', clamped.rect.left >= 0)
    check('a drag cannot push the panel past the right edge', clamped.rect.right <= clamped.viewport.width)
    check('a drag cannot push the panel past the bottom edge', clamped.rect.bottom <= clamped.viewport.height)
    check('the panel was dragged to the top', clamped.rect.top <= start.rect.top)

    // The clamp must be a bound, not a lock: dragging back down has to work.
    await dragBy(clamped, -40, 220)
    const moved = await readPanel()
    console.log(`drag down: ${JSON.stringify(clamped.rect)} -> ${JSON.stringify(moved.rect)}`)
    check('dragging back down moves the panel', moved.rect.top > clamped.rect.top + 100)
    check('the panel stays on screen after dragging down', moved.rect.bottom <= moved.viewport.height && moved.rect.top >= 0)
  }
  await sleep(300)

  // Collapse the panel and exercise the pill: it is both the drag handle and the
  // expand control, so a drag must reposition it and a click must still expand.
  await client.send('Runtime.evaluate', {
    expression: `(() => { const buttons = document.querySelectorAll('.dshUh_head .dshUh_iconBtn'); if (buttons.length > 1) buttons[1].click(); return true })()`,
    returnByValue: true,
  }, sessionId)
  await sleep(600)

  const readPill = async () => JSON.parse((await client.send('Runtime.evaluate', {
    expression: `(() => {
      const pill = document.querySelector('.dshUh_pill');
      if (pill === null) return JSON.stringify({ found: false, panel: document.querySelector('.dshUh_panel') !== null });
      const box = pill.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        panel: document.querySelector('.dshUh_panel') !== null,
        grip: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
        rect: { top: Math.round(box.top), left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(box.bottom) },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
    })()`,
    returnByValue: true,
  }, sessionId)).result.value)
  /** Click in place, as a real pointer would: press and release, no travel. */
  const clickAt = async (x, y) => {
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, sessionId)
    await sleep(50)
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }, sessionId)
    await sleep(600)
  }

  const collapsed = await readPill()
  check('the panel collapses to a pill', collapsed.found && !collapsed.panel)
  if (collapsed.found) {
    // A drag on the pill must reposition it...
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: collapsed.grip.x, y: collapsed.grip.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, sessionId)
    for (const step of [0.25, 0.5, 0.75, 1]) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(collapsed.grip.x - 200 * step), y: Math.round(collapsed.grip.y - 300 * step), button: 'left', buttons: 1, pointerType: 'mouse' }, sessionId)
      await sleep(60)
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: collapsed.grip.x - 200, y: collapsed.grip.y - 300, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }, sessionId)
    await sleep(400)
    const draggedPill = await readPill()
    console.log(`\npill drag: ${JSON.stringify(collapsed.rect)} -> ${JSON.stringify(draggedPill.rect)}`)
    check('the collapsed pill can be dragged', draggedPill.rect.left !== collapsed.rect.left || draggedPill.rect.top !== collapsed.rect.top)
    check('dragging the pill does not expand the panel', !draggedPill.panel)
    check('the dragged pill stays on screen', draggedPill.rect.top >= 0 && draggedPill.rect.left >= 0 && draggedPill.rect.right <= draggedPill.viewport.width)

    // ...and a click in place must still expand it.
    await clickAt(draggedPill.grip.x, draggedPill.grip.y)
    const reexpanded = await readPill()
    console.log(`pill click -> expanded: ${reexpanded.panel === true}`)
    check('clicking the pill still expands the panel', reexpanded.panel)
  }
  await sleep(300)

  check('the expanded panel lists context occupancy', /上下文占用/.test(expandedText))
  check('the expanded panel lists token consumption', /Token 消耗/.test(expandedText))
  check('the expanded panel lists the cache hit rate', /缓存命中率/.test(expandedText))
  check('the expanded panel shows the balance section', /API 余额/.test(expandedText))
  check('the expanded panel shows a currency figure or a classified failure', /¥|\$|无可用密钥|查询失败/.test(expandedText))
  check('the expanded panel shows an estimated cost', /预估费用/.test(expandedText))
  check('the cost row names its rate source', /单价/.test(expandedText))
  check('the cost row labels what it was priced against', /高峰计价|空闲计价|高峰 ¥/.test(expandedText))
  check('the cost row is labelled an estimate, not a bill', /非账单金额/.test(expandedText))
  // Which basis the panel used. The host projection prices every request at the
  // window it was consumed in; the fallback applies one window to the whole
  // session and says so. The split is the behaviour under test.
  const usesSplit = /按各请求实际消耗时段分档计价/.test(expandedText)
  const usesFallback = /按当前计价时段估算/.test(expandedText)
  console.log(`\ncost basis: ${usesSplit ? 'per-request split (host projection)' : usesFallback ? 'whole-session estimate (fallback)' : 'unrecognised'}`)
  if (usesSplit) {
    const split = /高峰 (¥[\d.]+) · 空闲 (¥[\d.]+)/.exec(expandedText)
    console.log(`regime split: ${split === null ? 'not found' : `${split[1]} peak + ${split[2]} off-peak`}`)
    check('the split names both windows and their spend', split !== null)
  }
  check('the host regime split reached the browser', usesSplit)
  check('the whole-session fallback is not in use', !usesFallback)

  // When a real session is open, the cost must be positive and consistent with
  // the token counts the same panel shows. Rows are scoped to the cost section:
  // the token section has its own 输出 row, and a bare /^输出/ would match both.
  const cost = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const panel = document.querySelector('.dshUh_panel');
      if (panel === null) return JSON.stringify({ found: false });
      const sections = [...panel.querySelectorAll('.dshUh_section')];
      const costSection = sections.find((section) => ((section.querySelector('.dshUh_sectionTitle') || {}).innerText || '').trim().startsWith('预估费用'));
      const rows = costSection === undefined ? [] : [...costSection.querySelectorAll('.dshUh_row')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim());
      const head = [...panel.querySelectorAll('.dshUh_sectionHead')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim());
      return JSON.stringify({ found: true, rows, head, scoped: costSection !== undefined });
    })()`,
    returnByValue: true,
  }, sessionId)
  const readout = JSON.parse(cost.result.value)
  if (readout.found) {
    check('the cost rows were scoped to the cost section', readout.scoped === true)
    const costHead = readout.head.find((line) => line.startsWith('预估费用')) ?? ''
    const tokenHead = readout.head.find((line) => line.startsWith('Token 消耗')) ?? ''
    const parts = Object.fromEntries(
      readout.rows
        .filter((line) => /^缓存命中读|^未命中输入|^输出|^缓存写入/.test(line))
        .map((line) => [line.split(' ')[0], Number((/¥([\d.]+)/.exec(line) ?? [])[1] ?? 'NaN')]),
    )
    const costValue = Number((/¥([\d.]+)/.exec(costHead) ?? [])[1] ?? 'NaN')
    console.log(`\ncost readout:\n  ${costHead}\n  ${tokenHead}\n  ${JSON.stringify(parts)}`)
    if (Number.isFinite(costValue) && costValue > 0) {
      const partSum = Object.values(parts).reduce((carry, value) => carry + (Number.isFinite(value) ? value : 0), 0)
      check('an open session reports a positive cost', costValue > 0)
      // Every bucket is priced and the buckets account for the headline figure.
      check('all four token buckets are priced', Object.keys(parts).length === 4 && Object.values(parts).every((value) => Number.isFinite(value)))
      check(`the buckets sum to the headline figure (${partSum.toFixed(4)} vs ${costValue})`, Math.abs(partSum - costValue) <= 0.001)
      check('a cache-heavy session still spends something on output', parts['输出'] > 0)
    } else {
      console.log('  (blank session: no tokens yet, so the cost is legitimately zero)')
      check('a session with no usage reports zero cost', /预估费用 ¥0\.0000|预估费用 —/.test(costHead) || costHead === '')
    }
  }

  const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  writeFileSync(outPng, Buffer.from(shot.data, 'base64'))
  check('a screenshot was captured', existsSync(outPng))
  console.log(`\nscreenshot: ${outPng}`)

  const consoleErrors = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify((globalThis.__dshBootErrors ?? []).slice(0, 5))`,
    returnByValue: true,
  }, sessionId)
  if (consoleErrors.result.value !== '[]') console.log(`\nboot errors observed: ${consoleErrors.result.value}`)
} finally {
  client?.close()
  child.kill()
  await sleep(500)
  try {
    rmSync(PROFILE, { recursive: true, force: true })
  } catch {}
}

let failed = 0
console.log('\n── browser verification ──')
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nthe panel renders in a real browser')
}

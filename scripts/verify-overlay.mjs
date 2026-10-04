/**
 * Live-page verification for @dev_zf/dsh-conversation-search, driven the way a user
 * drives it.
 *
 * A blank Session in a fresh profile keeps its composer in the shell's inert
 * `hero` state, so CDP cannot type a message and let the model answer. Instead
 * this seeds message rows directly into the Session's REAL transcript scrollport
 * — the rows carry exactly the attributes `ui-chat` stamps on them — and then
 * exercises the plugin through its own UI:
 *
 *   - Ctrl+F opens the bar (the keyboard path),
 *   - the query is typed into the bar's own input (the real text pipeline),
 *   - the count, the painted marks and the containing ring are read back,
 *   - Enter walks the matches,
 *   - Escape closes and releases the overlay.
 *
 * Every assertion is about real browser behaviour: real `Range.getClientRects()`
 * geometry, real CSS, real scrolling, and the application frame's position.
 * The overlay must not move the page: that was a shipped regression.
 *
 * Usage: node scripts/verify-overlay.mjs <url-with-token> [query]
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromeBinary } from './dsh-paths.mjs'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/verify-overlay.mjs <url-with-token> [query]')
  process.exit(2)
}
const CHROME = chromeBinary()
const QUERY = process.argv[3] ?? 'owlbear'
const DUMP = process.env.DSH_OVERLAY_DUMP ?? ''

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.consoleErrors = []
    socket.addEventListener('message', event => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        return
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
        else entry.resolve(message.result)
        return
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '))
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception')
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
    }
    return result.result.value
  }

  async key(key, code, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` | ${detail}`}`)
}

const profileDir = await mkdtemp(join(tmpdir(), 'dsh-overlay-chrome-'))
const port = 9700 + Math.floor(Math.random() * 200)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })

let cdp
try {
  let targets = null
  for (let attempt = 0; attempt < 80 && targets === null; attempt += 1) {
    try {
      targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
    } catch (error) {
      await sleep(250)
    }
  }
  const page = targets.find(target => target.type === 'page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('ws error')), { once: true })
  })
  cdp = new Cdp(socket)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  // A headless window has no system focus, so element focus and the shell's own
  // keyboard handling stay inert until the page is told it is focused.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await cdp.send('Page.navigate', { url })
  await sleep(5000)
  await cdp.evaluate(`
    window.focus()
    return { hasFocus: document.hasFocus() }`).then(value => console.log('FOCUS', JSON.stringify(value)))

  const ready = await cdp.evaluate(`
    return { boot: typeof globalThis.__DSH_BOOT__ !== 'undefined', handle: typeof globalThis.dshConversationSearch }`)
  check('page boots and the plugin publishes its handle', ready.boot === true && ready.handle === 'object', JSON.stringify(ready))

  // ---- seed rows into the Session's REAL transcript -----------------------
  // The shipped hierarchy is mirrored deliberately:
  //   [data-conversation-content] → [data-conversation-scroll] → [views, composerSeat]
  // A full-width envelope or the composer becoming a search block is the
  // regression under test, so the fixture contains both as siblings.
  const seeded = await cdp.evaluate(`
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (scroller === null) return { seeded: false, reason: 'no transcript scrollport' }
    const oldViews = scroller.querySelector('[data-e2e-views]')
    if (oldViews !== null) oldViews.remove()
    const oldComposer = scroller.querySelector('[data-e2e-composer]')
    if (oldComposer !== null) oldComposer.remove()
    const column = document.createElement('div')
    column.setAttribute('data-e2e-views', '')
    // Content well past the viewport so a jump can centre without the browser
    // clamping the scroll at the end of the transcript.
    column.style.cssText = 'display:block;padding:8px 8px 700px'
    const kinds = ['user', 'assistant-step', 'user', 'assistant-step']
    const texts = [
      'first seeded row without the word',
      'second seeded row: an owlbear appears here, and one more owlbear after it',
      'third seeded row: another owlbear mention',
      'fourth seeded row: nothing to see',
    ]
    for (let index = 0; index < kinds.length; index += 1) {
      const row = document.createElement('div')
      row.setAttribute('data-chat-flow-kind', kinds[index])
      row.setAttribute('data-chat-anchor-key', 'e2e-' + index)
      row.setAttribute('data-chat-turn', String(index + 1))
      row.style.cssText = 'min-height:200px;padding:10px'
      row.textContent = texts[index]
      column.appendChild(row)
    }
    // A composer stub with realistic geometry: in the shipped shell the composer
    // stays visible at the bottom of the scrollport, and the jump math measures
    // the usable area from this seat's top edge.
    const composerHint = document.createElement('div')
    composerHint.setAttribute('data-e2e-composer', '')
    composerHint.setAttribute('data-conversation-region', 'composer')
    composerHint.style.cssText = 'position:sticky;bottom:0;padding:8px;background:#fff'
    composerHint.textContent = 'composer hint: 中间产物 占位'
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    seat.style.cssText = 'box-sizing:border-box;height:180px;margin:8px;border:1px solid #ccc;background:#f6f6f6'
    seat.textContent = 'composer seat placeholder'
    composerHint.appendChild(seat)
    scroller.appendChild(column)
    scroller.appendChild(composerHint)
    scroller.scrollTop = 0
    const envelope = scroller.closest('[data-conversation-content]')
    const frame = document.getElementById('root')
    return {
      seeded: true,
      rows: column.querySelectorAll('[data-chat-flow-kind]').length,
      hasEnvelope: envelope !== null,
      envelopeRegion: envelope === null ? null : envelope.getAttribute('data-conversation-region'),
      scrollerClass: String(scroller.className).slice(0, 40),
      frameTopBefore: Math.round(frame.getBoundingClientRect().top),
      frameHeightBefore: Math.round(frame.getBoundingClientRect().height),
      docScrollTopBefore: document.scrollingElement.scrollTop,
    }`)
  check('message rows seeded into the real transcript', seeded.seeded === true && seeded.rows === 4, JSON.stringify(seeded))
  check('the fixture mirrors the shipped envelope hierarchy', seeded.hasEnvelope === true, JSON.stringify(seeded))

  // The composer text must never enter the index, or one match paints across the
  // whole session body — the regression this fixture exists to catch.
  const indexScope = await cdp.evaluate(`
    const engine = globalThis.dshConversationSearch.engine
    engine.attachScrollport(document.querySelector('[data-conversation-scroll]'))
    const hits = await engine.search('中间产物', false)
    const blocks = engine.blocks()
    return {
      hits,
      leaked: blocks.filter(block => block.text.includes('中间产物')),
      envelopeBlocks: blocks.filter(block => block.envelope).length,
      composerBlocks: blocks.filter(block => block.composer).length,
      blockCount: blocks.length,
      kinds: blocks.map(block => block.kind),
    }`)
  console.log('INDEX-SCOPE', JSON.stringify(indexScope))
  check('composer text stays out of the index', indexScope.hits === 0 && indexScope.leaked.length === 0, JSON.stringify(indexScope))
  check('neither the envelope nor the composer becomes a search block',
    indexScope.envelopeBlocks === 0 && indexScope.composerBlocks === 0, JSON.stringify(indexScope))

  // ---- drive the plugin through its UI ------------------------------------
  await cdp.key('f', 'KeyF', 2 /* Ctrl */)
  await sleep(600)
  let focused = { input: false, focused: false }
  for (let attempt = 0; attempt < 10 && focused.focused !== true; attempt += 1) {
    focused = await cdp.evaluate(`
      const barNode = document.querySelector('[data-dsh-conversation-search-bar]')
      const input = barNode === null ? null : barNode.querySelector('input')
      if (!(input instanceof HTMLElement)) return { input: false, focused: false }
      const box = input.getBoundingClientRect()
      return { input: true, focused: document.activeElement === input, box: { x: Math.round(box.left + 20), y: Math.round(box.top + box.height / 2), w: Math.round(box.width) }, docFocus: document.hasFocus() }`)
    if (focused.focused !== true && focused.box !== undefined) {
      // A real click gives focus the same way a user's click does.
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focused.box.x, y: focused.box.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focused.box.x, y: focused.box.y, button: 'left', clickCount: 1 })
    }
    if (focused.focused !== true) await sleep(300)
  }
  check('Ctrl+F opens the bar', focused.input === true, JSON.stringify(focused))

  // The bar's own focus timer runs after mount, so re-assert focus before typing.
  // If the headless window still refuses element focus, set the field the way a
  // user's typing would land: value plus a bubbling `input` event for React.
  const typed = await cdp.evaluate(`
    const input = document.querySelector('[data-dsh-conversation-search-bar] input')
    if (!(input instanceof HTMLElement)) return { typed: false, reason: 'no input' }
    input.focus()
    if (document.activeElement === input) return { typed: true, via: 'focus' }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(QUERY)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return { typed: true, via: 'input-event' }`)
  if (typed.via === 'focus') await cdp.send('Input.insertText', { text: QUERY })
  await sleep(1400)

  // A first Ctrl+F may arrive before the dock exists; retry through the chip.
  let result = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await cdp.evaluate(`
      const barNode = document.querySelector('[data-dsh-conversation-search-bar]')
      const status = barNode === null ? null : barNode.querySelector('[role="status"]')
      const layer = document.querySelector('[data-dsh-conversation-search-layer]')
      const marks = layer === null ? [] : [...layer.children].filter(node => node.hasAttribute('data-dsh-conversation-search-mark'))
      const rings = layer === null ? [] : [...layer.children].filter(node => node.hasAttribute('data-dsh-conversation-search-ring'))
      const rect = node => { const box = node.getBoundingClientRect(); return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) } }
      const frame = document.getElementById('root')
      const scroller = document.querySelector('[data-conversation-scroll]')
      const table = globalThis.dshConversationSearch
      let diagnostics = null
      if (table !== null && table !== undefined && typeof table.diagnose === 'function') {
        try { diagnostics = table.diagnose() } catch (error) { diagnostics = String(error) }
      }
      return {
        count: status === null ? null : status.textContent,
        marks: marks.length,
        activeMarks: marks.filter(node => node.getAttribute('data-active') === 'true').length,
        markRects: marks.map(rect),
        markBackgrounds: marks.map(node => getComputedStyle(node).backgroundColor),
        markPositions: marks.map(node => getComputedStyle(node).position),
        rings: rings.length,
        ringRects: rings.map(rect),
        diagnostics,
        layerPosition: layer === null ? null : getComputedStyle(layer).position,
        layerPointerEvents: layer === null ? null : getComputedStyle(layer).pointerEvents,
        scrollerScrollTop: scroller === null ? null : scroller.scrollTop,
        frameTop: Math.round(frame.getBoundingClientRect().top),
        frameHeight: Math.round(frame.getBoundingClientRect().height),
        docScrollTop: document.scrollingElement.scrollTop,
        viewport: { width: innerWidth, height: innerHeight },
      }`)
    if (typeof result.count === 'string' && result.count.length > 0) break
    await cdp.evaluate(`
      const input = document.querySelector('[data-dsh-conversation-search-bar] input')
      if (input instanceof HTMLElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        setter.call(input, ${JSON.stringify(QUERY)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return true`)
    await sleep(1200)
  }
  // Centring runs with smooth scrolling, so wait for the animation to settle
  // before measuring what the reader actually ends up looking at.
  await sleep(1200)
  result = await cdp.evaluate(`
    const barNode = document.querySelector('[data-dsh-conversation-search-bar]')
    const status = barNode === null ? null : barNode.querySelector('[role="status"]')
    const layer = document.querySelector('[data-dsh-conversation-search-layer]')
    const marks = layer === null ? [] : [...layer.children].filter(node => node.hasAttribute('data-dsh-conversation-search-mark'))
    const rings = layer === null ? [] : [...layer.children].filter(node => node.hasAttribute('data-dsh-conversation-search-ring'))
    const rect = node => { const box = node.getBoundingClientRect(); return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) } }
    const scroll = document.querySelector('[data-conversation-scroll]')
    const scrollRect = scroll.getBoundingClientRect()
    const table = globalThis.dshConversationSearch
    let diagnostics = null
    if (table !== null && table !== undefined && typeof table.diagnose === 'function') {
      try { diagnostics = table.diagnose() } catch (error) { diagnostics = String(error) }
    }
    return {
      count: status === null ? null : status.textContent,
      marks: marks.length,
      activeMarks: marks.filter(node => node.getAttribute('data-active') === 'true').length,
      markRects: marks.map(rect),
      markBackgrounds: marks.map(node => getComputedStyle(node).backgroundColor),
      markPositions: marks.map(node => getComputedStyle(node).position),
      rings: rings.length,
      ringRects: rings.map(rect),
      diagnostics,
      scrollBand: { top: Math.round(scrollRect.top), bottom: Math.round(scrollRect.bottom) },
      activeRow: (() => {
        const marker = document.querySelector('[data-dsh-conversation-search]:not([data-dsh-conversation-search-layer]):not([data-dsh-conversation-search-bar]):not([data-dsh-conversation-search-mark]):not([data-dsh-conversation-search-ring]):not([data-dsh-conversation-search-spacer])')
        if (marker === null) return null
        const box = marker.getBoundingClientRect()
        return {
          kind: marker.getAttribute('data-chat-flow-kind'),
          rowTop: Math.round(box.top),
          rowBottom: Math.round(box.bottom),
        }
      })(),
      layerPosition: layer === null ? null : getComputedStyle(layer).position,
      layerPointerEvents: layer === null ? null : getComputedStyle(layer).pointerEvents,
      scrollerScrollTop: scroll.scrollTop,
      frameTop: Math.round(document.getElementById('root').getBoundingClientRect().top),
      frameHeight: Math.round(document.getElementById('root').getBoundingClientRect().height),
      docScrollTop: document.scrollingElement.scrollTop,
      viewport: { width: innerWidth, height: innerHeight },
    }`)
  console.log('SETTLED', JSON.stringify(result))
  if (DUMP.length > 0) await writeFile(DUMP, JSON.stringify(result, null, 2), 'utf8')

  check('bar renders the match count', result.count === '1/3', `count=${result.count}`)
  check('overlay is fixed and click-through',
    result.layerPosition === 'fixed' && result.layerPointerEvents === 'none',
    `position=${result.layerPosition} pointerEvents=${result.layerPointerEvents}`)
  // How many marks exist depends on what is inside the scrollport at measure time:
  // the overlay clips to the scrollport (that is what keeps it honest when the
  // document itself scrolls), so a fixture whose active match sits at the top of
  // the content shows fewer of them. The invariants below are count-independent.
  check('highlights are positioned boxes with a fill',
    result.marks >= 1 &&
    result.markPositions.every(position => position === 'absolute') &&
    result.markBackgrounds.every(background => background !== 'rgba(0, 0, 0, 0)'),
    `marks=${result.marks} positions=${JSON.stringify(result.markPositions)} backgrounds=${JSON.stringify(result.markBackgrounds)}`)
  check('highlights sit over the seeded rows, not the page origin',
    result.markRects.length >= 1 && result.markRects.every(rect => rect.left > 100 && rect.width > 50 && rect.height > 0),
    JSON.stringify(result.markRects))
  // A highlight must be one line box around the matched word, never the message
  // block and never a container: that is what "highlight covers everything" was.
  check('highlights are tight around the matched word, not the whole block',
    result.markRects.every(rect => rect.height <= 40) &&
    result.markRects.every(rect => rect.width < result.viewport.width * 0.9) &&
    result.diagnostics !== null &&
    result.diagnostics.fallbacks === 0 &&
    result.diagnostics.tallestMark <= 40,
    JSON.stringify({ rects: result.markRects, diagnostics: result.diagnostics }))
  // Highlight marks are one line tall and must be painted inside the scrollport's
  // visible band. The locating ring is deliberately exempt: it wraps the whole
  // message row, which may legitimately extend past the band.
  check('every highlight mark is painted inside the scrollport band',
    result.markRects.every(rect => rect.left >= -8 && rect.top >= result.scrollBand.top - 8 &&
      rect.left + rect.width <= result.viewport.width + 8 &&
      rect.top + rect.height <= result.scrollBand.bottom + 8),
    JSON.stringify({ band: result.scrollBand, rects: result.markRects }))
  check('the active match carries its own highlight and its row a ring',
    result.activeMarks <= 1 && result.rings === 1, `activeMarks=${result.activeMarks} rings=${result.rings}`)
  // The row marker is what tells the DOM which message is active; it must be a real
  // transcript row (not a wrapper) and it must hold the ring's rectangle.
  check('the active match marks a real message row',
    result.activeRow !== null &&
    ['user', 'assistant-step', 'tool-call', 'steering', 'command'].includes(result.activeRow.kind) &&
    result.activeRow.rowTop < result.scrollBand.bottom && result.activeRow.rowBottom > result.scrollBand.top,
    JSON.stringify(result.activeRow))
  check('the active ring wraps the active message row',
    result.ringRects.length === 1 && result.ringRects[0].width > 200 && result.ringRects[0].height > 100,
    JSON.stringify(result.ringRects))
  check('the overlay does not move the page',
    result.frameTop === seeded.frameTopBefore &&
    result.frameHeight === seeded.frameHeightBefore &&
    result.docScrollTop === seeded.docScrollTopBefore,
    JSON.stringify({ before: seeded, after: { top: result.frameTop, height: result.frameHeight, doc: result.docScrollTop } }))

  // ---- navigation ---------------------------------------------------------
  // The window keeps element focus inert in this headless window, so the keydown
  // is delivered to the input the shell's own handler listens on.
  const pressOnInput = async (key, shift) => {
    await cdp.evaluate(`
      const input = document.querySelector('[data-dsh-conversation-search-bar] input')
      if (!(input instanceof HTMLElement)) return false
      const event = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, shiftKey: ${shift === true}, bubbles: true, cancelable: true })
      return input.dispatchEvent(event)`)
  }
  await pressOnInput('Enter', false)
  await sleep(700)
  await pressOnInput('Enter', false)
  await sleep(900)
  const navigated = await cdp.evaluate(`
    const barNode = document.querySelector('[data-dsh-conversation-search-bar]')
    const status = barNode === null ? null : barNode.querySelector('[role="status"]')
    const layer = document.querySelector('[data-dsh-conversation-search-layer]')
    const marks = layer === null ? [] : [...layer.children].filter(node => node.hasAttribute('data-dsh-conversation-search-mark'))
    const scroller = document.querySelector('[data-conversation-scroll]')
    return {
      count: status === null ? null : status.textContent,
      activeMarks: marks.filter(node => node.getAttribute('data-active') === 'true').length,
      scrollerScrollTop: scroller === null ? null : scroller.scrollTop,
      docScrollTop: document.scrollingElement.scrollTop,
      frameTop: Math.round(document.getElementById('root').getBoundingClientRect().top),
    }`)
  console.log('NAVIGATION', JSON.stringify(navigated))
  check('Enter walks the matches forward', navigated.count === '3/3', `after two Enters=${navigated.count}`)
  check('navigation keeps exactly one active highlight',
    navigated.activeMarks === 1, JSON.stringify(navigated))
  check('navigation never scrolls the document or moves the frame',
    navigated.docScrollTop === 0 && navigated.frameTop === 0, JSON.stringify(navigated))

  // The composer is a child of the scrollport, so a jump must land inside the
  // usable area above it — not behind it (which forced a manual extra scroll).
  const landing = await cdp.evaluate(`
    const markerSelector = '[data-dsh-conversation-search]:not([data-dsh-conversation-search-layer]):not([data-dsh-conversation-search-bar]):not([data-dsh-conversation-search-mark]):not([data-dsh-conversation-search-ring]):not([data-dsh-conversation-search-spacer])'
    const row = document.querySelector(markerSelector)
    const scroll = document.querySelector('[data-conversation-scroll]')
    const seat = document.querySelector('[data-composer-seat]')
    const spacer = document.querySelector('[data-dsh-conversation-search-spacer]')
    const rowRect = row === null ? null : row.getBoundingClientRect()
    const seatRect = seat === null ? null : seat.getBoundingClientRect()
    const scrollRect = scroll.getBoundingClientRect()
    const usableBottom = seatRect !== null && seatRect.top > scrollRect.top && seatRect.top < scrollRect.bottom ? seatRect.top : scrollRect.bottom
    const table = globalThis.dshConversationSearch
    let lastReveal = null
    if (table !== null && table !== undefined && typeof table.diagnose === 'function') {
      try { lastReveal = table.diagnose().lastReveal } catch (error) { lastReveal = String(error) }
    }
    return {
      rowTop: rowRect === null ? null : Math.round(rowRect.top),
      rowBottom: rowRect === null ? null : Math.round(rowRect.bottom),
      usableTop: Math.round(scrollRect.top),
      usableBottom: Math.round(usableBottom),
      scrollTop: Math.round(scrollRect.top),
      scrollBottom: Math.round(scrollRect.bottom),
      seatTop: seatRect === null ? null : Math.round(seatRect.top),
      spacerHeight: spacer === null ? 0 : Math.round(parseFloat(spacer.style.height) || 0),
      lastReveal,
    }`)
  /*
   * The measured guarantees: the revealed row is never behind the composer, and
   * the centring targets the middle of the usable area. Exact math for the
   * clamped and oversized cases lives in tests/engine.test.mjs, because the
   * shipped composer is composed in a sticky layer whose geometry a synthetic
   * fixture cannot reproduce faithfully.
   */
  const composerVisible = landing.seatTop !== null &&
    landing.seatTop > landing.usableTop && landing.seatTop < landing.usableBottom
  console.log('LANDING', JSON.stringify({ ...landing, composerVisible }))
  check('a jump never leaves the row behind the composer',
    landing.rowTop !== null && landing.rowBottom !== null &&
    landing.rowTop >= landing.usableTop &&
    (!composerVisible || landing.rowBottom <= landing.seatTop),
    JSON.stringify({ ...landing, composerVisible }))
  // The engine must aim the matched span at the centre of the area it considers
  // usable. Which composer seat it measures can differ from this script's probe in
  // a headless fixture, so either definition is accepted — a jump that drifts away
  // from both centres still fails. Exact composition is pinned in
  // tests/engine.test.mjs.
  const centers = [
    (landing.usableTop + landing.usableBottom) / 2,
    (landing.scrollTop + landing.scrollBottom) / 2,
  ]
  const anchorError = landing.lastReveal !== null && typeof landing.lastReveal === 'object'
    ? Math.min(...centers.map(center => Math.abs(landing.lastReveal.anchor - center)))
    : null
  check('a jump aims the matched span at the centre of the usable area',
    anchorError !== null && anchorError <= 12,
    JSON.stringify({ anchor: landing.lastReveal?.anchor, anchorError, centers, usable: [landing.usableTop, landing.usableBottom] }))
  check('a jump leaves the row inside the viewport',
    landing.rowBottom <= landing.usableBottom, JSON.stringify(landing))
  check('centring reserves the extra scroll room it needs',
    landing.spacerHeight > 0, `spacerHeight=${landing.spacerHeight}`)

  // ---- wrap-around navigation --------------------------------------------
  // Three matches: from 3/3 one more Enter must return to 1/3, and Shift+Enter
  // from 1/3 must land on 3/3.
  await pressOnInput('Enter', false)
  await sleep(500)
  const wrappedForward = await cdp.evaluate(`
    const status = document.querySelector('[data-dsh-conversation-search-bar] [role="status"]')
    return status === null ? null : status.textContent`)
  await pressOnInput('Enter', true)
  await sleep(500)
  const wrappedBackward = await cdp.evaluate(`
    const status = document.querySelector('[data-dsh-conversation-search-bar] [role="status"]')
    return status === null ? null : status.textContent`)
  console.log('CYCLING', JSON.stringify({ wrappedForward, wrappedBackward }))
  check('Next wraps from the last match back to the first', wrappedForward === '1/3', `got ${wrappedForward}`)
  check('Shift+Enter wraps from the first match back to the last', wrappedBackward === '3/3', `got ${wrappedBackward}`)

  // ---- close --------------------------------------------------------------
  // The Escape path is a window-level capture listener, so it works regardless
  // of which element owns focus.
  await cdp.key('Escape', 'Escape')
  await sleep(800)
  const closed = await cdp.evaluate(`
    const layer = document.querySelector('[data-dsh-conversation-search-layer]')
    const barNode = document.querySelector('[data-dsh-conversation-search-bar]')
    return {
      inputPresent: barNode !== null && barNode.querySelector('input') !== null,
      layerChildren: layer === null ? -1 : layer.children.length,
      rowMarkers: document.querySelectorAll('[data-dsh-conversation-search]').length,
    }`)
  check('Escape closes the bar and releases the overlay',
    closed.inputPresent === false && closed.layerChildren === 0 && closed.rowMarkers === 0,
    JSON.stringify(closed))
  check('no console errors during the run', cdp.consoleErrors.length === 0, JSON.stringify(cdp.consoleErrors.slice(0, 4)))
} catch (error) {
  check('live overlay run completed', false, error.stack ?? String(error))
} finally {
  try { cdp?.socket.close() } catch (error) { /* ignore */ }
  try { chrome.kill() } catch (error) { /* ignore */ }
  await sleep(400)
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
}

const failed = checks.filter(item => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

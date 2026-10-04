/**
 * Behaviour smoke test for the built Client bundle, run in Node against a
 * minimal DOM stub. It exercises what the browser actually does:
 *
 *   1. the artifact registers a `__ModuleLoader__` factory under the package id;
 *   2. `apply` registers into `conversation.input.dock` without throwing;
 *   3. the engine indexes transcript rows and skips chrome rows and wrappers —
 *      the body envelope and the composer must never become search blocks;
 *   4. a query matches across split text nodes, case-sensitively on request;
 *   5. the highlight Range covers only the matched characters, never the block;
 *   6. an oversized (container-sized) rect is discarded instead of painted;
 *   7. Next/Previous moves the active match and marks the owning message row;
 *   8. a live transcript append is seen by the next re-index;
 *   9. `loadOlder` pages history in and the rebuilt index sees the new rows;
 *  10. `close()` and `dispose()` release the overlay and the Session binding.
 *
 * Not covered here (browser-only): React rendering of the bar, the overlay's real
 * geometry, smooth scrolling, and the Ctrl+F listener — see
 * `scripts/verify-overlay.mjs` for those.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext } from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifact = await readFile(join(root, 'lib', 'client.js'), 'utf8')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/* --------------------------------------------------------------- DOM stub */

class Node_ {
  constructor() {
    this.childNodes = []
    this.parentElement = null
    this.attributes = new Map()
    this.style = {}
    this.isConnected = true
    this.nodeValue = null
    this.scrollTop = 0
  }
  get firstChild() { return this.childNodes[0] ?? null }
  get children() { return this.childNodes.filter(node => node instanceof Element) }
  appendChild(node) { node.parentElement = this; node.isConnected = true; this.childNodes.push(node); return node }
  append(...nodes) { for (const node of nodes) this.appendChild(node) }
  remove() {
    const parent = this.parentElement
    if (parent === null) return
    parent.childNodes = parent.childNodes.filter(node => node !== this)
    this.parentElement = null
  }
  replaceChildren(...nodes) {
    for (const node of this.childNodes) node.parentElement = null
    this.childNodes = []
    for (const node of nodes) this.appendChild(node)
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener() {}
  removeEventListener() {}
  closest(selector) {
    let current = this
    while (current !== null) {
      if (current instanceof Element && current.matches(selector)) return current
      current = current.parentElement
    }
    return null
  }
  contains(other) {
    let current = other
    while (current !== null) {
      if (current === this) return true
      current = current.parentElement
    }
    return false
  }
  querySelectorAll(selector) { return queryAll(this, selector) }
  querySelector(selector) { return queryAll(this, selector)[0] ?? null }
  /**
   * Rects are viewport-relative, so an element marked `scrolls` has its `rect`
   * read as its position at `scrollTop = 0` and shifted by the scrollport's
   * current scroll. Overlay fixtures (the composer seat) stay put so the usable
   * area is stable across scrolls, exactly as a sticky composer behaves.
   */
  getBoundingClientRect() {
    const rect = this.rect ?? { left: 10, top: 20, right: 400, bottom: 60, width: 390, height: 40 }
    const parent = this.scrolls === true
      ? this.closest('[data-conversation-scroll]')
      : null
    if (parent === null) return rect
    const offset = parent.scrollTop || 0
    return { ...rect, top: rect.top - offset, bottom: rect.bottom - offset }
  }
  scrollTo(options) { this.scrollCalls = (this.scrollCalls ?? []).concat([options]) }
  compareDocumentPosition(other) { return this === other ? 0 : 4 }
  scrollIntoView() { this.scrolled = (this.scrolled ?? 0) + 1 }
  get textContent() {
    return this.childNodes.map(node => (node instanceof Text_ ? node.nodeValue : node.textContent)).join('')
  }
}

class Element extends Node_ {
  constructor(tagName) {
    super()
    this.tagName = tagName.toUpperCase()
  }
  matches(selector) { return matchesSelector(this, selector) }
  get parentNode() { return this.parentElement }
}

class Text_ extends Node_ {
  constructor(value) {
    super()
    this.nodeValue = value
  }
  get parentNode() { return this.parentElement }
}

/**
 * Selector support for exactly the forms the plugin uses. `:not(...)` and
 * `:scope` are dropped because the stub models neither; the plugin does not
 * depend on them for correctness (it re-checks `hidden` and containment itself).
 */
function matchesSelector(element, selector) {
  return selector.split(',').some(part => {
    let rest = part.trim().replace(/:not\([^)]*\)/g, '').replace(/:scope\b/g, '')
    const attributes = []
    rest = rest.replace(/\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g, (match, name, value) => {
      attributes.push([name, value])
      return ''
    })
    const tag = rest.trim()
    if (tag.length > 0 && element.tagName !== tag.toUpperCase()) return false
    return attributes.every(([name, value]) => {
      if (!element.hasAttribute(name)) return false
      return value === undefined || element.getAttribute(name) === value
    })
  })
}

function queryAll(root, selector) {
  const found = []
  const visit = node => {
    for (const child of node.childNodes) {
      if (child instanceof Element) {
        if (matchesSelector(child, selector)) found.push(child)
        visit(child)
      }
    }
  }
  visit(root)
  return found
}

function el(tag, attributes = {}, ...children) {
  const element = new Element(tag)
  for (const [name, value] of Object.entries(attributes ?? {})) element.setAttribute(name, value)
  for (const child of children) {
    if (typeof child === 'string' || typeof child === 'number') element.appendChild(new Text_(String(child)))
    else if (child !== null && child !== undefined) element.appendChild(child)
  }
  return element
}

/* --------------------------------------------------------- transcript rig */

/** Ranges the engine created, and the rects the fake layout reports for them. */
const ranges = []
let rangeRects = [{ left: 12, top: 24, width: 48, height: 18, bottom: 42, right: 60 }]

const document_ = new Element('html')
const body = el('body')
const head = el('head')
document_.appendChild(body)
document_.appendChild(head)

const documentFake = {
  body,
  head,
  documentElement: document_,
  createElement: tag => new Element(tag),
  createTextNode: value => new Text_(value),
  createTreeWalker(node, _what, filter) {
    const nodes = []
    const visit = current => {
      for (const child of current.childNodes) {
        if (child instanceof Text_) {
          if ((filter?.acceptNode?.(child) ?? 1) === 1) nodes.push(child)
        } else if (child instanceof Element) {
          visit(child)
        }
      }
    }
    visit(node)
    let index = -1
    return { nextNode: () => (++index < nodes.length ? nodes[index] : null) }
  },
  createRange() {
    const range = {
      start: null,
      end: null,
      setStart(node, offset) { range.start = { node, offset } },
      setEnd(node, offset) { range.end = { node, offset } },
      getClientRects() { return rangeRects },
    }
    ranges.push(range)
    return range
  },
  querySelector: selector => (selector.startsWith('style[') ? null : document_.querySelector(selector)),
  querySelectorAll: selector => document_.querySelectorAll(selector),
}

/*
 * Session shell, mirroring the shipped markup:
 *   occurrence[data-conversation-session]
 *     body[data-conversation-content][data-conversation-region="chat"]
 *       scrollBody[data-conversation-scroll]
 *         views       <- the transcript rows
 *         composerSeat[data-conversation-region="composer"]   <- a SIBLING row
 * The composer is a sibling of the transcript inside the scrollport and inside
 * the envelope, which is exactly why neither wrapper may become a search block.
 */
const composerRegion = el('div', { 'data-conversation-region': 'composer' },
  el('div', { 'data-composer-seat': '' }, 'composer hint: 中间产物 占位说明'))
const views = el('div', { 'data-views': '' })
const transcript = el('div', { 'data-conversation-scroll': '' }, views, composerRegion)
const chatRegion = el('div',
  { 'data-conversation-content': '', 'data-conversation-region': 'chat' }, transcript)
const occurrence = el('div', { 'data-conversation-session': 'session-1' }, chatRegion)
body.appendChild(occurrence)

/** The composer seat, used by the scroll math to find the usable viewport. */
const composerSeat = composerRegion.querySelector('[data-composer-seat]')

const userRow = (...children) => el('div', { 'data-chat-flow-kind': 'user', 'data-chat-anchor-key': 'k' }, ...children)
const assistantRow = (...children) => el('div', { 'data-chat-flow-kind': 'assistant-step', 'data-chat-anchor-key': 'k' }, ...children)
const processRow = (...children) => el('div', { 'data-chat-flow-kind': 'turn-process', 'data-chat-anchor-key': 'k' },
  el('div', { 'data-turn-process-content': '' }, ...children))

/** "Old" history the fake session appends when `loadOlder()` is called. */
const olderRows = [
  userRow('older question about the whale migration'),
  assistantRow('older answer mentioning WHALE twice'),
]

/* A long user message: the block is large, the match is one word inside it. */
const rowAlpha = userRow('Please search', el('em', null, 'the whale'), ' in this conversation')
const rowBeta = assistantRow('The WHALE appears here, and whale again.')
const rowGamma = processRow('session prompt should not be searched')
const rowDelta = el('div', { 'data-chat-flow-kind': 'system-prompt', 'data-chat-anchor-key': 'k' },
  el('div', { 'data-conversation-content': '' }, 'system prompt body'))
views.append(rowAlpha, rowBeta, rowGamma, rowDelta)

/**
 * The overlay layer the engine creates and fills. Records every child so the
 * test can assert real highlight geometry, not just bookkeeping.
 */
const layerHost = el('div', { 'data-dsh-conversation-search-layer': '' })
documentFake.querySelector = selector =>
  (selector.startsWith('style[') ? null : selector.startsWith('[data-dsh-conversation-search-layer]')
    ? (layerHost.isConnected ? layerHost : null)
    : document_.querySelector(selector))
documentFake.body.appendChild(layerHost)

/* --------------------------------------------------------------- runtime */

const snapshot = { hasMore: true }
let loadOlderCalls = 0
const session = {
  loadOlder: async () => { loadOlderCalls += 1; views.append(...olderRows); snapshot.hasMore = false },
  getSnapshot: () => snapshot,
}
const retainCalls = []
const released = []
const harness = {}

const realCtx = {
  effect(callback) { callback() },
  locale: { getSnapshot: () => ({ active: 'zh' }) },
  sessions: {
    retain(id, options) {
      retainCalls.push({ id, options })
      return { binding: { session }, ready: Promise.resolve(), release: () => released.push(id) }
    },
  },
  slots: {
    inject(name, callback) { realCtx.injectedInto = name; realCtx.injectReturn = callback() },
    register(meta, component) { realCtx.registeredMeta = meta; realCtx.component = component; return () => {} },
  },
}

const sandbox = {
  console,
  document: documentFake,
  Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
  NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame: callback => { callback(0); return 1 },
  cancelAnimationFrame() {},
  matchMedia: () => ({ matches: false }),
  getComputedStyle: () => ({
    getPropertyValue: () => '',
    marginTop: '0px',
  }),
  innerHeight: 900,
  innerWidth: 1600,
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load(registration) { harness.registration = registration } },
  __DSH_CONVERSATION_SEARCH_TEST__: harness,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox

new Script(artifact, { filename: 'client.js' }).runInContext(createContext(sandbox))

/* ------------------------------------------------------------------ tests */

const registration = harness.registration
assert.ok(registration, 'bundle must register a __ModuleLoader__ factory')
assert.equal(registration.id, manifest.name, 'bundle id must equal the package name')

const exports_ = registration.factory(specifier => {
  if (specifier === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useRef: value => ({ current: value }),
      useState: value => [value, () => {}],
      useEffect: () => {},
    }
  }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error(`unexpected require: ${specifier}`)
})

assert.equal([...exports_.inject].join(','), 'slots,locale,sessions')
exports_.apply(realCtx)
assert.equal(realCtx.injectedInto, 'conversation.input.dock', 'must inject into the conversation input dock')
assert.equal(realCtx.registeredMeta.id, 'conversation-search.find')
assert.equal(realCtx.registeredMeta.order, 40)

// The registered component is a React function component that closes over the
// engine `createSearchBar` already built. Invoking it renders the closed bar.
const element = realCtx.component({})
assert.ok(element && typeof element === 'object', 'component must render an element')

const engine = harness.engine
assert.ok(engine, 'the engine must be exposed to the harness for direct checks')

engine.bindSession('session-1')
assert.equal(retainCalls.length, 1)
assert.equal(retainCalls[0].id, 'session-1')
engine.attachScrollport(transcript)

let count = await engine.search('whale', false)
assert.equal(count, 3, 'case-insensitive search must find every occurrence')

/*
 * The envelope and the composer must never contribute searchable text: the
 * envelope wraps the whole session body, and the composer is a sibling of the
 * transcript inside it, so either one as a block paints across the entire body.
 */
count = await engine.search('中间产物', false)
assert.equal(count, 0, 'the composer hint must not be searchable')
count = await engine.search('composer hint', false)
assert.equal(count, 0, 'composer text must stay out of the index')
for (const block of engine.blocks()) {
  assert.ok(!block.text.includes('composer hint'), `indexed block leaked composer text: ${JSON.stringify(block.text)}`)
  assert.equal(block.envelope, false, 'the body envelope must never be a block')
  assert.equal(block.composer, false, 'a block must never live in the composer')
}
count = await engine.search('session prompt should not be searched', false)
assert.equal(count, 0, 'process-group content is not a searchable kind')
count = await engine.search('system prompt body', false)
assert.equal(count, 0, 'system-prompt rows are not searchable')

count = await engine.search('WHALE', true)
assert.equal(count, 1, 'case-sensitive search must match only the uppercase occurrence')

count = await engine.search('whale', false)
assert.equal(count, 3)
assert.equal(engine.state().active, 0)
engine.focus(engine.state().active)
assert.equal(rowAlpha.getAttribute('data-dsh-conversation-search'), '0', 'the active match must mark its message row')

/*
 * The highlight must cover the matched characters only. The active entry is the
 * first 'whale' inside rowAlpha's block, whose text starts with a prefix, so the
 * Range has to begin after that prefix rather than at the block's first node.
 */
const blockText = engine.blocks()[0].text
assert.ok(blockText.startsWith('Please search'), `fixture block should start with a prefix: ${blockText}`)

engine.next()
assert.equal(engine.state().active, 1)
assert.equal(rowAlpha.getAttribute('data-dsh-conversation-search'), null, 'the previous row must be unmarked')
assert.equal(rowBeta.getAttribute('data-dsh-conversation-search'), '1')

// Point the engine directly at the first match and inspect the Range it builds.
ranges.length = 0
engine.focus(0)
assert.equal(engine.state().active, 0)
assert.equal(rowAlpha.getAttribute('data-dsh-conversation-search'), '0', 'the active match must mark its message row')
assert.ok(ranges.length >= 1, 'painting must build a Range')
const activeRange = ranges[0]
assert.ok(activeRange.start !== null && activeRange.end !== null, 'the Range must have both ends set')

const startOffset = activeRange.start.offset
const endOffset = activeRange.end.offset
// The matched block is "Please search" + "the whale" + " in this conversation",
// and the query is "whale": the Range must cover those 5 characters only —
// not the whole block, and not the block's first node from offset 0.
const startText = activeRange.start.node.nodeValue
const endText = activeRange.end.node.nodeValue
assert.ok(String(startText).includes('the whale'), `the Range must start inside the matched node: ${JSON.stringify(startText)}`)
assert.ok(String(endText).includes('the whale'), `the Range must end inside the matched node: ${JSON.stringify(endText)}`)
assert.equal(endOffset - startOffset, 'whale'.length, 'the Range must cover exactly the matched characters')
assert.notEqual(startOffset, 0, 'the Range must not start at the block prefix')

/* An oversized rect (a container box) must be discarded, not painted. */
const marksBefore = layerHost.childNodes.filter(node => node.hasAttribute('data-dsh-conversation-search-mark')).length
assert.ok(marksBefore >= 1, 'a normal text rect must paint a mark')
rangeRects = [{ left: 0, top: 0, width: 1600, height: 900, bottom: 900, right: 1600 }]
engine.repaint()
assert.equal(
  layerHost.childNodes.filter(node => node.hasAttribute('data-dsh-conversation-search-mark')).length,
  0,
  'a container-sized rect must never be painted as a highlight',
)
assert.equal(engine.diagnose().marks, 0, 'diagnostics must report no marks after discarding them')
rangeRects = [{ left: 12, top: 24, width: 48, height: 18, bottom: 42, right: 60 }]
engine.repaint()
assert.ok(
  layerHost.childNodes.filter(node => node.hasAttribute('data-dsh-conversation-search-mark')).length >= 1,
  'a normal text rect must be painted again',
)

/* The overlay layer must actually receive highlight geometry. */
const marks = () => layerHost.childNodes.filter(node => node.hasAttribute('data-dsh-conversation-search-mark'))
const rings = () => layerHost.childNodes.filter(node => node.hasAttribute('data-dsh-conversation-search-ring'))
assert.ok(marks().length >= 1, 'painting must place at least one highlight mark')
assert.ok(rings().length >= 1, 'the active match must place a containing ring')
assert.equal(marks().filter(mark => mark.getAttribute('data-active') === 'true').length, 1, 'exactly one mark is the active match')
assert.match(marks()[0].style.left, /^-?\d+(\.\d+)?px$/, 'a mark must carry a pixel left offset')
assert.ok(parseFloat(marks()[0].style.width) > 0, 'a mark must have positive width')
assert.ok(parseFloat(marks()[0].style.height) > 0, 'a mark must have positive height')

engine.next()
engine.next()
assert.equal(engine.state().active, 2, 'Next must reach the last match')
engine.next()
assert.equal(engine.state().active, 0, 'Next on the last match must cycle to the first')
engine.previous()
assert.equal(engine.state().active, 2, 'Previous on the first match must cycle to the last')
engine.next()
assert.equal(engine.state().active, 0, 'Next must cycle forward again')
engine.next()
assert.equal(engine.state().active, 1, 'Next must step forward from the first match')

/*
 * Jump geometry. The composer is a child of the scrollport, so the usable area
 * ends at the composer's top. Centring uses the MATCHED SPAN's own box (not the
 * row's): centring the row would put the match low inside a tall message, and
 * centring on the raw scrollport would land it behind the composer.
 */
const callCount = () => (transcript.scrollCalls ?? []).length
transcript.scrollTop = 0
transcript.scrollHeight = 2000
transcript.clientHeight = 700
transcript.rect = { left: 0, top: 0, right: 800, bottom: 700, width: 800, height: 700 }
composerSeat.rect = { left: 0, top: 580, right: 800, bottom: 700, width: 800, height: 120 }
// Range rects are viewport-relative too, so a helper keeps them consistent with
// the current scroll position instead of freezing them at one instant.
const rangeAt = (top, height) => [{
  left: 300, top: top - transcript.scrollTop, width: 400, height,
  bottom: top - transcript.scrollTop + height, right: 700,
}]
// The matched span: one text line, below the usable area (which ends at 580).
rangeRects = rangeAt(500, 18)
let before = callCount()
engine.focus(1)
let revealCalls = (transcript.scrollCalls ?? []).slice(before)
assert.equal(revealCalls.length, 1, 'centring a match must scroll the scrollport exactly once')
// Usable height 580, span height 18: the span starts at (580-18)/2 = 281, so the
// scrollport moves 500 - 281 = 219. Centring on the raw 700px scrollport would
// have produced 500 - 341 = 159, i.e. that much lower on screen.
assert.equal(revealCalls[0].top, 219, `expected the match centred in the usable area, got ${revealCalls[0].top}`)

// Re-selecting a match that is now centred must not move the reader: the span
// rects are recomputed for the new scroll position, so the second centring
// computes 219 again instead of drifting.
transcript.scrollTop = revealCalls[0].top
rangeRects = rangeAt(500, 18)
before = callCount()
engine.focus(1)
revealCalls = (transcript.scrollCalls ?? []).slice(before)
assert.equal(revealCalls.length, 1, 're-selecting must still run the centring pass')
assert.equal(revealCalls[0].top, 219, 're-selecting an already centred match must not move the reader')

// A span taller than the usable area is anchored at the top of the usable area, so
// the match stays inside it instead of hanging below.
transcript.scrollTop = 0
rangeRects = rangeAt(500, 700)
before = callCount()
engine.focus(1)
revealCalls = (transcript.scrollCalls ?? []).slice(before)
assert.equal(revealCalls.length, 1, 'centring an oversized span must scroll once')
// clamp(height, 580) = 580, so the anchor is the usable top and the move is 500.
assert.equal(revealCalls[0].top, 500, `expected the oversized span anchored at the usable top, got ${revealCalls[0].top}`)
rangeRects = [{ left: 12, top: 24, width: 48, height: 18, bottom: 42, right: 60 }]

// The reserved scroll room must exist while a search is active and be dropped
// with the engine, so the plugin never leaves layout changes behind.
const scrollerSpacer = () => transcript.querySelector('[data-dsh-conversation-search-spacer]')
assert.notEqual(scrollerSpacer(), null, 'centring must reserve scroll room after the transcript')

// Closing the bar must release everything the overlay painted, because the layer
// lives outside the component's subtree.
engine.close()
assert.equal(layerHost.childNodes.length, 0, 'close() must empty the highlight layer')
assert.equal(engine.state().entries.length, 0, 'close() must drop the match list')
assert.equal(document_.querySelector('[data-dsh-conversation-search]'), null, 'close() must clear the row marker')

// Live transcript growth is picked up by the next search.
views.appendChild(assistantRow('a freshly streamed whale'))
count = await engine.search('whale', false)
assert.equal(count, 4, 'a re-index must see newly rendered rows')

// Unloaded history: nothing matches until the window is paged in.
count = await engine.search('migration', false)
assert.equal(count, 0)
assert.equal(engine.state().hasMore, true)
const result = await engine.loadOlderMessages()
assert.equal(result.loaded, true)
assert.equal(loadOlderCalls, 1)
assert.equal(engine.state().hasMore, false, 'hasMore must follow the Session snapshot after paging')
count = await engine.search('migration', false)
assert.equal(count, 1, 'paged-in history must become searchable')

engine.dispose()
assert.equal(layerHost.childNodes.length, 0, 'disposing must empty the highlight layer')
assert.equal(released.length, 1, 'disposing must release the retained Session reference')

console.log('ok: engine behaviour checks passed')

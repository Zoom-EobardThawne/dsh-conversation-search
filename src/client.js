/**
 * @dev_zf/dsh-conversation-search — Client half.
 *
 * Adds an in-conversation find bar to the current Session transcript:
 *
 *  - `Ctrl+F` / `Cmd+F` (or the composer dock chip) opens it.
 *  - It searches the message text rendered in the Session transcript — user
 *    messages, assistant responses, and tool/process rows currently loaded —
 *    case-insensitively by default.
 *  - Every match is highlighted by a `position: fixed` overlay layer, so the
 *    transcript DOM is never mutated and React reconciliation is untouched.
 *  - Next/Previous moves the active match and scrolls that message into view.
 *  - When a query matches nothing in the loaded window, the bar can page older
 *    history in (`ISession.loadOlder()`) and keep searching, which is how Chat
 *    itself reaches earlier Turns.
 *
 * DOM contracts used (all shipped by ui-conversation / ui-chat, and stable
 * because Chat's own reading-position, paging and turn-rail behaviour reads
 * them too): `[data-conversation-scroll]` is the transcript scrollport,
 * `[data-conversation-session]` and `[data-conversation-region]` mark the
 * occurrence, and each transcript row carries `data-chat-flow-kind` /
 * `data-chat-anchor-key` / `data-chat-turn`.
 *
 * The engine is built inside `apply` — the Cordis service context lives there,
 * not in a slot component's props — and handed to the registered component as a
 * prop, so the component stays a plain view over it.
 *
 * This file is a lazy-CJS module body: `require` resolves against the shell's
 * frozen platform module table. `scripts/build-client.mjs` wraps it for
 * `window.__ModuleLoader__.load`.
 */

const React = require('react')

/** ui-primitives is a platform seed; tolerate its absence for a clean downgrade. */
const ui = (() => {
  try {
    return require('@deepseek-ai/dsh-client-ui-primitives') || {}
  } catch (error) {
    return {}
  }
})()

const ATTRIBUTE = 'data-dsh-conversation-search'
/**
 * Elements owned by this plugin. The match-exclusion filter must name only
 * these: a message row carries `ATTRIBUTE` while it is the active match, so
 * excluding `[ATTRIBUTE]` would drop that row from the next re-index.
 */
const OWNED = `[${ATTRIBUTE}-layer], [${ATTRIBUTE}-bar], [${ATTRIBUTE}-mark], [${ATTRIBUTE}-ring]`
const STYLE_ID = 'dsh-conversation-search-styles'
const MATCH_LIMIT = 4000
const SNIPPET_RADIUS = 48
/** Gap kept between a revealed row and the composer that covers the scrollport. */
const REVEAL_MARGIN = 16

/**
 * Chrome-like rows are skipped, and the transcript's full-width wrappers — the
 * `[data-conversation-content]` envelope that also wraps the composer, and the
 * composer region itself — must never become a search block, or one match paints
 * across the whole session body.
 */
const SEARCHABLE_KINDS = new Set([
  'user',
  'steering',
  'assistant-step',
  'tool-call',
  'command',
  'command-input',
  'question-reply',
  'turn-error',
  'turn-max-tokens',
  'workflow-run',
])

/**
 * Wrappers that hold one message's visible prose. `[data-turn-process-content]`
 * is always per-message; `[data-conversation-content]` is per-message only when
 * it is not the body envelope that also wraps the composer.
 */
const PROSE = '[data-turn-process-content], [data-conversation-content]'

/** Whether an element is the transcript body envelope rather than a message. */
function isBodyEnvelope(element) {
  if (!element.hasAttribute('data-conversation-content')) return false
  const parent = element.parentElement
  const grandparent = parent === null ? null : parent.parentElement
  return grandparent !== null && grandparent.hasAttribute('data-conversation-scroll')
}

/** Whether an element belongs to the composer rather than the transcript. */
function isComposerRegion(element) {
  return element.closest(`${OWNED}, [data-conversation-region="composer"]`) !== null
}

/* ------------------------------------------------------------------ text */

const collapse = value => String(value).replace(/\s+/gu, ' ').trim()

const translate = (ctx, zh, en) => {
  try {
    return ctx.locale.getSnapshot().active === 'zh' ? zh : en
  } catch (error) {
    return en
  }
}

/* ------------------------------------------------------------- transcript */

/** The Session identity carried by the occurrence, read from the DOM. */
function sessionIdFrom(node) {
  if (!node || typeof node.closest !== 'function') return undefined
  return node.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') || undefined
}

/** The transcript scrollport of the occurrence, pinned to `sessionId`. */
function transcriptFrom(node, sessionId) {
  if (!node || typeof node.closest !== 'function') return null
  const occurrence = sessionId === undefined ? null : node.closest(`[data-conversation-session="${sessionId}"]`)
  const scope = occurrence || node.closest('[data-conversation-region]')?.parentElement || null
  const scroller = (scope || document).querySelector?.('[data-conversation-scroll]')
  return scroller || node.closest('[data-conversation-scroll]') || null
}

/**
 * Searchable message rows in transcript order. `querySelectorAll` already
 * returns document order; the `closest` fallback cannot, so guard it by
 * skipping candidates outside this scroller.
 */
function messageRows(scroller) {
  if (!scroller) return []
  const candidates = scroller.querySelectorAll('[data-chat-flow-kind]:not([hidden])')
  const ordered = []
  const seen = new Set()
  for (const row of candidates) {
    if (seen.has(row) || row.hidden === true) continue
    if (typeof scroller.contains === 'function' && !scroller.contains(row)) continue
    const kind = row.getAttribute('data-chat-flow-kind')
    if (kind !== null && !SEARCHABLE_KINDS.has(kind)) continue
    seen.add(row)
    ordered.push(row)
  }
  return ordered
}

/** Text-bearing blocks inside one row, as `{ element, text, nodes }`. */
function rowBlocks(row) {
  const scopes = blockScopes(row)
  const blocks = []
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = node.nodeValue
        if (value === null || collapse(value).length === 0) return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        if (parent === null) return NodeFilter.FILTER_REJECT
        if (parent.closest(`${OWNED}, [data-conversation-region="composer"], input, textarea, [contenteditable="true"], script, style`) !== null) {
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const nodes = []
    let value = ''
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const start = value.length
      value += node.nodeValue
      nodes.push({ node, start })
    }
    if (nodes.length === 0 || collapse(value).length === 0) continue
    blocks.push({ element: scope, text: value, nodes })
  }
  return blocks
}

/**
 * The smallest containers holding one row's message prose.
 *
 * A dedicated inner wrapper is used when the row has one. The transcript body
 * envelope is never a block — it also wraps the composer, so one match in it
 * would paint across the whole session body. The row itself is the last resort:
 * for a Chat row that is a direct child of the scroll body, the row's subtree is
 * exactly its message.
 */
function blockScopes(row) {
  const preferred = []
  for (const element of row.querySelectorAll(PROSE)) {
    if (isComposerRegion(element) || isBodyEnvelope(element)) continue
    preferred.push(element)
  }
  return preferred.length > 0 ? preferred : [row]
}

function buildBlocks(scroller) {
  const blocks = []
  for (const row of messageRows(scroller)) {
    for (const block of rowBlocks(row)) blocks.push({ row, element: block.element, text: block.text, nodes: block.nodes })
  }
  return blocks
}

function snippetFor(value, start, length) {
  const from = Math.max(0, start - SNIPPET_RADIUS)
  const to = Math.min(value.length, start + length + SNIPPET_RADIUS)
  return `${from > 0 ? '…' : ''}${collapse(value.slice(from, to))}${to < value.length ? '…' : ''}`
}

/* ------------------------------------------------------------- highlight */

/**
 * Text nodes carrying the match, with a local offset for each.
 *
 * They are re-resolved on every use instead of trusting the index: the renderer
 * can replace a message's text nodes (a stream settling, a re-render), and a
 * detached node's `getClientRects()` reports its old position, which would place
 * the highlight — and the centring scroll — at stale coordinates.
 */
function matchSpans(entry) {
  if (entry.length <= 0) return []
  const block = entry.element
  if (block === null || block === undefined) return entry.nodes
  const fresh = []
  let offset = 0
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue
      if (value === null || collapse(value).length === 0) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (parent === null) return NodeFilter.FILTER_REJECT
      if (parent.closest(`${OWNED}, [data-conversation-region="composer"], input, textarea, [contenteditable="true"], script, style`) !== null) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    fresh.push({ node, start: offset })
    offset += node.nodeValue.length
  }
  if (fresh.length === 0) return entry.nodes
  const matchEnd = entry.start + entry.length
  const spans = []
  for (const { node, start } of fresh) {
    const length = node.nodeValue.length
    const nodeEnd = start + length
    if (nodeEnd <= entry.start || start >= matchEnd) continue
    spans.push({
      node,
      from: Math.max(0, entry.start - start),
      to: Math.min(length, matchEnd - start),
    })
  }
  // A re-render can leave the block shorter than the recorded offset: fall back to
  // the original nodes so the entry still produces geometry instead of nothing.
  return spans.length > 0 ? spans : entry.nodes
}

/** A DOM Range over exactly the matched characters. */
function matchRange(entry) {
  const spans = matchSpans(entry)
  const range = document.createRange()
  const first = spans[0]
  const last = spans[spans.length - 1]
  const firstFrom = first.from ?? 0
  const lastTo = last.to ?? last.node.nodeValue.length
  range.setStart(first.node, firstFrom)
  range.setEnd(last.node, lastTo)
  return range
}

/** Bounding box of the matched characters, or `null` when it has no geometry. */
function matchSpanRect(entry) {
  const rects = Array.from(matchRange(entry).getClientRects())
  return rects.length > 0 ? rects[0] : null
}

/**
 * Text rects are one line box tall. A rect the size of a panel is a container,
 * and drawing it would wash out the whole conversation.
 */
function plausibleTextRect(rect) {
  const viewportHeight = window.innerHeight || 0
  const viewportWidth = window.innerWidth || 0
  if (rect.width <= 0 || rect.height <= 0) return false
  if (viewportHeight > 0 && rect.height > Math.max(48, viewportHeight * 0.4)) return false
  if (viewportWidth > 0 && rect.width > viewportWidth * 1.02) return false
  return true
}

/* ---------------------------------------------------------------- overlay */

/**
 * One highlight layer per document, shared by every occurrence.
 *
 * Two constraints shape it:
 *  - `position: fixed` with an explicit viewport box, so the overlay follows the
 *    window instead of any scrolled ancestor.
 *  - `display: block` plus `inset`/`margin`/`transform: none`: the layer must not
 *    generate a flow box, or appending it to `body` would add line-box height and
 *    shift the whole application. (`transform: none` also keeps it from ever
 *    establishing a containing block for itself.)
 */
function highlightLayer() {
  const existing = document.querySelector(`[${ATTRIBUTE}-layer]`)
  if (existing) return existing
  const layer = document.createElement('div')
  layer.setAttribute(`${ATTRIBUTE}-layer`, '')
  document.body.appendChild(layer)
  return layer
}

function installStyles() {
  if (document.querySelector(`style[data-dsh-csearch=${JSON.stringify(STYLE_ID)}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-dsh-csearch', STYLE_ID)
  style.textContent = `
[${ATTRIBUTE}-layer]{position:fixed;display:block;inset:0;margin:0;padding:0;border:0;width:auto;height:auto;transform:none;z-index:2147483000;pointer-events:none}
[${ATTRIBUTE}-mark]{position:absolute;border-radius:3px;background:rgba(255,193,7,.42)}
[${ATTRIBUTE}-mark][data-active=true]{background:rgba(64,132,255,.55)}
[${ATTRIBUTE}-mark][data-active=true][data-flash=true]{animation:dsh-csearch-flash 1.1s ease-out 1}
@keyframes dsh-csearch-flash{0%{background:rgba(64,132,255,.15)}45%{background:rgba(64,132,255,.75)}100%{background:rgba(64,132,255,.55)}}
[${ATTRIBUTE}-ring]{position:absolute;border-radius:var(--dsw-radius-md,10px);border:1.5px solid var(--dsw-alias-brand-primary,#4c8dff);opacity:.85;transition:opacity .25s}
[${ATTRIBUTE}-ring][data-fading=true]{opacity:0}
`
  document.head.appendChild(style)
}

/* ---------------------------------------------------------------- engine */

function viewportContains(rect, band) {
  if (rect.width <= 0) return false
  const top = band === undefined ? -60 : band.top
  const bottom = band === undefined ? (window.innerHeight || 0) + 60 : band.bottom
  return rect.bottom > top - 60 && rect.top < bottom + 60
}

/**
 * One engine per mounted bar. It owns the Session binding, the built text
 * index, and the overlay marks; React only renders the control surface and
 * mirrors `state()` through the `subscribe` listener it registers on mount.
 */
function createEngine(ctx) {
  let listener = null
  let sessionId
  let reference = null
  let binding = null
  let scroller = null
  let blocks = []
  let entries = []
  let active = -1
  let marker = null
  let flashUntil = 0
  let hasMore = false
  let layer = null
  /** Reserved scroll room after the scrollport, so the last match can centre. */
  let revealSpacer = null
  /** The last centring computation, for `diagnose()`. */
  let lastReveal = null
  /** Watches the scrollport for layout changes that invalidate the marks. */
  let layoutObserver = null

  /**
   * Marks are painted from live rectangles, so any change in the transcript's
   * layout (reserved room, images settling, a stream inserting rows) invalidates
   * them. Watching the scroller keeps the overlay honest between user actions.
   */
  function observeLayout() {
    if (typeof ResizeObserver !== 'function') return
    if (layoutObserver !== null) {
      layoutObserver.disconnect()
      layoutObserver = null
    }
    if (scroller === null) return
    layoutObserver = new ResizeObserver(() => paint())
    layoutObserver.observe(scroller)
    for (const child of scroller.children) layoutObserver.observe(child)
  }
  /** Opt-in diagnostics: set `window.__DSH_CONVERSATION_SEARCH_DEBUG__ = true`. */
  const diagnostics = { marks: 0, fallbacks: 0, widest: 0, tallest: 0, visibleEntries: 0, layerConnected: false }

  /** Viewport rect → the absolute page coordinates the overlay layer uses. */
  const pageX = value => value + (window.scrollX || 0)
  const pageY = value => value + (window.scrollY || 0)

  /**
   * Visible band in viewport coordinates. It is the scrollport's own box, not the
   * window: the document can be scrolled while the transcript stays put, and
   * clipping to `innerHeight` would then paint marks for off-screen matches.
   */
  function viewportBand() {
    const view = scroller === null ? null : scroller.getBoundingClientRect()
    if (view !== null && view.height > 0) return { top: view.top, bottom: view.bottom }
    const height = window.innerHeight || 0
    return { top: 0, bottom: height }
  }

  const state = () => ({ entries, active, hasMore })

  function publish() {
    if (listener !== null) listener(state())
  }

  function paint() {
    if (layer === null || !layer.isConnected) layer = highlightLayer()
    const now = Date.now()
    const fragments = []
    let visibleEntries = 0
    let marksDrawn = 0
    let fallbacks = 0
    let widest = 0
    let tallest = 0
    const band = viewportBand()
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const row = entry.row
      if (!row || !row.isConnected) continue
      let rowRect
      try {
        rowRect = row.getBoundingClientRect()
      } catch (error) {
        continue
      }
      if (!viewportContains(rowRect, band)) continue
      visibleEntries += 1
      const isActive = index === active
      let rects = []
      try {
        rects = Array.from(matchRange(entry).getClientRects())
      } catch (error) {
        rects = []
      }
      for (const rect of rects) {
        if (!viewportContains(rect, band)) continue
        // A message row's own box is never a text rect. Anything this large is a
        // container, and painting it would cover the whole conversation.
        if (!plausibleTextRect(rect)) continue
        const mark = document.createElement('div')
        mark.setAttribute(`${ATTRIBUTE}-mark`, '')
        if (isActive) {
          mark.setAttribute('data-active', 'true')
          if (now < flashUntil) mark.setAttribute('data-flash', 'true')
        }
        mark.style.left = `${pageX(rect.left)}px`
        mark.style.top = `${pageY(rect.top)}px`
        mark.style.width = `${rect.width}px`
        mark.style.height = `${rect.height}px`
        fragments.push(mark)
        marksDrawn += 1
        widest = Math.max(widest, rect.width)
        tallest = Math.max(tallest, rect.height)
      }
      // Fallback for text that yields no client rects of its own (for example a
      // `display: contents` wrapper): mark the block, but never more than one
      // line tall, so a tall row cannot paint over the whole conversation.
      if (rects.length === 0) {
        const target = entry.element && typeof entry.element.getBoundingClientRect === 'function'
          ? entry.element
          : row
        if (target !== null && target !== undefined) {
          const rect = target.getBoundingClientRect()
          if (viewportContains(rect, band) && plausibleTextRect(rect) === false) {
            const lineHeight = Math.max(18, Math.min(28, rowRect.height > 0 ? rowRect.height : 20))
            const anchored = {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: Math.min(lineHeight, rect.height),
            }
            const mark = document.createElement('div')
            mark.setAttribute(`${ATTRIBUTE}-mark`, '')
            if (isActive) mark.setAttribute('data-active', 'true')
            mark.style.left = `${pageX(anchored.left)}px`
            mark.style.top = `${pageY(anchored.top)}px`
            mark.style.width = `${anchored.width}px`
            mark.style.height = `${anchored.height}px`
            fragments.push(mark)
            marksDrawn += 1
            fallbacks += 1
            widest = Math.max(widest, anchored.width)
            tallest = Math.max(tallest, anchored.height)
          }
        }
      }
    }
    const current = entries[active]
    if (current && current.row && current.row.isConnected) {
      const rowRect = current.row.getBoundingClientRect()
      if (rowRect.height > 0 && viewportContains(rowRect, band)) {
        const ring = document.createElement('div')
        ring.setAttribute(`${ATTRIBUTE}-ring`, '')
        if (now >= flashUntil) ring.setAttribute('data-fading', 'true')
        ring.style.left = `${pageX(rowRect.left) - 3}px`
        ring.style.top = `${pageY(rowRect.top) - 3}px`
        ring.style.width = `${Math.max(0, rowRect.width + 6)}px`
        ring.style.height = `${Math.max(0, rowRect.height + 6)}px`
        fragments.push(ring)
      }
    }
    layer.replaceChildren(...fragments)
    diagnostics.marks = marksDrawn
    diagnostics.fallbacks = fallbacks
    diagnostics.widest = Math.round(widest)
    diagnostics.tallest = Math.round(tallest)
    diagnostics.visibleEntries = visibleEntries
    diagnostics.layerConnected = layer.isConnected
  }

  function clearMarks() {
    if (marker && marker.isConnected) marker.removeAttribute(ATTRIBUTE)
    marker = null
  }

  /**
   * The part of the scrollport a reader can actually use for messages. The chat
   * composer is a child of the same scrollport, so the bottom of the scrollport
   * is covered by it: centring on the raw viewport centres the target *behind*
   * the composer, which is why a jump used to land slightly too low.
   */
  function usableViewport() {
    const view = scroller.getBoundingClientRect()
    let bottom = view.bottom
    // Scope the lookup to this occurrence: a second mounted transcript (for
    // example a chat tab in the right sidebar) must not supply this seat.
    const area = scroller.closest?.('[data-conversation-session]')
      ?? scroller.parentElement
      ?? null
    const seat = area === null ? null : area.querySelector('[data-composer-seat]')
    if (seat !== null) {
      const seatRect = seat.getBoundingClientRect()
      if (seatRect.height > 0 && seatRect.top > view.top && seatRect.top < bottom) bottom = seatRect.top
    }
    const height = bottom - view.top
    return height > 0 ? { top: view.top, height } : { top: view.top, height: view.height }
  }

  /** Padding plus first-child margins: room the scrollport itself already owns. */
  function contentInset() {
    const style = window.getComputedStyle(scroller)
    const vertical = ['padding-top', 'padding-bottom']
      .map(name => parseFloat(style.getPropertyValue(name)))
      .filter(value => Number.isFinite(value))
      .reduce((total, value) => total + value, 0)
    let margins = 0
    for (const child of scroller.children) {
      const margin = parseFloat(window.getComputedStyle(child).marginTop)
      if (Number.isFinite(margin)) margins += margin
    }
    return vertical + margins
  }

  /**
   * Reserve scroll room so a target can sit centred even at the very end of the
   * transcript. The composer covers the bottom of the scrollport, so without this
   * the final messages cannot be scrolled up to the middle of what a reader sees
   * and the browser clamps the scroll short.
   */
  function ensureRevealRoom() {
    if (scroller === null) return
    const view = scroller.getBoundingClientRect()
    const usable = usableViewport()
    if (usable.height <= 0) return
    const covered = Math.max(0, view.bottom - (usable.top + usable.height))
    const wanted = Math.round(usable.height / 2 - covered + REVEAL_MARGIN - contentInset())
    if (wanted <= 0) {
      if (revealSpacer !== null) {
        revealSpacer.remove()
        revealSpacer = null
      }
      return
    }
    if (revealSpacer === null || !revealSpacer.isConnected) {
      revealSpacer = document.createElement('div')
      revealSpacer.setAttribute(`${ATTRIBUTE}-spacer`, '')
      revealSpacer.style.cssText = 'pointer-events:none;width:1px;margin:0 auto;padding:0;border:0'
      scroller.appendChild(revealSpacer)
      observeLayout()
    }
    revealSpacer.style.height = `${wanted}px`
  }

  /**
   * Centre one match in the usable area — the part of the scrollport not covered
   * by the composer. It always scrolls, even when the target is already visible,
   * so "next" and "previous" put the match in the same place every time.
   *
   * `scrollIntoView` is deliberately avoided: it also scrolls every scrollable
   * ancestor, which would lift the whole application frame.
   */
  function revealRow(row, span) {
    if (!row || !row.isConnected) return
    const view = usableViewport()
    if (scroller !== null && typeof scroller.scrollTo === 'function' && view.height > 0) {
      // Prefer the matched text's own box: it keeps a match visible inside a
      // message that is taller than the usable area.
      const target = span !== null && span !== undefined ? span : row.getBoundingClientRect()
      const anchor = view.top + (view.height - Math.min(target.height, view.height)) / 2
      let top = scroller.scrollTop + (target.top - anchor)
      const maxTop = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0))
      if (maxTop > 0) top = Math.min(top, maxTop)
      top = Math.max(0, top)
      lastReveal = {
        targetTop: Math.round(target.top),
        targetHeight: Math.round(target.height),
        anchor: Math.round(anchor),
        scrollTop: Math.round(scroller.scrollTop),
        maxTop: Math.round(maxTop),
        top: Math.round(top),
        spacer: revealSpacer === null ? 0 : Math.round(parseFloat(revealSpacer.style.height) || 0),
      }
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      // Scroll first, then reserve room: the spacer changes layout, and doing it
      // afterwards keeps every measurement inside this reveal one geometry.
      scroller.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' })
      ensureRevealRoom()
      // Reserved room changes layout, so marks painted for the old geometry would
      // be stale: repaint for the soonest frame.
      paint()
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => paint())
      return true
    }
    if (typeof row.scrollIntoView === 'function') {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      row.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
      return true
    }
    return false
  }

  function setActive(index, scroll) {
    if (entries.length === 0) {
      active = -1
      clearMarks()
      paint()
      publish()
      return false
    }
    active = Math.max(0, Math.min(entries.length - 1, index))
    const entry = entries[active]
    clearMarks()
    if (entry && entry.row && entry.row.isConnected) {
      entry.row.setAttribute(ATTRIBUTE, String(active))
      marker = entry.row
    }
    if (scroll !== false && entry) {
      revealRow(entry.row, matchSpanRect(entry))
      flashUntil = Date.now() + 1100
    }
    paint()
    publish()
    return true
  }

  const api = {
    state,

    /**
     * What the current index holds, one entry per block: enough to see whether a
     * full-width wrapper or the composer leaked in, without exposing DOM nodes.
     */
    blocks() {
      return blocks.map(block => ({
        kind: block.row.getAttribute('data-chat-flow-kind'),
        envelope: block.element.hasAttribute('data-conversation-content'),
        composer: block.element.closest('[data-conversation-region="composer"]') !== null,
        length: block.text.length,
        text: collapse(block.text).slice(0, 60),
      }))
    },

    /** Diagnostics for a browser console: counts behind the last paint. */
    diagnose() {
      const rows = messageRows(scroller)
      const entry = entries[active]
      const className = scroller === null ? '' : typeof scroller.className === 'string' ? scroller.className : ''
      const usable = scroller === null ? null : usableViewport()
      return {
        sessionId: sessionId ?? null,
        scroller: scroller !== null,
        usableViewport: usable === null ? null : { top: Math.round(usable.top), height: Math.round(usable.height) },
        lastReveal,
        scrollTop: scroller === null ? null : Math.round(scroller.scrollTop || 0),
        scrollerTag: scroller === null ? null : `${scroller.tagName}.${className}`.slice(0, 80),
        rows: rows.length,
        kinds: [...new Set(rows.map(row => row.getAttribute('data-chat-flow-kind')))],
        blocks: blocks.length,
        entries: entries.length,
        active,
        activeRowConnected: entry ? entry.row.isConnected : null,
        activeRowText: entry && entry.row.firstChild ? String(entry.row.textContent).slice(0, 40) : null,
        activeTextNodes: entry ? entry.nodes.length : null,
        marks: diagnostics.marks,
        fallbacks: diagnostics.fallbacks,
        widestMark: diagnostics.widest,
        tallestMark: diagnostics.tallest,
        visibleEntries: diagnostics.visibleEntries,
        layerConnected: diagnostics.layerConnected,
        styleTag: document.querySelector('style[data-dsh-csearch]') !== null,
      }
    },

    subscribe(next) {
      listener = next
      return () => {
        if (listener === next) listener = null
      }
    },

    /** Bind (or unbind) one Session transcript. */
    bindSession(next) {
      if (next === sessionId) return
      sessionId = next
      blocks = []
      entries = []
      active = -1
      clearMarks()
      hasMore = false
      if (reference) {
        reference.release()
        reference = null
      }
      binding = null
      if (sessionId === undefined || typeof ctx.sessions?.retain !== 'function') {
        publish()
        return
      }
      try {
        reference = ctx.sessions.retain(sessionId, { source: 'controllerOperation' })
        reference.ready.then(function () {
          binding = reference?.binding ?? null
          hasMore = binding?.session?.getSnapshot?.().hasMore === true
          publish()
        }, function () {})
      } catch (error) {
        reference = null
      }
      publish()
    },

    /** Point the engine at one transcript scrollport and index what is loaded. */
    attachScrollport(element) {
      const next = element || null
      if (next === scroller) return
      // Reserved scroll room belongs to the previous scrollport; drop it with it.
      if (revealSpacer !== null) {
        revealSpacer.remove()
        revealSpacer = null
      }
      scroller = next
      blocks = buildBlocks(scroller)
      entries = []
      active = -1
      clearMarks()
      // Keep the scrollport where the reader left it while indexing.
      const restore = scroller === null ? 0 : scroller.scrollTop
      if (scroller !== null) scroller.scrollTop = restore
      observeLayout()
      paint()
      publish()
    },

    /** Rebuild the match list for one query. Resolves to the match count. */
    async search(query, caseSensitive) {
      blocks = buildBlocks(scroller)
      const needle = caseSensitive ? query : query.toLowerCase()
      const found = []
      if (needle.length > 0) {
        for (let index = 0; index < blocks.length && found.length < MATCH_LIMIT; index += 1) {
          const block = blocks[index]
          const haystack = caseSensitive ? block.text : block.text.toLowerCase()
          let from = 0
          while (found.length < MATCH_LIMIT) {
            const at = haystack.indexOf(needle, from)
            if (at < 0) break
            found.push({
              blockIndex: index,
              row: block.row,
              element: block.element,
              nodes: block.nodes,
              start: at,
              length: query.length,
              snippet: snippetFor(block.text, at, query.length),
            })
            from = at + Math.max(1, query.length)
          }
        }
      }
      entries = found
      if (found.length === 0) {
        active = -1
        clearMarks()
      } else if (active < 0) {
        active = 0
      } else if (active >= found.length) {
        active = found.length - 1
      }
      paint()
      publish()
      return found.length
    },

    /** Identity of the active match, used to survive a live re-index. */
    activeAnchor() {
      const entry = entries[active]
      if (!entry) return null
      return { blockIndex: entry.blockIndex, start: entry.start, length: entry.length }
    },

    /** Re-resolve the active match against the freshly built index. */
    restoreAnchor(anchor) {
      if (!anchor) return false
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        if (entry.blockIndex !== anchor.blockIndex) continue
        if (entry.start !== anchor.start || entry.length !== anchor.length) continue
        setActive(index, false)
        return true
      }
      return false
    },

    /** Next match, wrapping from the last back to the first. */
    next() {
      if (entries.length === 0) return false
      const total = entries.length
      const index = active < 0 ? 0 : active + 1
      return setActive(index >= total ? 0 : index)
    },

    /** Previous match, wrapping from the first back to the last. */
    previous() {
      if (entries.length === 0) return false
      const total = entries.length
      const index = active < 0 ? total - 1 : active - 1
      return setActive(index < 0 ? total - 1 : index)
    },

    focus(index) {
      return setActive(index)
    },

    /** Page older history in, then re-index. */
    async loadOlderMessages() {
      const session = binding?.session
      if (!session || typeof session.loadOlder !== 'function') return { loaded: false, hasMore }
      try {
        await session.loadOlder()
      } catch (error) {
        return { loaded: false, hasMore }
      }
      // Let the prepend commit and the transcript re-lay out before re-indexing.
      await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
      blocks = buildBlocks(scroller)
      const snapshot = session.getSnapshot?.()
      if (snapshot && typeof snapshot.hasMore === 'boolean') hasMore = snapshot.hasMore
      publish()
      return { loaded: true, hasMore }
    },

    syncPaging() {
      const snapshot = binding?.session?.getSnapshot?.()
      if (snapshot && typeof snapshot.hasMore === 'boolean') hasMore = snapshot.hasMore
    },

    repaint() {
      if (entries.length === 0) {
        if (layer !== null && layer.isConnected) layer.replaceChildren()
        return
      }
      paint()
    },

    /**
     * Closing the bar must release every highlight: the marks live on
     * `document.body`, outside the component's subtree, so unmounting the view
     * alone would leave them painted over the transcript.
     */
    close() {
      entries = []
      active = -1
      clearMarks()
      paint()
      publish()
    },

    dispose() {
      if (reference) {
        reference.release()
        reference = null
      }
      binding = null
      clearMarks()
      if (layer !== null && layer.isConnected) layer.replaceChildren()
      if (layoutObserver !== null) {
        layoutObserver.disconnect()
        layoutObserver = null
      }
      if (revealSpacer !== null) {
        revealSpacer.remove()
        revealSpacer = null
      }
    },
  }

  // Test hook: the Node behaviour harness drives the engine directly, because
  // the bar's control surface needs a React renderer the harness does not have.
  const harness = window.__DSH_CONVERSATION_SEARCH_TEST__
  if (harness !== undefined && harness !== null) harness.engine = api

  return api
}

/* ------------------------------------------------------------- component */

function iconFor(name, fallback) {
  const Glyph = ui[name]
  if (typeof Glyph === 'function') return React.createElement(Glyph, null)
  return React.createElement('span', { 'aria-hidden': 'true' }, fallback)
}

/**
 * The component the slot registry mounts for one occurrence. It is created per
 * registration and closes over that occurrence's engine and open/closed state,
 * because the Cordis service context lives in `apply`, not in slot props.
 */
function createSearchBar(ctx) {
  const engine = createEngine(ctx)
  const options = { open: false }
  const component = function ConversationSearchBar() {
    return React.createElement(FindBar, {
      engine,
      options,
      t: (zh, en) => translate(ctx, zh, en),
    })
  }
  return { engine, component }
}

/**
 * The control surface over one engine. All hooks stay here.
 */
function FindBar(props) {
  const engine = props.engine
  const t = props.t
  const options = props.options
  const hostRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const revision = React.useRef(0)
  const navigationRef = React.useRef(0)
  const [open, setOpenState] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [caseSensitive, setCaseSensitive] = React.useState(false)
  const [snapshot, setSnapshot] = React.useState({ entries: [], active: -1, hasMore: false })
  const [busy, setBusy] = React.useState(false)

  /** `options.open` mirrors the bar so the shortcut handler can read it directly. */
  const setOpen = value => {
    options.open = value
    setOpenState(value)
    if (!value) engine.close()
  }

  /** Next/Previous: record the reader's own move and repaint immediately. */
  const move = direction => {
    navigationRef.current += 1
    if (direction > 0) engine.next()
    else engine.previous()
    engine.repaint()
  }

  React.useEffect(() => engine.subscribe(setSnapshot), [])

  /* Session identity and scrollport discovery: both live in the occurrence DOM. */
  React.useEffect(() => {
    const node = hostRef.current
    if (!node) return undefined
    let lastSession
    let lastScroller
    const sync = () => {
      const next = sessionIdFrom(node)
      if (next !== lastSession) {
        lastSession = next
        engine.bindSession(next)
      }
      const scroller = transcriptFrom(node, next)
      if (scroller !== lastScroller) {
        lastScroller = scroller
        engine.attachScrollport(scroller)
      }
      engine.syncPaging()
    }
    sync()
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null
    observer?.observe(document.body, { childList: true, subtree: true })
    const interval = window.setInterval(sync, 1500)
    const repaint = () => engine.repaint()
    window.addEventListener('scroll', repaint, true)
    window.addEventListener('resize', repaint)
    return () => {
      observer?.disconnect()
      window.clearInterval(interval)
      window.removeEventListener('scroll', repaint, true)
      window.removeEventListener('resize', repaint)
      engine.dispose()
    }
  }, [])

  /* Ctrl/Cmd+F opens the bar instead of the browser's own find. */
  React.useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && options.open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key !== 'f' && event.key !== 'F') return
      const editable = event.target instanceof Element
        && event.target.closest('input, textarea, [contenteditable="true"]') !== null
      if (editable && !options.open) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  React.useEffect(() => {
    if (!open) return undefined
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open])

  /* Run the query, keeping the reader on the same match across live re-indexes. */
  const entryCount = snapshot.entries.length
  React.useEffect(() => {
    if (!open) return undefined
    const current = ++revision.current
    const trimmed = query.trim()
    const navigation = navigationRef.current
    const timer = window.setTimeout(async () => {
      const previous = engine.activeAnchor()
      const count = await engine.search(trimmed, caseSensitive)
      if (current !== revision.current) return
      if (count === 0) {
        engine.repaint()
        return
      }
      // A reader who moved between matches during the debounce keeps their place.
      if (navigationRef.current !== navigation && engine.state().active >= 0) return
      if (previous !== null && engine.restoreAnchor(previous)) return
      engine.focus(0)
    }, 140)
    return () => window.clearTimeout(timer)
  }, [open, query, caseSensitive, entryCount])

  /* Repaint while the transcript streams or re-lays out. */
  React.useEffect(() => {
    if (!open) return undefined
    let frame = 0
    const schedule = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        engine.repaint()
      })
    }
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null
    const scroller = transcriptFrom(hostRef.current, sessionIdFrom(hostRef.current))
    if (scroller && observer) observer.observe(scroller, { childList: true, subtree: true, characterData: true })
    const timer = window.setInterval(schedule, 900)
    return () => {
      observer?.disconnect()
      window.clearInterval(timer)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [open, entryCount])

  const total = snapshot.entries.length
  const position = total === 0 ? 0 : snapshot.active + 1
  const hasQuery = query.trim().length > 0

  const searchOlder = async () => {
    if (busy) return
    setBusy(true)
    try {
      const before = engine.state().entries.length
      const result = await engine.loadOlderMessages()
      const count = await engine.search(query.trim(), caseSensitive)
      if (count === 0) engine.focus(0)
      else if (result.loaded && before === 0) engine.focus(0)
      engine.repaint()
    } finally {
      setBusy(false)
    }
  }

  const chip = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 28,
    padding: '0 8px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: 12,
    lineHeight: '16px',
    cursor: 'pointer',
  }

  if (!open) {
    return React.createElement(
      'div',
      { ref: hostRef, style: { display: 'flex', justifyContent: 'center', padding: '2px 0 0' }, [`${ATTRIBUTE}-bar`]: '' },
      React.createElement(
        'button',
        {
          type: 'button',
          style: chip,
          title: t('在对话中查找（Ctrl+F）', 'Find in conversation (Ctrl+F)'),
          'aria-label': t('在对话中查找', 'Find in conversation'),
          onClick: () => setOpen(true),
        },
        iconFor('IconSearchOutlineRegular', '⌕'),
        React.createElement('span', null, t('查找', 'Find')),
      ),
    )
  }

  return React.createElement(
    'div',
    { ref: hostRef, style: { display: 'flex', justifyContent: 'center', padding: '2px 0 0' }, [`${ATTRIBUTE}-bar`]: '' },
    React.createElement(
      'div',
      {
        role: 'search',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: 'min(600px, 100%)',
          padding: '4px 6px',
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))',
          boxShadow: '0 4px 16px rgba(0, 0, 0, .12)',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
      React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', opacity: 0.7 } }, iconFor('IconSearchOutlineRegular', '⌕')),
      React.createElement('input', {
        ref: inputRef,
        type: 'text',
        value: query,
        spellCheck: false,
        placeholder: t('在当前对话中查找…', 'Find in this conversation…'),
        'aria-label': t('在当前对话中查找', 'Find in this conversation'),
        style: {
          flex: 1,
          minWidth: 60,
          height: 26,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 13,
        },
        onChange: event => setQuery(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) move(-1)
            else move(1)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        },
      }),
      React.createElement(
        'span',
        {
          role: 'status',
          'aria-live': 'polite',
          style: {
            minWidth: 56,
            textAlign: 'right',
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
            color: hasQuery && total === 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
          },
        },
        hasQuery ? (total === 0 ? t('无匹配', 'No match') : `${position}/${total}`) : '',
      ),
      hasQuery && total === 0 && snapshot.hasMore
        ? React.createElement(
          'button',
          { type: 'button', style: { ...chip, padding: '0 8px' }, disabled: busy, onClick: searchOlder },
          busy ? t('加载中…', 'Loading…') : t('搜索更早消息', 'Search older'),
        )
        : null,
      React.createElement(
        'button',
        {
          type: 'button',
          style: { ...chip, padding: '0 6px', opacity: total === 0 ? 0.45 : 1 },
          disabled: total === 0,
          title: t('上一个匹配（Shift+Enter）', 'Previous match (Shift+Enter)'),
          'aria-label': t('上一个匹配', 'Previous match'),
          onClick: () => move(-1),
        },
        iconFor('IconChevronUpOutlineRegular', '↑'),
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          style: { ...chip, padding: '0 6px', opacity: total === 0 ? 0.45 : 1 },
          disabled: total === 0,
          title: t('下一个匹配（Enter）', 'Next match (Enter)'),
          'aria-label': t('下一个匹配', 'Next match'),
          onClick: () => move(1),
        },
        iconFor('IconChevronDownOutlineRegular', '↓'),
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          style: {
            ...chip,
            padding: '0 7px',
            color: caseSensitive ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
            background: caseSensitive ? 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base))' : 'var(--dsw-alias-bg-base)',
          },
          title: t('区分大小写', 'Match case'),
          'aria-pressed': caseSensitive ? 'true' : 'false',
          'aria-label': t('区分大小写', 'Match case'),
          onClick: () => setCaseSensitive(value => !value),
        },
        'Aa',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          style: { ...chip, padding: '0 6px' },
          title: t('关闭（Esc）', 'Close (Esc)'),
          'aria-label': t('关闭查找', 'Close find'),
          onClick: () => setOpen(false),
        },
        iconFor('IconCloseOutlineRegular', '✕'),
      ),
    ),
  )
}

/* ------------------------------------------------------------- lifecycle */

export const name = 'conversation-search'
export const inject = ['slots', 'locale', 'sessions']

export const apply = ctx => {
  installStyles()
  const engines = []
  ctx.effect(() => () => {
    document.querySelector(`[${ATTRIBUTE}-layer]`)?.replaceChildren()
    const handle = window.dshConversationSearch
    if (handle !== undefined && engines.includes(handle.engine)) delete window.dshConversationSearch
  }, 'conversation-search: highlight layer release')

  /**
   * One bar per occurrence. The Cordis context is captured here, in `apply`,
   * because it is not part of a slot component's props.
   */
  ctx.slots.inject('conversation.input.dock', () => {
    const bar = createSearchBar(ctx)
    engines.push(bar.engine)
    // Console handle for support: `dshConversationSearch.diagnose()`.
    window.dshConversationSearch = { engine: bar.engine, diagnose: () => bar.engine.diagnose() }
    return ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'conversation-search.find',
      order: 40,
      label: () => translate(ctx, '查找', 'Find'),
    }, bar.component)
  })
}

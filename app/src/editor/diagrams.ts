// Diagrams: a ```mermaid fence renders as a picture.
//
// The diagram stays Mermaid source in the markdown file. That is the format
// Claude writes most reliably, it diffs and snapshots like any other text, and
// `core::plain` already keeps code block text in the plain text it anchors
// against, so a comment can land inside the diagram source with no new
// anchoring work. The picture is a view of that source, nothing more.
//
// Rendering goes through Crepe's code block `renderPreview` hook. It is called
// with the fence language and content on every change, and the preview it
// hands back is shown above (or instead of) the source; the toggle in the
// block's header switches between the two. Non-diagram fences return `null`
// synchronously, so an ordinary code block pays nothing.
//
// Mermaid is a few megabytes, so it is imported on first use rather than with
// the editor; a document without a diagram never loads it. The import is a
// separate chunk under Vite.

type Preview = null | string | HTMLElement
type Apply = (value: Preview) => void
type Mermaid = typeof import('mermaid').default

/** Fence languages that render. Matched case-insensitively. */
const LANGUAGES = new Set(['mermaid'])

const ATTR = 'data-sidenote-diagram'

/** A diagram wider than the column is scaled down to fit, but not below this,
 *  because labels at half size cannot be read. Past it the picture keeps its
 *  natural size and the block scrolls sideways. */
const MIN_SCALE = 0.8

let mermaidModule: Promise<Mermaid> | null = null
function loadMermaid(): Promise<Mermaid> {
  mermaidModule ??= import('mermaid').then((m) => m.default)
  return mermaidModule
}

// ---- theme -----------------------------------------------------------------
//
// Mermaid bakes its colours and font into the SVG when it renders, so the
// picture has to be drawn again when the app changes theme or typeface.
// Settings writes `data-theme` and `data-typeface` on the root element, and
// the system appearance is a media query; all three are watched, and every
// diagram still on the page is redrawn when one moves.

function isDark(): boolean {
  const t = document.documentElement.dataset.theme
  if (t === 'dark') return true
  if (t === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

interface Look {
  dark: boolean
  font: string
  vars: Record<string, string>
}

/** Mermaid's `base` theme, fed from the app's own tokens. The base theme
 *  derives the rest of its palette from these with colour arithmetic, which is
 *  why the fills are opaque hex tokens of their own (`--diagram-*`) rather
 *  than the translucent `--surface` the code block sits on. */
function look(): Look {
  const css = getComputedStyle(document.documentElement)
  const tok = (name: string) => css.getPropertyValue(name).trim()
  // The document font. Settings stores an empty stack for the default
  // typeface, meaning "the UI font", so fall through the same way the
  // editor's own CSS does.
  const font = tok('--font-body') || tok('--font-ui') || '-apple-system, sans-serif'
  const bg = tok('--bg-elev') || tok('--bg')
  const fg = tok('--fg')
  const fg2 = tok('--fg-2')
  const fg3 = tok('--fg-3')
  const accent = tok('--accent')
  const fill = tok('--diagram-fill')
  const fill2 = tok('--diagram-fill-2')
  const stroke = tok('--diagram-stroke')
  const vars: Record<string, string> = {
    background: bg,
    fontFamily: font,
    fontSize: '14px',

    primaryColor: fill,
    primaryTextColor: fg,
    primaryBorderColor: stroke,
    secondaryColor: fill2,
    secondaryTextColor: fg,
    secondaryBorderColor: accent,
    tertiaryColor: bg,
    tertiaryTextColor: fg,
    tertiaryBorderColor: stroke,

    lineColor: fg2,
    textColor: fg,
    mainBkg: fill,
    nodeBorder: stroke,
    nodeTextColor: fg,
    clusterBkg: bg,
    clusterBorder: stroke,
    defaultLinkColor: fg2,
    titleColor: fg,
    edgeLabelBackground: fill,

    noteBkgColor: fill2,
    noteTextColor: fg,
    noteBorderColor: accent,

    // sequence diagrams
    actorBkg: fill,
    actorBorder: stroke,
    actorTextColor: fg,
    actorLineColor: fg3,
    signalColor: fg2,
    signalTextColor: fg,
    labelBoxBkgColor: fill,
    labelBoxBorderColor: stroke,
    labelTextColor: fg,
    loopTextColor: fg,
    activationBkgColor: fill2,
    activationBorderColor: accent,
    sequenceNumberColor: bg,

    errorBkgColor: fill,
    errorTextColor: fg,
  }
  return { dark: isDark(), font, vars }
}

let configuredFor: string | null = null

function configure(mermaid: Mermaid) {
  const l = look()
  const key = `${l.dark}|${l.font}`
  if (configuredFor === key) return
  configuredFor = key
  mermaid.initialize({
    startOnLoad: false,
    // No click handlers and no scripts; label HTML is sanitised by Mermaid
    // and again by Crepe's preview panel. A document is assembled by an
    // agent from sources nobody vetted; the picture must not be a way to
    // run anything.
    securityLevel: 'strict',
    // A failed render would otherwise paint Mermaid's own error graphic
    // into document.body. The error is shown in the block instead.
    suppressErrorRendering: true,
    theme: 'base',
    darkMode: l.dark,
    themeVariables: l.vars,
    fontFamily: l.font,
    // Mermaid 12 wraps flowchart labels at 120px, which breaks almost any
    // three-word label onto two lines. 220px holds about thirty characters.
    flowchart: { useMaxWidth: true, wrappingWidth: 220 },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
  })
}

let watching = false
function watchLook() {
  if (watching) return
  watching = true
  const onChange = () => {
    configuredFor = null
    redrawAll()
  }
  new MutationObserver(onChange).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-typeface'],
  })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onChange)
}

// ---- registry --------------------------------------------------------------
//
// Crepe gives each render a fresh `applyPreview` closure and no handle on the
// block, so the only way to redraw a diagram later is to keep the closure.
// Every drawing carries its id in a data attribute; a redraw covers the
// entries whose id is still in the DOM and forgets the rest. The map also
// grows by one per keystroke in a diagram source, so it is pruned the same
// way when it gets long.

interface Entry {
  text: string
  apply: Apply
}

const live = new Map<string, Entry>()
let seq = 0

function mounted(id: string): boolean {
  return document.querySelector(`[${ATTR}="${id}"]`) !== null
}

function prune() {
  for (const id of live.keys()) if (!mounted(id)) live.delete(id)
}

function redrawAll() {
  prune()
  for (const [id, e] of live) enqueue(() => draw(id, e.text, e.apply))
}

// ---- cache and resting height ----------------------------------------------
//
// Crepe tears a code block down once it has been off-screen for a few
// seconds, swapping the mounted block for a bare <pre> of the source, and
// mounts it again when it scrolls back. For a diagram that swap is a jump:
// the picture is several times taller than its source, so the document
// shrinks under the reader's scroll position (far enough that the view can
// end up past the end of the document and show nothing), and on the way back
// the block flashes "Drawing diagram" before the picture returns.
//
// Two things hold the height steady. Rendered markup is cached by look and
// source, so a block that mounts again gets its picture back synchronously,
// in the same tick the placeholder goes. And after every draw the block's
// resting height is written to a custom property on the block's own element,
// which outlives the teardown; the placeholder state reads it as a min-height
// (see sidenote.css).

const cache = new Map<string, string>()
const CACHE_MAX = 80

function cacheKey(text: string): string {
  const l = look()
  return `${l.dark}|${l.font}|${text}`
}

function remember(key: string, html: string) {
  cache.delete(key)
  cache.set(key, html)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
}

/** A cached drawing carries the id it was first drawn under; re-stamp it. */
function withId(html: string, id: string): string {
  return html.replace(new RegExp(`${ATTR}="\\d+"`), `${ATTR}="${id}"`)
}

/** Record the block's height while it shows the picture alone, so the
 *  placeholder that replaces it off-screen can keep the same height. Skipped
 *  while the source is showing, because that is not the resting state. */
function recordHeight(id: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`[${ATTR}="${id}"]`)
    const block = el?.closest<HTMLElement>('.milkdown-code-block')
    if (!el || !block) return
    const host = block.querySelector('.codemirror-host')
    if (host && !host.classList.contains('hidden')) return
    const h = Math.round(block.getBoundingClientRect().height)
    if (h > 0) block.style.setProperty('--sidenote-preview-h', `${h}px`)
  })
}

// ---- rendering -------------------------------------------------------------

/** One render at a time, in order. Typing in a diagram source asks for a
 *  render per keystroke; running them serially keeps the main thread
 *  responsive and means the last request is the last one applied. */
let chain: Promise<void> = Promise.resolve()
function enqueue(job: () => Promise<void>) {
  chain = chain.then(job, job)
}

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function errorPanel(id: string, message: string): string {
  // Mermaid's parse errors are a few lines: the line number, the offending
  // text, a caret under the fault, and what it expected. All of that helps.
  const lines = message.split('\n').filter((l) => l.trim()).slice(0, 6)
  const detail = lines.length ? lines.join('\n') : 'No detail from Mermaid.'
  return (
    `<div class="sidenote-diagram sidenote-diagram-error" ${ATTR}="${id}">` +
    `<span class="sidenote-diagram-error-title">Diagram did not render</span>` +
    `<pre>${escapeHtml(detail)}</pre></div>`
  )
}

/** The width the picture has to fit, from a code block on the page. */
function columnWidth(): number {
  const block = document.querySelector('.milkdown-code-block')
  return block ? Math.max(200, block.clientWidth - 48) : 560
}

/** Mermaid sizes a picture with `width: 100%; max-width: <natural>px`, so it
 *  shrinks to fit the block. Below MIN_SCALE that is unreadable: pin the
 *  natural width instead and let the block scroll. */
function fitOrScroll(svg: string): { svg: string; wide: boolean } {
  const m = /max-width:\s*([\d.]+)px/.exec(svg)
  if (!m) return { svg, wide: false }
  const natural = parseFloat(m[1])
  if (natural * MIN_SCALE <= columnWidth()) return { svg, wide: false }
  return { svg: svg.replace(m[0], `width: ${natural}px; max-width: none`), wide: true }
}

let renders = 0

async function draw(id: string, text: string, apply: Apply): Promise<void> {
  let html: string
  try {
    const mermaid = await loadMermaid()
    configure(mermaid)
    // Mermaid removes any element on the page that already carries the id
    // it is given, so a redraw must not reuse the mounted picture's id: it
    // would strip the old SVG, and if the new markup came out identical the
    // panel would see no change and stay empty. Every render gets its own.
    const { svg } = await mermaid.render(`sidenote-diagram-${id}-${++renders}`, text)
    const fit = fitOrScroll(svg)
    const cls = fit.wide ? 'sidenote-diagram sidenote-diagram-wide' : 'sidenote-diagram'
    html = `<div class="${cls}" ${ATTR}="${id}">${fit.svg}</div>`
    remember(cacheKey(text), html)
  } catch (e) {
    html = errorPanel(id, e instanceof Error ? e.message : String(e))
  }
  apply(html)
  recordHeight(id)
}

/** Crepe's `renderPreview`. Returns `null` for anything that is not a diagram
 *  (no preview, synchronously) and `undefined` for a diagram, which tells
 *  Crepe to wait for `apply`. */
export function renderDiagram(language: string, content: string, apply: Apply): void | null | string {
  if (!LANGUAGES.has(language.trim().toLowerCase())) return null
  watchLook()
  if (live.size > 64) prune()
  const id = String(++seq)
  live.set(id, { text: content, apply })
  const hit = cache.get(cacheKey(content))
  if (hit) {
    recordHeight(id)
    return withId(hit, id)
  }
  enqueue(() => draw(id, content, apply))
}

/** Shown while the first render (and the Mermaid import) is in flight. */
export const DIAGRAM_LOADING =
  '<div class="sidenote-diagram sidenote-diagram-loading">Drawing diagram…</div>'

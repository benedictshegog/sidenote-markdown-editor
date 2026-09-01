import { ipc } from '../ipc'

/** Schemes the webview can load on its own, and that the policy permits. */
const INLINE = /^(data|blob|asset):/i

/** The network. The content security policy refuses these, by decision — see
 *  `docs/decisions/2026-08-23-remote-images.md`. They are caught here so the
 *  reader gets a reason instead of a broken-image glyph. */
const NETWORK = /^https?:/i

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

function mimeOf(src: string): string {
  const ext = src.split(/[#?]/)[0].split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

/** Stands in for an image that could not be read.
 *
 *  The first version of this returned a transparent pixel, which left a tall
 *  blank gap: the reader could not tell a missing file from a deliberate
 *  space. An image the editor cannot show is worth saying out loud, so the
 *  stand-in is a drawn one, carrying the path that failed.
 *
 *  It is an SVG data URI rather than styling on the element because
 *  `proxyDomURL` hands back a URL and nothing else. Mid-grey on no fill so it
 *  sits correctly on the light and the dark theme alike. */
function placeholder(src: string, message = 'Image not found'): string {
  const label = src.length > 64 ? `…${src.slice(-63)}` : src
  const esc = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="112" viewBox="0 0 480 112">
<rect x="1" y="1" width="478" height="110" rx="8" fill="none" stroke="#8a8a8a" stroke-width="1.5" stroke-dasharray="5 4"/>
<text x="240" y="48" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="14" fill="#8a8a8a">${esc(message)}</text>
<text x="240" y="72" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, monospace" font-size="11" fill="#8a8a8a">${esc(label)}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Turns markdown image URLs into something the webview can load.
 *
 *  A document is a file on disk, so `![](shot.png)` means "beside this file".
 *  The webview instead resolves that against the app origin, where nothing
 *  lives. So local paths are read through the Rust side and handed back as
 *  blob URLs; remote and inline ones are passed straight through.
 *
 *  One resolver per open document. Blob URLs are cached by source path, both
 *  to avoid re-reading a file on every re-render and because each one has to
 *  be revoked by hand when the document closes. */
export class ImageResolver {
  private cache = new Map<string, Promise<string>>()
  private urls: string[] = []
  private docPath: () => string

  constructor(docPath: () => string) {
    this.docPath = docPath
  }

  resolve = (src: string): string | Promise<string> => {
    if (!src || INLINE.test(src)) return src
    // A remote image is a beacon: fetching it tells whoever wrote the URL that
    // this document was opened, and from where. The policy blocks it, so say
    // so rather than leaving a broken glyph the reader has to interpret.
    if (NETWORK.test(src)) return placeholder(src, 'Remote image blocked')
    const doc = this.docPath()
    if (!doc) return src

    // NUL joins the two halves: a path may hold any character except this
    // one, so no pair of (document, src) can collide with another.
    const key = `${doc}\u0000${src}`
    let hit = this.cache.get(key)
    if (!hit) {
      hit = this.load(doc, src)
      this.cache.set(key, hit)
    }
    return hit
  }

  private async load(doc: string, src: string): Promise<string> {
    try {
      const bytes = await ipc.readImage(doc, src)
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(src) }))
      this.urls.push(url)
      return url
    } catch (e) {
      void ipc.uiLog(`read_image ${src}: ${String(e)}`)
      return placeholder(src)
    }
  }

  /** Drop every blob URL. Call when the document closes or reloads. */
  dispose() {
    for (const u of this.urls) URL.revokeObjectURL(u)
    this.urls = []
    this.cache.clear()
  }
}

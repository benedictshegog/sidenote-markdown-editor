import { ipc } from "./ipc";

/** Hand a URL to the Rust side, which re-checks it against the window
 *  navigation guard before opening it in the user's browser. */
export function openExternally(href: string) {
  void ipc
    .openLink(href)
    .catch((err) => void ipc.uiLog(`open_link: ${String(err)}`));
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to
 *  hyphens. A `[see](#next-steps)` link written by an agent assumes this. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Room left above a heading scrolled to the top, so the pill does not sit
 *  on it. */
const SCROLL_GAP = 24;

/** Scroll the document so `el` sits at the top of its pane. */
export function scrollToHeading(el: HTMLElement, smooth = true) {
  const main = el.closest<HTMLElement>(".main");
  if (!main) return;
  const top =
    main.scrollTop +
    el.getBoundingClientRect().top -
    main.getBoundingClientRect().top -
    SCROLL_GAP;
  main.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
}

/** The heading in `root` that a `#fragment` names, by explicit id or by slug. */
function findHeading(root: ParentNode, fragment: string): HTMLElement | null {
  const want = slug(decodeURIComponent(fragment));
  for (const h of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    if (h.id === fragment || slug(h.textContent ?? "") === want) return h;
  }
  return null;
}

/**
 * No link ever loads inside the app. Installed once, in the capture phase,
 * ahead of every other handler.
 *
 * Inside an editable document a plain click places the caret, so nothing
 * opens: the link chip and ⌘-click are the ways to follow it there. A locked
 * document is not editable, and there WebKit would follow a plain click
 * itself. The Rust navigation guard sends web links to the browser, but a
 * relative link resolved against the app's own origin — and a `localhost`
 * link, which the guard took for the dev server — loaded in place and left
 * the window on a page with no way back. So every anchor is handled here:
 * fragments scroll to their heading, the rest go to the browser or nowhere.
 */
export function installLinkGuard() {
  const onClick = (event: MouseEvent) => {
    if (event.type === "auxclick" && event.button !== 1) return;
    const a = (event.target as Element | null)?.closest?.("a[href]");
    if (!a) return;
    event.preventDefault();
    const href = a.getAttribute("href") ?? "";
    const doc = a.closest<HTMLElement>(".ProseMirror");
    if (href.startsWith("#")) {
      const h = findHeading(doc ?? document, href.slice(1));
      if (h) scrollToHeading(h);
      return;
    }
    if (doc && !a.matches("a.link-display")) {
      // ⌘-click already opened it on mousedown (see Editor.tsx).
      if (event.metaKey) return;
      if (doc.isContentEditable) return;
    }
    openExternally(href);
  };
  document.addEventListener("click", onClick, true);
  // Middle click.
  document.addEventListener("auxclick", onClick, true);
}

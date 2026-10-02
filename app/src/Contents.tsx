import { useEffect, useState, type RefObject } from "react";
import { scrollToHeading } from "./links";

interface Heading {
  level: number;
  text: string;
  el: HTMLElement;
}

/** Deeper headings are left out: past H3 the list stops being an overview. */
const SELECTOR = ".ProseMirror h1, .ProseMirror h2, .ProseMirror h3";

/** How far below the top of the pane a heading still counts as "here". */
const ACTIVE_LINE = 48;

function sameHeadings(a: Heading[], b: Heading[]) {
  return (
    a.length === b.length &&
    a.every((h, i) => h.el === b[i].el && h.level === b[i].level && h.text === b[i].text)
  );
}

interface Props {
  /** The canvas the editor mounts into; watched for heading changes. */
  canvasRef: RefObject<HTMLDivElement | null>;
  /** The pane that scrolls. */
  mainRef: RefObject<HTMLElement | null>;
}

/**
 * The document's headings, in the empty column to the left of the text.
 *
 * With room, a quiet list of titles. Without it (a narrow window, or the
 * comment margin taking the space) the same list folds into a rail of short
 * ticks, one per heading, and opens as a card on hover. A container query on
 * the column picks between the two, so the switch follows the actual space
 * rather than the window size. The current section is marked in both, and
 * the list only appears for a document with two or more headings.
 *
 * Headings are read from the editor's DOM, not from the markdown: that is
 * what is on screen, it carries the elements to scroll to, and a mutation
 * observer keeps it current while someone types or Claude edits.
 */
export function Contents({ canvasRef, mainRef }: Props) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const next = [...canvas.querySelectorAll<HTMLElement>(SELECTOR)]
        .map((el) => ({
          level: Number(el.tagName[1]),
          text: (el.textContent ?? "").trim(),
          el,
        }))
        .filter((h) => h.text);
      setHeadings((prev) => (sameHeadings(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    const obs = new MutationObserver(schedule);
    obs.observe(canvas, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [canvasRef]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const list = headings;
      if (!list.length) return;
      const top = main.getBoundingClientRect().top + ACTIVE_LINE;
      let i = 0;
      // At the very bottom the last section may be too short to reach the
      // line; it is still the one being read.
      if (main.scrollTop + main.clientHeight >= main.scrollHeight - 2) {
        i = list.length - 1;
      } else {
        list.forEach((h, n) => {
          if (h.el.getBoundingClientRect().top <= top) i = n;
        });
      }
      setActive(i);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      main.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [mainRef, headings]);

  if (headings.length < 2) return <div className="toc-cell" />;
  const top = Math.min(...headings.map((h) => h.level));

  return (
    <div className="toc-cell">
      <nav className="toc" aria-label="Contents">
        <div className="toc-rail" aria-hidden="true">
          {headings.map((h, i) => (
            <span
              key={i}
              className={`toc-tick toc-l${h.level - top} ${i === active ? "is-active" : ""}`}
            />
          ))}
        </div>
        <ol className="toc-list">
          {headings.map((h, i) => (
            <li key={i}>
              <button
                type="button"
                className={`toc-item toc-l${h.level - top} ${i === active ? "is-active" : ""}`}
                title={h.text}
                onClick={() => {
                  scrollToHeading(h.el);
                  setActive(i);
                }}
              >
                {h.text}
              </button>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}

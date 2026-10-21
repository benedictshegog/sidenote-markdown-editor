// Comments in the margin, the way Google Docs lays them out: each card sits
// level with the text it is about, the active card is pinned to its anchor
// and the others are pushed apart to make room. Cards are absolutely
// positioned inside a column that scrolls with the document, so a comment
// and its highlight move together.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { DRAFT_ID } from '../editor/commentMark'
import { isUnread, type Suggestion, type SuggestionDecision, type Thread } from '../types'
import { OUTCOME_LABEL, anchorIdFor, groupSuggestions, ridesOnSuggestion } from './suggestionCards'

export interface Draft {
  quote: string
}

interface Props {
  threads: Thread[]
  unanchored: Set<string>
  selected: string | null
  showResolved: boolean
  draft: Draft | null
  /** Resolving is off while Claude holds the lock: it may be answering the
   *  thread right now. Comments and replies are never off; they live in
   *  threads.json, which the lock does not cover. */
  canResolve: boolean
  /** Contains the editor and this margin; anchors are measured against it. */
  canvasRef: RefObject<HTMLElement | null>
  /** Bumped whenever the document may have reflowed. */
  revision: number
  onSelect: (id: string | null) => void
  onSubmitDraft: (body: string) => void
  onCancelDraft: () => void
  /** Every keystroke in the draft, so the words survive if the draft is
   *  closed from outside (the text changed under it). */
  onDraftChange: (body: string) => void
  onReply: (id: string, body: string) => void
  onSetStatus: (id: string, status: 'open' | 'resolved') => void
  onRelocate: (id: string) => void
  canRelocate: boolean
  onToggleResolved: () => void
  /** Pending suggestions. Those attached to a thread ride on that thread's
   *  card; the rest get cards of their own. */
  suggestions: Suggestion[]
  selectedSuggestion: string | null
  onSelectSuggestion: (id: string | null) => void
  onDecide: (id: string, accept: boolean) => void
  /** The user replied on a suggestion that has no thread yet. */
  onReplySuggestion: (id: string, body: string) => void
}

const GAP = 10
const FALLBACK_HEIGHT = 96

export function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d} d ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const CLAUDE_PATH =
  'M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zm-2 10H6V7h12v12zm-9-6c-.83 0-1.5-.67-1.5-1.5S8.17 10 9 10s1.5.67 1.5 1.5S9.83 13 9 13zm7.5-1.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5.67-1.5 1.5-1.5 1.5.67 1.5 1.5zM8 15h8v2H8v-2z'
const PERSON_PATH =
  'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'

function Avatar({ author, small }: { author: 'user' | 'claude'; small?: boolean }) {
  const size = small ? 20 : 26
  return (
    <span className={`avatar avatar-${author} ${small ? 'avatar-sm' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62}>
        <path d={author === 'claude' ? CLAUDE_PATH : PERSON_PATH} />
      </svg>
    </span>
  )
}

function Composer({
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
  onChange,
  submitLabel,
}: {
  placeholder: string
  autoFocus?: boolean
  onSubmit: (body: string) => void
  onCancel?: () => void
  onChange?: (value: string) => void
  submitLabel: string
}) {
  const [value, setValue] = useState('')
  const [active, setActive] = useState(!!autoFocus)
  const ref = useRef<HTMLTextAreaElement>(null)

  // A draft card mounts at the top of its column and moves beside its text
  // once the anchors are measured, one render later. A plain focus() would
  // scroll the document to wherever the card is at that instant.
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true })
  }, [autoFocus])

  // Grow with the text instead of scrolling inside a fixed box.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(active ? 56 : 0, el.scrollHeight)}px`
  }, [value, active])

  const submit = () => {
    const body = value.trim()
    if (!body) return
    onSubmit(body)
    setValue('')
    onChange?.('')
    setActive(!!autoFocus)
  }

  const cancel = () => {
    setValue('')
    onChange?.('')
    setActive(!!autoFocus)
    if (onCancel) onCancel()
    else ref.current?.blur()
  }

  return (
    <div className={`composer ${active ? 'is-active' : ''}`} onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder={placeholder}
        onFocus={() => setActive(true)}
        onBlur={() => {
          if (!value.trim() && !autoFocus) setActive(false)
        }}
        onChange={(e) => {
          setValue(e.target.value)
          onChange?.(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
      />
      {active && (
        <div className="composer-actions">
          <button className="btn-accent btn-pill" onClick={submit} type="button" disabled={!value.trim()}>
            {submitLabel}
          </button>
          <button className="btn-quiet btn-pill" onClick={cancel} type="button">
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

function ResolveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm4.59-12.42L10 14.17l-2.59-2.58L6 13l4 4 8-8z" />
    </svg>
  )
}

/** The decision, and only the decision. What the edit actually says is drawn
 *  in the prose itself, where the reader can judge it in context — repeating
 *  it here would make them read the same change twice and compare. */
function Decide({
  suggestion,
  onDecide,
  showTime,
}: {
  suggestion: Suggestion
  onDecide: (accept: boolean) => void
  /** On a card with no thread there is no message to carry the time. */
  showTime?: boolean
}) {
  const { removed, added } = suggestion
  return (
    <div className="sug-decide">
      <div className="sug-decide-head">
        <span className="sug-badge">Suggested edit</span>
        {(removed > 0 || added > 0) && (
          <span className="sug-counts">
            {removed > 0 && <span className="sug-out">−{removed}</span>}
            {removed > 0 && added > 0 && ' '}
            {added > 0 && <span className="sug-in">+{added}</span>} words
          </span>
        )}
        {showTime && <span className="sug-time">{relativeTime(suggestion.at)}</span>}
      </div>
      <div className="sug-actions">
        <button
          type="button"
          className="btn-accent sug-accept"
          onClick={(e) => {
            e.stopPropagation()
            onDecide(true)
          }}
        >
          Accept
        </button>
        <button
          type="button"
          className="btn-quiet sug-reject"
          onClick={(e) => {
            e.stopPropagation()
            onDecide(false)
          }}
        >
          Reject
        </button>
      </div>
    </div>
  )
}

/** A suggestion with no thread: Claude proposed it without a reason. It gets
 *  a card because there is no thread to hang it from, and a reply box, whose
 *  first message starts the suggestion's thread. */
function SuggestionCard({
  suggestion,
  top,
  active,
  measured,
  register,
  onSelect,
  onDecide,
  onReply,
}: {
  suggestion: Suggestion
  top: number
  active: boolean
  measured: boolean
  register: (id: string, el: HTMLElement | null) => void
  onSelect: () => void
  onDecide: (accept: boolean) => void
  onReply: (body: string) => void
}) {
  const refCb = useCallback((el: HTMLElement | null) => register(suggestion.id, el), [register, suggestion.id])
  const cls = ['ccard', 'is-suggestion', active ? 'is-active' : '', measured ? 'is-measured' : ''].join(' ')
  return (
    <div
      ref={refCb}
      className={cls}
      style={{ top }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      <Decide suggestion={suggestion} onDecide={onDecide} showTime />
      {active && (
        <div className="ccard-reply">
          <Avatar author="user" small />
          <Composer placeholder="Reply" onSubmit={onReply} submitLabel="Reply" />
        </div>
      )}
    </div>
  )
}

/** What became of the suggestions a thread carried, on its resolved card. */
function History({ decisions }: { decisions: SuggestionDecision[] }) {
  return (
    <div className="sug-history">
      {decisions.map((d, i) => (
        <div key={i} className="sug-history-row">
          <span className={`sug-history-label is-${d.outcome}`}>{OUTCOME_LABEL[d.outcome]}</span>
          <span className="sug-history-text">
            {d.old && <del>{d.old}</del>}
            {d.old && d.new && ' '}
            {d.new && <ins>{d.new}</ins>}
          </span>
        </div>
      ))}
    </div>
  )
}

interface Placed {
  id: string
  anchor: number | null
}

/** Card tops from anchors and heights. The active card sits on its anchor;
 *  cards above it are pushed up and cards below are pushed down, only as far
 *  as they need to go. Without an active card every card sits at its anchor
 *  unless the one above overlaps it. Cards with no anchor queue at the end. */
function layout(items: Placed[], heights: Map<string, number>, activeId: string | null): Map<string, number> {
  const h = (id: string) => heights.get(id) ?? FALLBACK_HEIGHT
  const anchored = items.filter((i): i is { id: string; anchor: number } => i.anchor !== null)
  const orphans = items.filter((i) => i.anchor === null)
  const tops = new Map<string, number>()

  const sel = anchored.findIndex((i) => i.id === activeId)
  if (sel >= 0) {
    tops.set(anchored[sel].id, anchored[sel].anchor)
    let limit = anchored[sel].anchor
    for (let i = sel - 1; i >= 0; i--) {
      const t = Math.min(anchored[i].anchor, limit - GAP - h(anchored[i].id))
      tops.set(anchored[i].id, t)
      limit = t
    }
    let bottom = anchored[sel].anchor + h(anchored[sel].id)
    for (let i = sel + 1; i < anchored.length; i++) {
      const t = Math.max(anchored[i].anchor, bottom + GAP)
      tops.set(anchored[i].id, t)
      bottom = t + h(anchored[i].id)
    }
  } else {
    let bottom = -GAP
    for (const i of anchored) {
      const t = Math.max(i.anchor, bottom + GAP)
      tops.set(i.id, t)
      bottom = t + h(i.id)
    }
  }

  // A run pushed above the top of the column comes back down as one block.
  let min = 0
  for (const t of tops.values()) min = Math.min(min, t)
  if (min < 0) {
    for (const [id, t] of tops) tops.set(id, t - min)
  }

  let bottom = -GAP
  for (const [id, t] of tops) bottom = Math.max(bottom, t + h(id))
  for (const o of orphans) {
    const t = bottom + GAP
    tops.set(o.id, t)
    bottom = t + h(o.id)
  }
  return tops
}

function Card({
  thread,
  top,
  orphaned,
  active,
  canResolve,
  measured,
  register,
  onSelect,
  onReply,
  onSetStatus,
  onRelocate,
  canRelocate,
  suggestions,
  onDecide,
}: {
  thread: Thread
  top: number
  orphaned: boolean
  active: boolean
  canResolve: boolean
  measured: boolean
  register: (id: string, el: HTMLElement | null) => void
  onSelect: () => void
  onReply: (body: string) => void
  onSetStatus: (status: 'open' | 'resolved') => void
  onRelocate: () => void
  canRelocate: boolean
  /** The edits Claude is proposing on this thread, if any. */
  suggestions: Suggestion[]
  onDecide: (id: string, accept: boolean) => void
}) {
  const resolved = thread.status === 'resolved'
  const decisions = thread.decisions ?? []
  // A decided card says how, where a resolved one says "Resolved".
  const outcome = resolved && decisions.length > 0 ? decisions[decisions.length - 1].outcome : null
  const [first, ...rest] = thread.messages
  // Stable, or React re-runs it (null, then the element) on every render.
  const refCb = useCallback((el: HTMLElement | null) => register(thread.id, el), [register, thread.id])
  const replies = active ? rest : []
  const cls = [
    'ccard',
    active ? 'is-active' : '',
    resolved ? 'is-resolved' : '',
    orphaned ? 'is-orphan' : '',
    measured ? 'is-measured' : '',
  ].join(' ')

  return (
    <div
      ref={refCb}
      className={cls}
      style={{ top }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      {/* The decision first: it is what the card asks of the reader, and the
          thread under it is the why. */}
      {!resolved &&
        suggestions.map((sg) => <Decide key={sg.id} suggestion={sg} onDecide={(a) => onDecide(sg.id, a)} />)}
      {first && (
        <div className="cmsg">
          <div className="cmsg-head">
            <Avatar author={first.author} />
            <div className="cmsg-who">
              <span className="cmsg-name">{first.author === 'claude' ? 'Claude' : 'You'}</span>
              <span className="cmsg-time">
                {relativeTime(first.at)}
                {outcome ? ` · ${OUTCOME_LABEL[outcome].split(':')[0]}` : resolved ? ' · Resolved' : ''}
              </span>
            </div>
            <div className="cmsg-tools">
              {isUnread(thread) && !active && (
                <span className="ccard-unread" title="Claude has replied since you last opened this" />
              )}
              {!resolved && canResolve && suggestions.length === 0 && (
                <button
                  type="button"
                  className="ccard-resolve"
                  title="Mark as resolved and hide"
                  aria-label="Resolve"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSetStatus('resolved')
                  }}
                >
                  <ResolveIcon />
                </button>
              )}
            </div>
          </div>
          {(orphaned || resolved) && decisions.length === 0 && (
            <div className="ccard-quote">{thread.selector.exact}</div>
          )}
          {resolved && decisions.length > 0 && <History decisions={decisions} />}
          {orphaned && !resolved && (
            <div className="ccard-orphan">
              The quoted text was not found.{' '}
              {canRelocate ? (
                <button
                  type="button"
                  className="btn-link"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRelocate()
                  }}
                >
                  Attach to selection
                </button>
              ) : (
                <span>Select text, then attach it.</span>
              )}
            </div>
          )}
          <div className={`cmsg-body ${active ? '' : 'is-clamped'}`}>{first.body}</div>
        </div>
      )}
      {!active && rest.length > 0 && !thread.working && (
        <div className="ccard-more">{rest.length === 1 ? '1 reply' : `${rest.length} replies`}</div>
      )}
      {replies.map((m, i) => (
        <div key={i} className="cmsg cmsg-reply">
          <div className="cmsg-head">
            <Avatar author={m.author} small />
            <div className="cmsg-who">
              <span className="cmsg-name">{m.author === 'claude' ? 'Claude' : 'You'}</span>
              <span className="cmsg-time">{relativeTime(m.at)}</span>
            </div>
          </div>
          <div className="cmsg-body">{m.body}</div>
        </div>
      ))}
      {thread.working && !resolved && (
        <div className="cmsg cmsg-reply cmsg-typing">
          <div className="cmsg-head">
            <Avatar author="claude" small />
            <div className="cmsg-who">
              <span className="cmsg-name">Claude</span>
            </div>
          </div>
          <div className="cmsg-body">
            <span className="typing" role="status" aria-label="Claude is writing a reply">
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      )}
      {active && !resolved && (
        <div className="ccard-reply">
          <Avatar author="user" small />
          <Composer placeholder="Reply" onSubmit={onReply} submitLabel="Reply" />
        </div>
      )}
      {active && resolved && (
        <div className="ccard-foot">
          <button
            type="button"
            className="btn-quiet btn-pill"
            onClick={(e) => {
              e.stopPropagation()
              onSetStatus('open')
            }}
          >
            Re-open
          </button>
        </div>
      )}
    </div>
  )
}

export function CommentMargin(props: Props) {
  const { threads, unanchored, selected, showResolved, draft, canvasRef, revision } = props
  void props.onToggleResolved
  const [anchors, setAnchors] = useState<Map<string, number>>(new Map())
  const [heights, setHeights] = useState<Map<string, number>>(new Map())
  const cards = useRef(new Map<string, HTMLElement>())
  const observer = useRef<ResizeObserver | null>(null)

  const { suggestions, selectedSuggestion } = props

  const visible = useMemo(
    () => threads.filter((t) => showResolved || t.status !== 'resolved'),
    [threads, showResolved],
  )

  // A suggestion with a thread belongs on that thread's card; the rest stand
  // alone. Split once, so both the layout and the render agree.
  const { byThread, loose } = useMemo(() => groupSuggestions(suggestions, threads), [suggestions, threads])

  // Where each highlight starts, relative to the canvas. The canvas scrolls as
  // one piece with the margin, so the offset holds at any scroll position.
  const measure = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const base = canvas.getBoundingClientRect().top
    const next = new Map<string, number>()
    canvas.querySelectorAll<HTMLElement>('.sidenote-editor [data-comment-id]').forEach((el) => {
      const id = el.dataset.commentId
      if (!id || next.has(id)) return
      next.set(id, Math.round(el.getBoundingClientRect().top - base))
    })
    // Suggestion ids (`s1`) and thread ids (`c1`) share this map. They cannot
    // collide, and sharing it means one measuring pass places both kinds of
    // card in one ordering.
    canvas.querySelectorAll<HTMLElement>('.sidenote-editor [data-suggestion-id]').forEach((el) => {
      const id = el.dataset.suggestionId
      if (!id || next.has(id)) return
      next.set(id, Math.round(el.getBoundingClientRect().top - base))
    })
    setAnchors((prev) => {
      if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev
      return next
    })
  }, [canvasRef])

  // `revision` moves on every keystroke, and `measure` reads a bounding box
  // for every highlight, which forces a synchronous reflow. Coalescing to one
  // animation frame keeps typing off that path while still measuring before
  // the browser paints.
  const frame = useRef<number | null>(null)
  const scheduleMeasure = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      measure()
    })
  }, [measure])

  useLayoutEffect(() => {
    scheduleMeasure()
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
  }, [scheduleMeasure, threads, draft, revision, unanchored, showResolved, props.suggestions])

  // Reflow that does not come through props: the window resizing, a font
  // loading, an image arriving, a code block folding.
  useEffect(() => {
    const canvas = canvasRef.current
    const editor = canvas?.querySelector('.sidenote-editor')
    if (!editor) return
    const ro = new ResizeObserver(() => scheduleMeasure())
    ro.observe(editor)
    return () => ro.disconnect()
  }, [canvasRef, scheduleMeasure, threads.length])

  // Card heights, kept current by one observer shared by every card.
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let next: Map<string, number> | null = null
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.cardId
          if (!id) continue
          const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight)
          if (prev.get(id) === h) continue
          if (!next) next = new Map(prev)
          next.set(id, h)
        }
        return next ?? prev
      })
    })
    observer.current = ro
    for (const el of cards.current.values()) ro.observe(el)
    return () => {
      ro.disconnect()
      observer.current = null
    }
  }, [])

  // Runs during commit, so it must not set state; observe() reports the
  // initial size through the observer, which sets the height from there. A
  // stale entry for an unmounted card is harmless: layout only reads ids it
  // is given.
  const register = useCallback((id: string, el: HTMLElement | null) => {
    const prev = cards.current.get(id)
    if (prev === el) return
    if (prev) observer.current?.unobserve(prev)
    if (el) {
      el.dataset.cardId = id
      cards.current.set(id, el)
      observer.current?.observe(el)
    } else {
      cards.current.delete(id)
    }
  }, [])
  const registerDraft = useCallback((el: HTMLElement | null) => register(DRAFT_ID, el), [register])

  const tops = useMemo(() => {
    const byPosition = (a: Thread, b: Thread) => {
      const aa = anchors.get(a.id)
      const ab = anchors.get(b.id)
      if (aa !== undefined && ab !== undefined && aa !== ab) return aa - ab
      const sa = a.selector.start ?? Number.MAX_SAFE_INTEGER
      const sb = b.selector.start ?? Number.MAX_SAFE_INTEGER
      if (sa !== sb) return sa - sb
      return a.created_at.localeCompare(b.created_at)
    }
    // Open comments first, in document order, then resolved ones, which have
    // no highlight and so queue at the end.
    const items: Placed[] = [...visible]
      .filter((t) => t.status !== 'resolved')
      .sort(byPosition)
      .map((t) => {
        // A thread riding on a pending suggestion has no highlight of its
        // own; its card sits where the suggestion is drawn.
        if (ridesOnSuggestion(t, suggestions)) {
          return { id: t.id, anchor: anchors.get(anchorIdFor(t, byThread)) ?? null }
        }
        const orphan = t.status === 'orphaned' || unanchored.has(t.id)
        return { id: t.id, anchor: orphan ? null : (anchors.get(t.id) ?? null) }
      })

    // The draft belongs where its highlight is. `layout` reads this list as
    // document order and pushes everything after the active card downwards,
    // so putting the draft at the head made every card above it count as
    // below it: the whole margin dropped while you typed and snapped back the
    // moment you saved.
    if (draft) {
      const anchor = anchors.get(DRAFT_ID) ?? null
      const after = anchor === null ? -1 : items.findIndex((i) => i.anchor !== null && i.anchor > anchor)
      items.splice(after === -1 ? items.length : after, 0, { id: DRAFT_ID, anchor })
    }

    // Suggestions with no thread need a place of their own. Insert each at
    // its own anchor so it lands in document order among the comments rather
    // than in a block at the end.
    for (const sg of loose) {
      const anchor = anchors.get(sg.id) ?? null
      const after = anchor === null ? -1 : items.findIndex((i) => i.anchor !== null && i.anchor > anchor)
      items.splice(after === -1 ? items.length : after, 0, { id: sg.id, anchor })
    }

    for (const t of [...visible].filter((t) => t.status === 'resolved').sort(byPosition)) {
      items.push({ id: t.id, anchor: null })
    }
    // A selected suggestion that rides on a thread card is that card.
    const looseSel = selectedSuggestion && loose.some((sg) => sg.id === selectedSuggestion) ? selectedSuggestion : null
    const active = draft ? DRAFT_ID : (looseSel ?? selected)
    return layout(items, heights, active)
  }, [visible, anchors, heights, draft, selected, unanchored, loose, selectedSuggestion, suggestions, byThread])

  let columnHeight = 0
  for (const [id, t] of tops) columnHeight = Math.max(columnHeight, t + (heights.get(id) ?? FALLBACK_HEIGHT))

  return (
    <div
      className="margin"
      onClick={() => {
        props.onSelect(null)
        props.onSelectSuggestion(null)
      }}
    >
      <div className="margin-track" style={{ minHeight: columnHeight + 40 }}>
        {draft && (
          <div
            ref={registerDraft}
            className={`ccard is-active is-draft ${heights.has(DRAFT_ID) ? 'is-measured' : ''}`}
            style={{ top: tops.get(DRAFT_ID) ?? 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cmsg">
              <div className="cmsg-head">
                <Avatar author="user" />
                <div className="cmsg-who">
                  <span className="cmsg-name">You</span>
                </div>
              </div>
              <Composer
                placeholder="Comment"
                autoFocus
                submitLabel="Comment"
                onSubmit={props.onSubmitDraft}
                onCancel={props.onCancelDraft}
                onChange={props.onDraftChange}
              />
            </div>
          </div>
        )}
        {visible.map((t) => (
          <Card
            key={t.id}
            thread={t}
            top={tops.get(t.id) ?? 0}
            orphaned={
              !ridesOnSuggestion(t, suggestions) && (t.status === 'orphaned' || unanchored.has(t.id))
            }
            active={selected === t.id && !draft}
            canResolve={props.canResolve}
            measured={heights.has(t.id)}
            register={register}
            onSelect={() => {
              props.onSelect(t.id)
              props.onSelectSuggestion(byThread.get(t.id)?.[0]?.id ?? null)
            }}
            onReply={(body) => props.onReply(t.id, body)}
            onSetStatus={(s) => props.onSetStatus(t.id, s)}
            onRelocate={() => props.onRelocate(t.id)}
            canRelocate={props.canRelocate}
            suggestions={byThread.get(t.id) ?? []}
            onDecide={props.onDecide}
          />
        ))}
        {loose.map((sg) => (
          <SuggestionCard
            key={sg.id}
            suggestion={sg}
            top={tops.get(sg.id) ?? 0}
            active={selectedSuggestion === sg.id && !draft}
            measured={heights.has(sg.id)}
            register={register}
            onSelect={() => {
              props.onSelect(null)
              props.onSelectSuggestion(sg.id)
            }}
            onDecide={(accept) => props.onDecide(sg.id, accept)}
            onReply={(body) => props.onReplySuggestion(sg.id, body)}
          />
        ))}
      </div>
    </div>
  )
}

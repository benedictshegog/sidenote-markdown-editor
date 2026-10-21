// How suggestions and threads share the margin: one card per suggestion, and
// the thread that carries it on the same card. Pure, so the rules can be
// tested without an editor.

import type { Outcome, Suggestion, Thread } from '../types'

export interface Grouped {
  /** Pending suggestions by the thread whose card carries them. */
  byThread: Map<string, Suggestion[]>
  /** Suggestions with no thread (or one that is gone): cards of their own. */
  loose: Suggestion[]
}

export function groupSuggestions(suggestions: Suggestion[], threads: Thread[]): Grouped {
  const ids = new Set(threads.map((t) => t.id))
  const byThread = new Map<string, Suggestion[]>()
  const loose: Suggestion[] = []
  for (const sg of suggestions) {
    if (sg.thread && ids.has(sg.thread)) {
      const list = byThread.get(sg.thread)
      if (list) list.push(sg)
      else byThread.set(sg.thread, [sg])
    } else {
      loose.push(sg)
    }
  }
  return { byThread, loose }
}

/** A thread started for a suggestion that is still pending. It has no comment
 *  highlight of its own — the suggestion already marks the passage, and a
 *  second tint over struck text reads as noise — so its card sits where the
 *  suggestion is drawn. */
export function ridesOnSuggestion(t: Thread, suggestions: Suggestion[]): boolean {
  return !!t.for_suggestion && t.status !== 'resolved' && suggestions.some((s) => s.thread === t.id)
}

/** The threads the editor should paint as comment highlights. */
export function paintable(threads: Thread[], suggestions: Suggestion[]): Thread[] {
  return threads.filter((t) => !ridesOnSuggestion(t, suggestions))
}

/** Which measured anchor places a thread's card: its own highlight, or, for a
 *  thread riding on a suggestion, the first suggestion it carries. */
export function anchorIdFor(t: Thread, byThread: Map<string, Suggestion[]>): string {
  const sugs = byThread.get(t.id)
  return t.for_suggestion && sugs && sugs.length > 0 ? sugs[0].id : t.id
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  dropped: 'Dropped: you rewrote the passage',
  revised: 'Replaced by a new version',
}

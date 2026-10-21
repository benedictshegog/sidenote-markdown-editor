import { describe, expect, it } from 'vitest'
import type { Suggestion, Thread } from '../types'
import { anchorIdFor, groupSuggestions, paintable, ridesOnSuggestion } from './suggestionCards'

const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id,
  status: 'open',
  selector: { exact: 'x', prefix: '', suffix: '' },
  created_at: '2026-10-21T10:00:00Z',
  messages: [{ author: 'claude', at: '2026-10-21T10:00:00Z', body: 'why' }],
  ...extra,
})

const sug = (id: string, thread: string | null): Suggestion => ({
  id,
  thread,
  session: 'sid',
  at: '2026-10-21T10:00:00Z',
  quote: 'old',
  markdown: 'new',
  segs: [],
  removed: 1,
  added: 1,
})

describe('groupSuggestions', () => {
  it('keeps every suggestion on a thread, not only the last', () => {
    const { byThread, loose } = groupSuggestions([sug('s1', 'c1'), sug('s2', 'c1')], [thread('c1')])
    expect(byThread.get('c1')?.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(loose).toEqual([])
  })

  it('gives a suggestion with no thread, or a missing one, a card of its own', () => {
    const { byThread, loose } = groupSuggestions([sug('s1', null), sug('s2', 'c9')], [thread('c1')])
    expect(byThread.size).toBe(0)
    expect(loose.map((s) => s.id)).toEqual(['s1', 's2'])
  })
})

describe('a thread started for a suggestion', () => {
  const own = thread('c2', { for_suggestion: true })
  const comment = thread('c1')

  it('paints no comment highlight while its suggestion is pending', () => {
    const pending = [sug('s1', 'c2'), sug('s2', 'c1')]
    expect(ridesOnSuggestion(own, pending)).toBe(true)
    expect(ridesOnSuggestion(comment, pending)).toBe(false)
    expect(paintable([comment, own], pending).map((t) => t.id)).toEqual(['c1'])
  })

  it('is painted again once nothing is pending on it', () => {
    expect(paintable([own], []).map((t) => t.id)).toEqual(['c2'])
  })

  it('is placed by its suggestion; a comment keeps its own highlight', () => {
    const { byThread } = groupSuggestions([sug('s1', 'c2'), sug('s2', 'c1')], [comment, own])
    expect(anchorIdFor(own, byThread)).toBe('s1')
    expect(anchorIdFor(comment, byThread)).toBe('c1')
  })
})

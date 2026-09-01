// The comment highlight. A ProseMirror mark that exists only in memory: the
// serialiser runner returns false, so the text serialises without a
// wrapper and nothing reaches the markdown file.

import { $markSchema } from '@milkdown/kit/utils'

export const DRAFT_ID = '__draft__'

export const commentMark = $markSchema('comment', () => ({
  attrs: { id: { default: '' } },
  inclusive: false,
  // Allow two different comments on overlapping text.
  excludes: '',
  parseDOM: [
    {
      tag: 'span[data-comment-id]',
      getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute('data-comment-id') ?? '' }),
    },
  ],
  toDOM: (mark) => [
    'span',
    {
      'data-comment-id': mark.attrs.id,
      class: mark.attrs.id === DRAFT_ID ? 'sidenote-comment sidenote-comment-draft' : 'sidenote-comment',
    },
    0,
  ],
  parseMarkdown: {
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'comment',
    runner: () => false,
  },
}))

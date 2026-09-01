import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// Crepe defaults to One Dark, which keeps its dark foreground in light mode
// (#abb2bf on near-white is about 2:1). Everything here reads from the theme
// tokens in sidenote.css instead, so one theme serves light and dark and the
// colours change with the rest of the app.

const syntax = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword], color: 'var(--code-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--code-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--code-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.macroName], color: 'var(--code-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--code-property)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--code-punctuation)' },
  { tag: [t.tagName], color: 'var(--code-keyword)' },
  { tag: [t.variableName], color: 'var(--code-fg)' },
  { tag: [t.invalid], color: 'var(--code-invalid)' },
  { tag: [t.link, t.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [t.heading], color: 'var(--code-keyword)', fontWeight: 'bold' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
])

const view = EditorView.theme({
  '&': {
    color: 'var(--code-fg)',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--fg-3)',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--surface-2)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--accent-tint)',
    outline: '1px solid var(--accent-underline)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--accent-tint-strong)',
  },
})

export const codeTheme: Extension = [view, syntaxHighlighting(syntax)]

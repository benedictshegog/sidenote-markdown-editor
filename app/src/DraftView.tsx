import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'

import { Editor, type EditorHandle } from './editor/Editor'

export const UNTITLED = 'Untitled'

/** What the shell can ask an unsaved document to do. */
export interface DraftActions {
  /** Handle a document-scoped menu id. Returns false when not handled. */
  menu(id: string): Promise<boolean>
  /** The text as it stands, for Save. */
  getMarkdown(): string
  focus(): void
}

interface Props {
  active: boolean
  /** The tab's title, or whether there is anything to save, changed. */
  onState: (s: { title: string; dirty: boolean }) => void
  onSave: () => void
  onToast: (t: string) => void
}

/** The title the store will give the file once it exists: its first ATX
 *  heading. Mirrors `title_of` in the core, less the fallback to the file
 *  stem, because there is no file yet. */
export function draftTitle(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const t = line.trimStart()
    if (!t.startsWith('#')) continue
    const rest = t.replace(/^#+/, '').trim()
    // Backslash escapes come out (`C\&I` -> `C&I`), as the core does.
    if (rest) return rest.replace(/\\([!-/:-@[-`{-~])/g, '$1')
  }
  return UNTITLED
}

/**
 * A document that has no file yet.
 *
 * New Document opens one of these rather than a `DocumentView`: everything
 * that view does beyond editing — comments, versions, the session dot, the
 * lock, the watcher — hangs off a path in `~/.sidenote`, and there is none
 * until Save names one. So this is the editor alone, with a line above it
 * saying so. Saving swaps the tab for a `DocumentView` on the new file.
 */
export const DraftView = forwardRef<DraftActions, Props>(function DraftView(
  { active, onState, onSave, onToast },
  ref,
) {
  const editor = useRef<EditorHandle>(null)
  const markdown = useRef('')
  const last = useRef({ title: UNTITLED, dirty: false })

  const onChange = useCallback(
    (md: string) => {
      markdown.current = md
      const next = { title: draftTitle(md), dirty: md.trim() !== '' }
      if (next.title === last.current.title && next.dirty === last.current.dirty) return
      last.current = next
      onState(next)
    },
    [onState],
  )

  useImperativeHandle(
    ref,
    () => ({
      menu: async (id: string) => {
        switch (id) {
          case 'undo':
            editor.current?.undo()
            return true
          case 'redo':
            editor.current?.redo()
            return true
          case 'comment':
            onToast('Save the document first; comments need a file.')
            return true
        }
        return false
      },
      getMarkdown: () => editor.current?.getMarkdown() ?? markdown.current,
      focus: () => editor.current?.focus(),
    }),
    [onToast],
  )

  return (
    <div className="docview" hidden={!active}>
      <main className="main">
        <div className="canvas">
          <div className="doc">
            {/* Stands where the path line stands once there is a path. */}
            <div className="draft-note">
              <span>Not saved yet</span>
              <button type="button" className="btn-link" onClick={onSave}>
                Save… (⌘S)
              </button>
            </div>
            <Editor
              ref={editor}
              initialMarkdown=""
              docPath=""
              onChange={onChange}
              onMarkClick={() => {}}
              onSuggestionClick={() => {}}
              onRequestComment={() => onToast('Save the document first; comments need a file.')}
              onSelectionChange={() => {}}
              // Start writing at once: the cursor is in the page as soon as
              // the editor exists.
              onReady={() => editor.current?.focus()}
              readonly={false}
            />
          </div>
        </div>
      </main>
    </div>
  )
})

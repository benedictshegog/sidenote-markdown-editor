import { useEffect, useState } from 'react'

import { ipc } from './ipc'
import type { NetworkShare } from './types'

interface Props {
  onOpen: (url: string) => Promise<void>
  onClose: () => void
}

/** Open a document another Sidenote shares on this network (dev builds).
 *  Lists what Bonjour has found, and takes a pasted link for the rest. */
export function Network({ onOpen, onClose }: Props) {
  const [shares, setShares] = useState<NetworkShare[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const tick = async () => {
      const list = await ipc.networkShares().catch(() => [])
      if (live) setShares(list)
    }
    void tick()
    const t = window.setInterval(() => void tick(), 2000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [])

  const open = async (target: string) => {
    if (!target.trim()) return
    setBusy(target)
    setError(null)
    try {
      await onOpen(target.trim())
      onClose()
    } catch (e) {
      setError(`${e}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="sheet" role="dialog" aria-label="Open from Network" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Open from Network</h2>
          <button type="button" className="btn-quiet" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="sheet-body">
          <section className="pref">
            <div className="pref-label">Shared nearby</div>
            {shares.length === 0 ? (
              <div className="net-empty">Nothing yet. Share a document from Sidenote on another Mac, or paste its link below.</div>
            ) : (
              <ul className="net-list">
                {shares.map((s) => (
                  <li key={s.fullname}>
                    <button type="button" className="net-item" disabled={busy !== null} onClick={() => void open(s.url)}>
                      <span className="net-title">{s.title}</span>
                      <span className="net-host">
                        {s.host}:{s.port}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="pref">
            <div className="pref-label">Link</div>
            <form
              className="net-form"
              onSubmit={(e) => {
                e.preventDefault()
                void open(url)
              }}
            >
              <input
                className="net-input"
                placeholder="http://10.0.0.5:47394/d/abcd1234"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                spellCheck={false}
                autoFocus
              />
              <button type="submit" className="btn-quiet" disabled={busy !== null || !url.trim()}>
                Open
              </button>
            </form>
            {busy && <div className="net-status">Connecting… the other Mac may ask to allow this one.</div>}
            {error && <div className="net-error">{error}</div>}
          </section>
        </div>
      </div>
    </div>
  )
}

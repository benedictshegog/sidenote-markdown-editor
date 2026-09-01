import { useState } from 'react'
import { message } from '@tauri-apps/plugin-dialog'
import { ipc } from './ipc'
import type { UpdateStatus } from './types'

const SEEN_KEY = 'sidenote.updateSeen'

/** A version the user has already waved away. Dismissal is per version, so
 *  the next release asks again but this one does not. */
export function dismissed(version: string) {
  return localStorage.getItem(SEEN_KEY) === version
}

export function dismiss(version: string) {
  localStorage.setItem(SEEN_KEY, version)
}

/** "just now" / "3 hours ago" — enough to tell a stale check from a fresh one. */
export function checkedAgo(at?: number | null): string {
  if (!at) return 'never'
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - at)
  if (secs < 90) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  return `${Math.round(hours / 24)} days ago`
}

interface Props {
  status: UpdateStatus
  onDismiss: () => void
  /** Flush open documents, then hand over to Homebrew. The app quits. */
  onUpdate: () => Promise<void>
}

/** Offer for a newer release. Homebrew owns the install, so the action is
 *  either "let it run brew" or, for a hand-installed copy, "here is the file". */
export function UpdateBar({ status, onDismiss, onUpdate }: Props) {
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    try {
      await onUpdate()
    } catch (err) {
      setBusy(false)
      await message(`${err}`, { title: 'Update failed', kind: 'error' })
    }
  }

  const download = async () => {
    if (status.url) await ipc.openLink(status.url).catch(() => {})
    onDismiss()
  }

  return (
    <div className="update-bar" role="status">
      <div className="update-text">
        <span className="update-title">Sidenote {status.latest} is available</span>
        <span className="update-sub">
          {busy
            ? 'Homebrew is installing it. Sidenote will quit and reopen.'
            : status.managed
              ? `You have ${status.current}. Homebrew installs it and reopens Sidenote.`
              : `You have ${status.current}. This copy did not come from Homebrew.`}
        </span>
      </div>
      <div className="update-actions">
        <button type="button" className="btn-quiet" onClick={onDismiss} disabled={busy}>
          Later
        </button>
        {status.managed ? (
          <button type="button" className="btn-accent" onClick={() => void run()} disabled={busy}>
            {busy ? 'Updating…' : 'Update and Relaunch'}
          </button>
        ) : (
          <button type="button" className="btn-accent" onClick={() => void download()} disabled={!status.url}>
            Download
          </button>
        )}
      </div>
    </div>
  )
}

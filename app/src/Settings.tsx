import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message } from '@tauri-apps/plugin-dialog'
import { ipc } from './ipc'
import { checkedAgo } from './Update'
import type { CliStatus, UpdateStatus } from './types'

export type Appearance = 'system' | 'light' | 'dark'

export const DEFAULT_TYPEFACE = 'sf'

// Keep these keys in step with the Typeface submenu in src-tauri/src/menu.rs.
export const TYPEFACES: Record<string, { label: string; stack: string }> = {
  sf: { label: 'SF Pro', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif" },
  // Bundled by main.tsx rather than fetched, so this resolves offline.
  inter: { label: 'Inter', stack: "'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif" },
  avenir: { label: 'Avenir Next', stack: "'Avenir Next', 'Avenir', -apple-system, BlinkMacSystemFont, sans-serif" },
  helvetica: { label: 'Helvetica Neue', stack: "'Helvetica Neue', Helvetica, -apple-system, sans-serif" },
  newyork: { label: 'New York', stack: "ui-serif, 'New York', 'Iowan Old Style', Georgia, serif" },
  charter: { label: 'Charter', stack: "Charter, 'Iowan Old Style', Georgia, serif" },
  iowan: { label: 'Iowan Old Style', stack: "'Iowan Old Style', Charter, Georgia, serif" },
}

export function applyTypeface(key: string) {
  const face = TYPEFACES[key] ?? TYPEFACES[DEFAULT_TYPEFACE]
  document.documentElement.style.setProperty('--font-body', face.stack)
  document.documentElement.dataset.typeface = key
  localStorage.setItem('sidenote.typeface', key)
}

/** Apply the appearance. On boot, skip the native call: setTheme rebuilds the
 *  macOS titlebar and throws away the traffic light inset set at window
 *  creation, and tauri 2.11 offers no way to put it back. Skipping it costs
 *  nothing at startup — the window is created following the system already —
 *  but a change made here in Settings does move the buttons back to their
 *  default position until the app is relaunched. */
export function applyAppearance(mode: Appearance, boot = false) {
  const root = document.documentElement
  if (mode === 'system') delete root.dataset.theme
  else root.dataset.theme = mode
  localStorage.setItem('sidenote.appearance', mode)
  if (boot) return
  // Native chrome (vibrancy, dialogs) follows the same choice.
  void getCurrentWindow()
    .setTheme(mode === 'system' ? null : mode)
    .catch(() => {})
}

export function loadPreferences() {
  applyTypeface(localStorage.getItem('sidenote.typeface') ?? DEFAULT_TYPEFACE)
  applyAppearance((localStorage.getItem('sidenote.appearance') as Appearance | null) ?? 'system', true)
}

interface Props {
  onClose: () => void
  onToast: (t: string) => void
  /** Run a forced check. The banner belongs to App, so the sheet closes and
   *  hands over rather than growing a second copy of the update UI. */
  onCheckUpdates: () => void
}

export function Settings({ onClose, onToast, onCheckUpdates }: Props) {
  const [appearance, setAppearance] = useState<Appearance>(
    (localStorage.getItem('sidenote.appearance') as Appearance | null) ?? 'system',
  )
  const [typeface, setTypeface] = useState(
    localStorage.getItem('sidenote.typeface') ?? DEFAULT_TYPEFACE,
  )
  const [cli, setCli] = useState<CliStatus | null>(null)
  const [skill, setSkill] = useState<{ path: string; installed: boolean; current: boolean } | null>(null)
  const [home, setHome] = useState('')
  const [md, setMd] = useState<{ is_default: boolean; current?: string | null } | null>(null)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateStatus | null>(null)

  const refresh = async () => {
    setCli(await ipc.cliStatus().catch(() => null))
    setSkill(await ipc.skillStatus().catch(() => null))
    setHome(await ipc.sidenoteHome().catch(() => ''))
    setMd(await ipc.defaultMdHandler().catch(() => null))
    setVersion(await getVersion().catch(() => ''))
    // Cached: opening Settings must not wait on the network.
    setUpdate(await ipc.updateCheck(false).catch(() => null))
  }

  useEffect(() => {
    void refresh()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const install = async () => {
    const notes: string[] = []
    try {
      await ipc.installCli()
      notes.push('CLI linked')
    } catch (err) {
      await message(`${err}`, { title: 'CLI install failed', kind: 'error' })
    }
    try {
      notes.push(`skill ${await ipc.installSkill(false)}`)
    } catch (err) {
      await message(`${err}`, { title: 'Skill install failed', kind: 'error' })
    }
    if (notes.length) onToast(notes.join(' · '))
    await refresh()
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="sheet" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>Settings</span>
          <button type="button" className="btn-quiet" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="sheet-body">
        <section className="pref">
          <div className="pref-label">Appearance</div>
          <div className="segmented" role="radiogroup">
            {(['system', 'light', 'dark'] as Appearance[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={appearance === m}
                className={appearance === m ? 'is-on' : ''}
                onClick={() => {
                  setAppearance(m)
                  applyAppearance(m)
                }}
              >
                {m === 'system' ? 'System' : m === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </section>

        <section className="pref">
          <div className="pref-label">Typeface</div>
          <div className="typefaces" role="radiogroup">
            {Object.entries(TYPEFACES).map(([key, f]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={typeface === key}
                className={`typeface ${typeface === key ? 'is-on' : ''}`}
                style={{ fontFamily: f.stack || 'var(--font-ui)' }}
                onClick={() => {
                  setTypeface(key)
                  applyTypeface(key)
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </section>

        <section className="pref">
          <div className="pref-label">Markdown files</div>
          <div className="pref-rows">
            <div className="pref-row">
              <span>Default app for .md</span>
              <span className={md?.is_default ? 'ok' : 'muted'}>
                {md?.is_default ? 'Sidenote' : (md?.current ?? 'unknown')}
              </span>
            </div>
          </div>
          {!md?.is_default && (
            <div className="pref-actions">
              <button
                type="button"
                className="btn-quiet"
                onClick={async () => {
                  try {
                    await ipc.setDefaultMdHandler()
                    onToast('.md files now open in Sidenote.')
                  } catch (err) {
                    await message(`${err}`, { title: 'Default editor', kind: 'error' })
                  }
                  await refresh()
                }}
              >
                Open .md files with Sidenote
              </button>
            </div>
          )}
        </section>

        <section className="pref">
          <div className="pref-label">Claude Code integration</div>
          <p className="pref-help">
            Claude Code reads comments and posts replies through the <code>sidenote</code> command, and follows the
            <code> sidenote-review</code> skill. Installing links the command into <code>/usr/local/bin</code> (macOS may
            ask for your password) and writes one file under <code>~/.claude/skills/</code>.
          </p>
          <div className="pref-rows">
            <div className="pref-row">
              <span>Command line tool</span>
              <span className={cli?.installed ? 'ok' : 'muted'}>{cli?.installed ? cli.link : 'not installed'}</span>
            </div>
            <div className="pref-row">
              <span>Skill</span>
              <span className={skill?.installed ? 'ok' : 'muted'}>
                {skill?.installed ? (skill.current ? 'installed, current' : 'installed, older version') : 'not installed'}
              </span>
            </div>
            <div className="pref-row">
              <span>Data</span>
              <span className="muted">{home}</span>
            </div>
          </div>
          <div className="pref-actions">
            <button type="button" className="btn-quiet" onClick={() => void install()}>
              {cli?.installed && skill?.current ? 'Reinstall' : 'Install'}
            </button>
          </div>
        </section>
        </div>

        <div className="sheet-foot">
          <span>Sidenote{version && ` ${version}`}</span>
          <span className="foot-update">
            {update?.newer && update.latest && <span className="avail">{update.latest} available</span>}
            <button
              type="button"
              className="btn-link"
              title={`Last checked ${checkedAgo(update?.checked_at)}. Homebrew installs the update.`}
              onClick={() => {
                onClose()
                onCheckUpdates()
              }}
            >
              Check for Updates
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

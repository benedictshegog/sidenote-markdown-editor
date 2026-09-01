import { useState } from 'react'
import { message } from '@tauri-apps/plugin-dialog'
import { ipc } from './ipc'

interface Props {
  needsCli: boolean
  needsSkill: boolean
  needsMd: boolean
  /** Start on the explainer. False jumps straight to the options, which is
   *  what someone who picked "Install Claude Code Integration…" asked for. */
  intro: boolean
  onDone: () => void
  onToast: (t: string) => void
}

/** First launch, in two steps: what Sidenote is, then the only screen that
 *  asks for anything. The explainer comes first on purpose — nothing should
 *  request permission before the user knows what they are looking at. */
export function Welcome({ needsCli, needsSkill, needsMd, intro, onDone, onToast }: Props) {
  const [step, setStep] = useState<1 | 2>(intro ? 1 : 2)
  const [cli, setCli] = useState(needsCli)
  const [skill, setSkill] = useState(needsSkill)
  const [md, setMd] = useState(needsMd)
  const [busy, setBusy] = useState(false)

  const install = async () => {
    setBusy(true)
    const notes: string[] = []
    try {
      if (cli) {
        try {
          await ipc.installCli()
          notes.push('command line tool linked')
        } catch (err) {
          await message(`${err}`, { title: 'Command line tool', kind: 'error' })
        }
      }
      if (skill) {
        try {
          await ipc.installSkill(false)
          notes.push('skill installed')
        } catch (err) {
          await message(`${err}`, { title: 'Skill', kind: 'error' })
        }
      }
      if (md) {
        try {
          await ipc.setDefaultMdHandler()
          notes.push('.md files open in Sidenote')
        } catch (err) {
          await message(`${err}`, { title: 'Default editor', kind: 'error' })
        }
      }
      if (notes.length) onToast(notes.join(' · '))
    } finally {
      setBusy(false)
      onDone()
    }
  }

  // The command line tool and the skill are what connect Sidenote to Claude
  // Code; with either one missing there is no loop for a comment to travel
  // round, so neither can be declined here. The Finder default is optional.
  const ready = (!needsCli || cli) && (!needsSkill || skill)

  const pips = (
    <span className="welcome-steps" aria-hidden>
      <span className={`welcome-pip ${step === 1 ? 'is-on' : ''}`} />
      <span className={`welcome-pip ${step === 2 ? 'is-on' : ''}`} />
    </span>
  )

  if (step === 1) {
    return (
      <div className="sheet-backdrop is-welcome">
        <div className="sheet welcome" role="dialog" aria-label="Welcome to Sidenote">
          <div className="welcome-glyph">*</div>
          <h2>Keep a human in the loop.</h2>
          <p className="welcome-lead">Sidenote is where you and an LLM work on the same document.</p>

          <div className="welcome-acts">
            <div className="welcome-act">
              <span className="welcome-act-n">1</span>
              <div>
                <h3>Your hands on the draft</h3>
                <p>Edit directly. Cut fluff and manually write parts only you know.</p>
              </div>
            </div>
            <div className="welcome-act">
              <span className="welcome-act-n">2</span>
              <div>
                <h3>Hand the rest back</h3>
                <p>Comment on the doc to delegate a change or ask a question.</p>
              </div>
            </div>
          </div>

          <div className="welcome-actions is-plain">
            {pips}
            <button type="button" className="btn-accent" onClick={() => setStep(2)}>
              Continue
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="sheet-backdrop is-welcome">
      <div className="sheet welcome" role="dialog" aria-label="Claude Code integration">
        <h2>Sidenote works with Claude Code</h2>
        <p className="welcome-lead">
          The first two carry your comments between the apps, so Sidenote needs them. The Finder default is up to
          you, and Settings (⌘,) can change any of it later.
        </p>

        {needsCli && (
        <label className="opt">
          <input type="checkbox" checked={cli} onChange={(e) => setCli(e.target.checked)} />
          <span>
            <span className="opt-title">Command line tool</span>
            <span className="opt-text">How Claude Code reads comments. macOS may ask for your password.</span>
          </span>
        </label>
        )}

        {needsSkill && (
        <label className="opt">
          <input type="checkbox" checked={skill} onChange={(e) => setSkill(e.target.checked)} />
          <span>
            <span className="opt-title">Claude Code skill</span>
            <span className="opt-text">Teaches Claude Code how to handle your comments.</span>
          </span>
        </label>
        )}

        {needsMd && (
        <label className="opt">
          <input type="checkbox" checked={md} onChange={(e) => setMd(e.target.checked)} />
          <span>
            <span className="opt-title">Open .md files with Sidenote</span>
            <span className="opt-text">Makes Sidenote the default Markdown editor in Finder.</span>
          </span>
        </label>
        )}

        {/* Always rendered, only hidden: a note that appears on untick would
            otherwise resize the sheet under the pointer. One fixed line, so
            the reserved height never depends on which box was cleared. */}
        <p className={`welcome-note ${ready ? 'is-hidden' : ''}`} aria-hidden={ready}>
          Claude Code cannot read your comments without both.
        </p>

        <div className="welcome-actions">
          {intro && pips}
          <button type="button" className="btn-accent" onClick={() => void install()} disabled={busy || !ready}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  )
}

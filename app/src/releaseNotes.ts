// The release notes ship inside the app: CHANGELOG.md at the repo root is
// bundled at build time, so a copy always knows its own history and needs no
// network to say what changed. `scripts/release.sh` turns the `## Unreleased`
// section into `## X.Y.Z (date)` when it cuts the release.
import changelog from '../../CHANGELOG.md?raw'

export interface Release {
  version: string
  date: string | null
  notes: string[]
}

const SEEN_KEY = 'sidenote.notesSeen'

/** `## 0.1.32 (2026-09-22)` then `- ` bullets. Anything else is ignored, and
 *  so is `## Unreleased`: it describes a build no one has installed yet. */
export function parseChangelog(md: string): Release[] {
  const out: Release[] = []
  let cur: Release | null = null
  for (const line of md.split('\n')) {
    const head = /^##\s+(\d+\.\d+\.\d+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/.exec(line)
    if (head) {
      cur = { version: head[1], date: head[2] ?? null, notes: [] }
      out.push(cur)
    } else if (/^##\s/.test(line)) {
      cur = null
    } else if (cur && /^-\s+/.test(line)) {
      cur.notes.push(line.replace(/^-\s+/, '').trim())
    }
  }
  return out
}

export const RELEASES = parseChangelog(changelog)

/** Numeric, part by part: 0.1.10 is newer than 0.1.9. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Releases after `from`, up to and including `to`, newest first. */
export function releasesBetween(from: string, to: string): Release[] {
  return RELEASES.filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0)
}

/** Has this copy just been updated? Returns the version it came from, once:
 *  the answer is recorded as it is given, so the next launch stays quiet. A
 *  first launch records the version and says nothing, because a new user has
 *  no "before" for the notes to be news against. */
export function takeUpdatedFrom(current: string): string | null {
  let seen = localStorage.getItem(SEEN_KEY)
  localStorage.setItem(SEEN_KEY, current)
  // Installed before the notes existed: an existing user (the welcome sheet
  // has run) with no record. Show this release's notes alone.
  if (!seen && localStorage.getItem('sidenote.welcomeShown')) {
    seen = RELEASES.find((r) => compareVersions(r.version, current) < 0)?.version ?? null
  }
  // A dev build can fake an update to show the notes: VITE_NOTES_FROM=0.1.29.
  const fake = import.meta.env.DEV ? (import.meta.env.VITE_NOTES_FROM as string | undefined) : undefined
  const from = fake || seen
  if (!from || compareVersions(current, from) <= 0) return null
  // An update whose releases carry no notes has nothing to show.
  return releasesBetween(from, current).length ? from : null
}

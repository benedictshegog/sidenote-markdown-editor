//! Update checking, and the upgrade path for a Homebrew install.
//!
//! Sidenote ships through a Homebrew cask, so Homebrew — not the app — owns
//! what is in `/Applications`. The app therefore never replaces itself. It
//! reads a small feed to learn a newer version exists, and when the install
//! came from the cask it can run `brew upgrade` on the user's behalf. The
//! cask, the receipt and the installed bytes never disagree that way.
//!
//! The feed is fetched with `curl` rather than an HTTP crate on purpose: the
//! release profile optimises for size, and a TLS stack is a large dependency
//! for one request a day. macOS always has `/usr/bin/curl`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::state::AppState;

type S<'a> = tauri::State<'a, Arc<AppState>>;

const FEED: &str = "https://benedictshegog.xyz/downloads/latest.json";
/// Fully qualified on purpose. A Mac that has ever tapped a second repo with
/// a `sidenote` cask — a test tap, say — makes the bare name ambiguous, and
/// brew refuses to upgrade anything at all.
const CASK: &str = "benedictshegog/sidenote/sidenote";
const APP_PATH: &str = "/Applications/Sidenote.app";
/// How long a check is good for. The feed changes a few times a month.
const INTERVAL: u64 = 24 * 60 * 60;
/// How long to wait after a failed check. Without this, a feed that is down —
/// or not published yet — means a fetch on every single launch.
const RETRY: u64 = 60 * 60;

/// Homebrew prefixes, in the order they are tried. Apple silicon first: the
/// cask is `depends_on arch: :arm64`, so that is where it lands.
const PREFIXES: [&str; 2] = ["/opt/homebrew", "/usr/local"];

/// What `latest.json` holds. Only `version` is required; the rest lets the
/// UI offer a download to someone who did not install through the tap.
#[derive(Deserialize, Default)]
struct Feed {
    version: String,
    url: Option<String>,
    notes: Option<String>,
}

/// `~/.sidenote/update.json`: the last answer, so a launch does not always
/// mean a network round trip.
#[derive(Serialize, Deserialize, Default)]
struct Cache {
    checked_at: u64,
    version: String,
    url: Option<String>,
    notes: Option<String>,
    /// When the last attempt failed. Kept beside the last good answer rather
    /// than replacing it, so being offline never loses what we knew.
    #[serde(default)]
    failed_at: u64,
}

#[derive(Serialize)]
pub struct UpdateStatus {
    /// The running build.
    pub current: String,
    /// The newest published build, when a check has ever succeeded.
    pub latest: Option<String>,
    /// `latest` is genuinely newer than `current`.
    pub newer: bool,
    pub notes: Option<String>,
    /// Where to download it by hand.
    pub url: Option<String>,
    /// Homebrew installed this app, so the app can drive the upgrade.
    pub managed: bool,
    /// Unix seconds of the last successful check.
    pub checked_at: Option<u64>,
    /// Set when this check failed. The last known answer is still returned.
    pub error: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Leading integers of a dotted version, so 0.1.10 sorts after 0.1.9.
///
/// Reading stops at the first component that is not purely digits, so the
/// "1" in "0.1.12-beta.1" does not read as a fourth component and make a
/// pre-release look newer than the release it precedes.
fn parts(v: &str) -> Vec<u64> {
    let mut out = Vec::new();
    for comp in v.trim().trim_start_matches('v').split('.') {
        let digits: String = comp.chars().take_while(char::is_ascii_digit).collect();
        out.push(digits.parse().unwrap_or(0));
        if digits.len() != comp.len() {
            break;
        }
    }
    out
}

/// Whether `latest` is a later version than `current`.
///
/// A string comparison is wrong here — "0.1.10" < "0.1.9" — and getting it
/// wrong means either nagging forever or never announcing anything.
pub fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (parts(latest), parts(current));
    if a.iter().all(|n| *n == 0) {
        return false; // unparseable: treat as no update rather than a downgrade
    }
    let n = a.len().max(b.len());
    for i in 0..n {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// The `brew` this Mac uses, if any.
fn brew_bin() -> Option<PathBuf> {
    // Found by path, not through PATH: a GUI app inherits launchd's minimal
    // environment, which does not have Homebrew on it.
    PREFIXES
        .iter()
        .map(|p| PathBuf::from(p).join("bin/brew"))
        .find(|p| p.is_file())
}

/// Whether Homebrew installed the Sidenote in `/Applications`.
fn cask_installed() -> bool {
    PREFIXES
        .iter()
        .any(|p| PathBuf::from(p).join("Caskroom/sidenote").is_dir())
}

/// Whether the app may drive its own upgrade: Homebrew is here, it has a
/// Sidenote cask, and this is the bundle that cask installed.
fn managed() -> bool {
    if brew_bin().is_none() || !cask_installed() {
        return false;
    }
    // A debug build runs out of the cargo target directory, so it can never
    // match the installed bundle. Checking the path would make the feature
    // impossible to exercise with `pnpm tauri dev`.
    if cfg!(debug_assertions) {
        return true;
    }
    std::env::current_exe()
        .map(|e| e.starts_with(APP_PATH))
        .unwrap_or(false)
}

fn cache_path(store_home: &Path) -> PathBuf {
    store_home.join("update.json")
}

fn read_cache(home: &Path) -> Option<Cache> {
    let raw = std::fs::read_to_string(cache_path(home)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cache(home: &Path, c: &Cache) {
    if let Ok(json) = serde_json::to_vec_pretty(c) {
        let _ = sidenote_core::fsutil::atomic_write(&cache_path(home), &json);
    }
}

fn fetch() -> Result<Feed, String> {
    // Cloudflare fronts the site with max-age=14400, so a plain GET can answer
    // from a four-hour-old cache — long enough to hide a release for an
    // afternoon. The timestamp makes each check its own cache key.
    let url = format!("{FEED}?t={}", now());
    let out = Command::new("/usr/bin/curl")
        .args([
            "-fsSL",
            "--max-time",
            "8",
            "-H",
            "Cache-Control: no-cache",
            &url,
        ])
        .output()
        .map_err(|e| format!("cannot run curl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "cannot reach {FEED}{}",
            match out.status.code() {
                Some(c) => format!(" (curl exit {c})"),
                None => String::new(),
            }
        ));
    }
    let feed: Feed =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("{FEED} is not valid: {e}"))?;
    if feed.version.trim().is_empty() {
        return Err(format!("{FEED} has no version"));
    }
    Ok(feed)
}

fn status_from(current: &str, cache: Option<&Cache>, error: Option<String>) -> UpdateStatus {
    let latest = cache.map(|c| c.version.clone()).filter(|v| !v.trim().is_empty());
    UpdateStatus {
        newer: latest.as_deref().map(|l| is_newer(l, current)).unwrap_or(false),
        current: current.to_string(),
        notes: cache.and_then(|c| c.notes.clone()).filter(|n| !n.trim().is_empty()),
        url: cache.and_then(|c| c.url.clone()),
        checked_at: cache.map(|c| c.checked_at).filter(|t| *t > 0),
        latest,
        managed: managed(),
        error,
    }
}

/// Look for a newer release. Answers from `~/.sidenote/update.json` unless the
/// last check is a day old or `force` is set, so a launch is not a round trip.
#[tauri::command]
pub fn update_check(state: S, force: bool) -> UpdateStatus {
    let current = env!("CARGO_PKG_VERSION");
    let home = state.store.home().to_path_buf();
    let cached = read_cache(&home);
    let recent = cached
        .as_ref()
        .map(|c| {
            now().saturating_sub(c.checked_at) < INTERVAL
                || now().saturating_sub(c.failed_at) < RETRY
        })
        .unwrap_or(false);
    if recent && !force {
        return status_from(current, cached.as_ref(), None);
    }
    let next = match fetch() {
        Ok(feed) => Cache {
            checked_at: now(),
            version: feed.version,
            url: feed.url,
            notes: feed.notes,
            failed_at: 0,
        },
        // Offline is the normal case here, not a fault worth a dialog. The
        // last known answer stands, the UI stays quiet, and the failure is
        // recorded only to hold off the next attempt.
        Err(e) => {
            let mut c = cached.unwrap_or_default();
            c.failed_at = now();
            write_cache(&home, &c);
            return status_from(current, Some(&c), Some(e));
        }
    };
    write_cache(&home, &next);
    status_from(current, Some(&next), None)
}

/// The script that does the upgrade after Sidenote has quit.
///
/// It has to outlive the app, and it must not live inside the bundle that
/// Homebrew is about to delete — hence `~/.sidenote`.
fn helper_script(brew: &Path, log: &Path) -> String {
    format!(
        r#"#!/bin/sh
# Written by Sidenote. Upgrades the Homebrew cask, then reopens the app.
# Safe to delete.
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
exec >>"{log}" 2>&1
echo "--- $(date) upgrading"

# Homebrew replaces /Applications/Sidenote.app, which fails while the app has
# the bundle open. Wait for it to go, but never forever.
n=0
while pgrep -f "Sidenote.app/Contents/MacOS" >/dev/null 2>&1 && [ $n -lt 60 ]; do
  sleep 0.5
  n=$((n + 1))
done

# The tap has to be refreshed first or brew still sees the old cask.
"{brew}" update --quiet || true
"{brew}" upgrade --cask {cask}
status=$?

# Reopening comes first, whatever happened. An alert is modal: raised before
# this line it blocks the script, and the user is left with no app at all.
open -a "{app}"

if [ $status -eq 0 ]; then
  echo "upgraded"
else
  echo "upgrade failed ($status)"
  # Bounded, so a dialog nobody is there to answer cannot leave this script
  # running for the rest of the session.
  osascript -e 'display alert "Sidenote could not update" message "Homebrew did not finish. Run: brew upgrade --cask {cask}" as warning giving up after 60' >/dev/null 2>&1
fi
"#,
        log = log.display(),
        brew = brew.display(),
        app = APP_PATH,
        cask = CASK,
    )
}

/// Quit and let Homebrew install the new version, then reopen.
///
/// Returns the log path. The UI has already flushed open documents by the
/// time this runs — the app is about to exit.
#[tauri::command]
pub fn update_run(app: AppHandle, state: S) -> Result<String, String> {
    if !managed() {
        return Err("this copy was not installed with Homebrew".into());
    }
    let brew = brew_bin().ok_or("cannot find brew")?;
    let home = state.store.home().to_path_buf();
    let script = home.join("upgrade.sh");
    let log = home.join("upgrade.log");
    std::fs::write(&script, helper_script(&brew, &log))
        .map_err(|e| format!("cannot write {}: {e}", script.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }
    // Detached: no inherited stdio, so nothing keeps it tied to this process
    // once the app exits. launchd adopts it.
    Command::new("/bin/sh")
        .arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cannot start the upgrade: {e}"))?;
    // Long enough for this reply to reach the UI, short enough that the
    // helper is not left waiting.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(700));
        handle.exit(0);
    });
    Ok(log.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_numbers_not_text() {
        // The whole point: a string compare puts 0.1.10 before 0.1.9.
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(!is_newer("0.1.9", "0.1.10"));
        assert!(is_newer("0.2.0", "0.1.99"));
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    #[test]
    fn same_version_is_not_newer() {
        assert!(!is_newer("0.1.12", "0.1.12"));
        assert!(!is_newer("v0.1.12", "0.1.12"));
        // Missing components count as zero.
        assert!(!is_newer("1.0", "1.0.0"));
        assert!(is_newer("1.0.1", "1.0"));
    }

    #[test]
    fn a_junk_feed_announces_nothing() {
        assert!(!is_newer("", "0.1.12"));
        assert!(!is_newer("latest", "0.1.12"));
        assert!(!is_newer("0.0.0", "0.1.12"));
    }

    /// The helper runs after the app is gone, so nothing in it may depend on
    /// the app, on PATH, or on the bundle it is replacing.
    #[test]
    fn the_helper_stands_on_its_own() {
        let s = super::helper_script(
            std::path::Path::new("/opt/homebrew/bin/brew"),
            std::path::Path::new("/Users/x/.sidenote/upgrade.log"),
        );
        // brew is called by absolute path: launchd gives a GUI app a minimal
        // environment, and brew itself needs a usable PATH to run git.
        assert!(s.contains("\"/opt/homebrew/bin/brew\" upgrade --cask benedictshegog/sidenote/sidenote"));
        assert!(s.contains("PATH=/opt/homebrew/bin:"));
        // It must wait, or brew replaces a bundle that is still open.
        assert!(s.contains("pgrep -f \"Sidenote.app/Contents/MacOS\""));
        // ...but not forever, or a stuck app leaves a script running for good.
        assert!(s.contains("[ $n -lt 60 ]"));
        // The tap is refreshed first, or brew still sees the old cask.
        assert!(s.contains("update --quiet"));
        // Fully qualified: a second tap carrying a `sidenote` cask makes the
        // bare name ambiguous and brew then upgrades nothing.
        assert!(s.contains("upgrade --cask benedictshegog/sidenote/sidenote"));
        // Whatever happens, the user gets their app back — and gets it back
        // before any modal alert, which would otherwise block this script.
        let reopen = s.find("open -a \"/Applications/Sidenote.app\"").expect("reopens");
        assert!(s[..reopen].find("display alert").is_none(), "alert must not precede the reopen");
        assert!(s.contains("giving up after 60"));
        assert!(s.contains("/Users/x/.sidenote/upgrade.log"));
        println!("{s}");
    }

    #[test]
    fn suffixes_are_ignored_rather_than_fatal() {
        assert!(is_newer("0.1.13-beta.1", "0.1.12"));
        assert!(!is_newer("0.1.12-beta.1", "0.1.12"));
    }
}

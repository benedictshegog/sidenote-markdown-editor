//! Locked, atomic JSON reads and writes. Every writer of a JSON file under
//! `~/.sidenote/` (app or CLI) goes through `update_json`, so two writers cannot
//! lose each other's updates.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{Result, SidenoteError};

/// How long to wait for another writer before giving up. A lock is held for
/// one read-modify-write of a small JSON file, so anything approaching this
/// is a process that died holding it rather than one doing work. Blocking
/// forever would hang the app: these calls run on Tauri command threads and
/// the UI waits on them.
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const LOCK_RETRY: Duration = Duration::from_millis(20);

/// An exclusive advisory lock on `<path>.lock`, released on drop.
pub struct FileLock {
    _file: File,
}

impl FileLock {
    pub fn acquire(target: &Path) -> Result<FileLock> {
        FileLock::acquire_for(target, LOCK_TIMEOUT)
    }

    pub fn acquire_for(target: &Path, timeout: Duration) -> Result<FileLock> {
        let lock_path = lock_path_for(target);
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)?;
        let deadline = Instant::now() + timeout;
        loop {
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                return Ok(FileLock { _file: file });
            }
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
                return Err(SidenoteError::Io(err));
            }
            if Instant::now() >= deadline {
                return Err(SidenoteError::Other(format!(
                    "timed out after {}s waiting for the lock on {}; another process may be stuck",
                    timeout.as_secs(),
                    target.display()
                )));
            }
            std::thread::sleep(LOCK_RETRY);
        }
    }
}

fn lock_path_for(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    target.with_file_name(format!(".{name}.lock"))
}

/// Write bytes through a temporary file in the same directory, then rename.
///
/// The temporary file is removed on every failure path. It lands beside the
/// target, which for a document means the user's own project directory, and a
/// crashed write used to leave `.plan.md.4821.tmp` there for them to find.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| SidenoteError::Other("path has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let tmp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    let write = (|| -> Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if write.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write
}

/// Raw contents of a JSON file, or `None` when it is missing or empty.
fn read_raw(path: &Path) -> Result<Option<String>> {
    match File::open(path) {
        Ok(mut f) => {
            let mut s = String::new();
            f.read_to_string(&mut s)?;
            if s.trim().is_empty() {
                return Ok(None);
            }
            Ok(Some(s))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(SidenoteError::Io(e)),
    }
}

fn parse<T: DeserializeOwned>(path: &Path, s: &str) -> Result<T> {
    serde_json::from_str(s).map_err(|e| SidenoteError::Json(path.display().to_string(), e))
}

/// Read and parse a JSON file. `Ok(None)` when the file does not exist.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match read_raw(path)? {
        Some(s) => Ok(Some(parse(path, &s)?)),
        None => Ok(None),
    }
}

/// Serialise and write a JSON file atomically under the file lock.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let _lock = FileLock::acquire(path)?;
    write_json_unlocked(path, value)
}

fn serialise<T: Serialize>(path: &Path, value: &T) -> Result<String> {
    let mut s = serde_json::to_string_pretty(value)
        .map_err(|e| SidenoteError::Json(path.display().to_string(), e))?;
    s.push('\n');
    Ok(s)
}

fn write_json_unlocked<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    atomic_write(path, serialise(path, value)?.as_bytes())
}

/// Read-modify-write under the lock. The closure receives the current value
/// (or the default when the file is missing) and returns what to store.
///
/// A write that would not change the file is skipped. This is not an
/// optimisation of the write itself — these files are small — but of what a
/// write sets off. Every one of them wakes the recursive watcher on
/// `~/.sidenote/docs`, which recounts the Dock badge, and the per-document
/// watcher, which reloads threads in every open tab. The app calls
/// `update_selectors` after each autosave, and before this it rewrote
/// `threads.json` on every keystroke burst whether a selector had moved or
/// not.
pub fn update_json<T, F, R>(path: &Path, f: F) -> Result<R>
where
    T: DeserializeOwned + Serialize + Default,
    F: FnOnce(&mut T) -> Result<R>,
{
    let _lock = FileLock::acquire(path)?;
    let before = read_raw(path)?;
    let mut value: T = match &before {
        Some(s) => parse(path, s)?,
        None => T::default(),
    };
    let out = f(&mut value)?;
    let after = serialise(path, &value)?;
    if before.as_deref() != Some(after.as_str()) {
        atomic_write(path, after.as_bytes())?;
    }
    Ok(out)
}

pub fn read_to_string(path: &Path) -> Result<String> {
    Ok(fs::read_to_string(path)?)
}

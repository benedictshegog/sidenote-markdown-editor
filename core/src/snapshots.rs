//! Whole-document snapshots: `docs/<id>/vNNN.md`.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::fsutil::atomic_write;
use crate::model::SNAPSHOT_KEEP;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub number: u32,
    pub path: PathBuf,
}

impl Snapshot {
    pub fn name(&self) -> String {
        format!("v{:03}", self.number)
    }

    /// Modification time as seconds since the Unix epoch.
    pub fn mtime(&self) -> Option<u64> {
        fs::metadata(&self.path)
            .ok()?
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs())
    }

    pub fn size(&self) -> u64 {
        fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
    }
}

pub fn list(doc_dir: &Path) -> Result<Vec<Snapshot>> {
    let mut out = Vec::new();
    let rd = match fs::read_dir(doc_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in rd {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(num) = name
            .strip_prefix('v')
            .and_then(|r| r.strip_suffix(".md"))
            .and_then(|n| n.parse::<u32>().ok())
        {
            out.push(Snapshot {
                number: num,
                path: entry.path(),
            });
        }
    }
    out.sort_by_key(|s| s.number);
    Ok(out)
}

pub fn latest(doc_dir: &Path) -> Result<Option<Snapshot>> {
    Ok(list(doc_dir)?.pop())
}

/// Write the next snapshot and prune old ones. Returns the new snapshot.
pub fn write_next(doc_dir: &Path, content: &str) -> Result<Snapshot> {
    let next = latest(doc_dir)?.map(|s| s.number + 1).unwrap_or(1);
    let path = doc_dir.join(format!("v{next:03}.md"));
    atomic_write(&path, content.as_bytes())?;
    prune(doc_dir, SNAPSHOT_KEEP)?;
    Ok(Snapshot { number: next, path })
}

pub fn prune(doc_dir: &Path, keep: usize) -> Result<usize> {
    let all = list(doc_dir)?;
    if all.len() <= keep {
        return Ok(0);
    }
    let drop = all.len() - keep;
    for s in &all[..drop] {
        fs::remove_file(&s.path)?;
    }
    Ok(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbering_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..3 {
            let s = write_next(dir.path(), &format!("v{i}")).unwrap();
            assert_eq!(s.number, i + 1);
        }
        assert_eq!(latest(dir.path()).unwrap().unwrap().name(), "v003");
        prune(dir.path(), 2).unwrap();
        let names: Vec<_> = list(dir.path()).unwrap().iter().map(|s| s.name()).collect();
        assert_eq!(names, vec!["v002", "v003"]);
        // Numbering continues after prune.
        assert_eq!(write_next(dir.path(), "x").unwrap().number, 4);
    }
}

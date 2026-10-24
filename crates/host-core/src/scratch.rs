//! Per-session scratch directories (D114).
//!
//! Temporary files an agent turn produces (intermediate scripts, downloaded
//! data, drafts) live under `<data_dir>/scratch/<session_id>/` instead of the
//! user's workspace, so the project directory and git status stay clean.
//! Lifecycle: created lazily on first mutating tool call, removed with the
//! session, swept at startup for orphans. Live-session retention is coordinated
//! by Desktop with runtime activity and protected transcript assets.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Session ids come from our own DB (UUIDs), but stay defensive: an id that
/// could traverse out of the scratch base gets no directory at all.
fn safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn base_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("scratch")
}

/// Absolute scratch directory for a session, or None for unsafe ids.
pub fn session_dir(data_dir: &Path, session_id: &str) -> Option<PathBuf> {
    if !safe_session_id(session_id) {
        return None;
    }
    Some(base_dir(data_dir).join(session_id))
}

/// Remove a session's scratch directory (idempotent, best-effort).
pub fn remove_session_dir(data_dir: &Path, session_id: &str) {
    if let Some(dir) = session_dir(data_dir, session_id) {
        if dir.exists() {
            if let Err(error) = std::fs::remove_dir_all(&dir) {
                tracing::warn!(path = %dir.display(), %error, "scratch cleanup failed");
            }
        }
    }
}

/// Startup sweep only drops directories whose session no longer exists.
/// Live scratch contains pasted attachments and full tool/delegation reports;
/// Desktop's activity-aware cleanup retains those instead of deleting the root.
pub fn sweep(data_dir: &Path, live_session_ids: &HashSet<String>) {
    let base = base_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if live_session_ids.contains(&name) {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&path) {
            tracing::warn!(path = %path.display(), %error, "scratch sweep failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_unsafe_session_ids() {
        let dir = tempdir().unwrap();
        assert!(session_dir(dir.path(), "../evil").is_none());
        assert!(session_dir(dir.path(), "a/b").is_none());
        assert!(session_dir(dir.path(), "").is_none());
        assert!(session_dir(dir.path(), "0b0e9a52-1_ok").is_some());
    }

    #[test]
    fn remove_is_idempotent() {
        let dir = tempdir().unwrap();
        let s = session_dir(dir.path(), "s1").unwrap();
        std::fs::create_dir_all(s.join("sub")).unwrap();
        std::fs::write(s.join("sub/a.txt"), "x").unwrap();
        remove_session_dir(dir.path(), "s1");
        assert!(!s.exists());
        remove_session_dir(dir.path(), "s1");
    }

    #[test]
    fn sweep_removes_orphans_keeps_live() {
        let dir = tempdir().unwrap();
        let live = session_dir(dir.path(), "live").unwrap();
        let orphan = session_dir(dir.path(), "orphan").unwrap();
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        let mut ids = HashSet::new();
        ids.insert("live".to_string());
        sweep(dir.path(), &ids);
        assert!(live.exists());
        assert!(!orphan.exists());
    }
}

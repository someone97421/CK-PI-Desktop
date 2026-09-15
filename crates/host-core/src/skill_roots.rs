//! Extra skill directories the user references read-only.
//!
//! The point is to reuse skills another agent already manages (for example
//! Claude Code's `~/.claude/skills`) without copying the documents: the scan
//! reads them live on every list, so additions and edits on that side show up
//! immediately.
//!
//! Deliberately kept out of `skills.json`: that file is per-capability enable
//! state, while this is user configuration. Documents inside these roots are
//! never written by host-core.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Bounded so a bad paste cannot turn one scan into a whole-disk walk.
pub const MAX_SKILL_ROOTS: usize = 16;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RootsFile {
    #[serde(default)]
    roots: Vec<String>,
}

pub struct SkillRoots {
    path: PathBuf,
    roots: Vec<String>,
}

impl SkillRoots {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir
            .join("agent-capabilities")
            .join("skill-roots.json");
        let roots = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<RootsFile>(&raw).ok())
            .map(|file| file.roots)
            .unwrap_or_default();
        Self { path, roots }
    }

    pub fn list(&self) -> &[String] {
        &self.roots
    }

    pub fn add(&mut self, raw: &str) -> Result<Vec<String>> {
        let normalized = normalize_root(raw)?;
        if self
            .roots
            .iter()
            .any(|existing| same_path(existing, &normalized))
        {
            return Ok(self.roots.clone());
        }
        if self.roots.len() >= MAX_SKILL_ROOTS {
            bail!("SKILL_ROOT_INVALID: at most {MAX_SKILL_ROOTS} extra skill paths");
        }
        self.roots.push(normalized);
        self.save()?;
        Ok(self.roots.clone())
    }

    pub fn remove(&mut self, raw: &str) -> Result<Vec<String>> {
        let target = raw.trim().to_string();
        self.roots.retain(|existing| !same_path(existing, &target));
        self.save()?;
        Ok(self.roots.clone())
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = RootsFile {
            roots: self.roots.clone(),
        };
        fs::write(&self.path, serde_json::to_string_pretty(&file)?)?;
        Ok(())
    }
}

/// Store one canonical spelling: forward slashes, no trailing separator. The
/// path must already exist, because a typo would otherwise look like an empty
/// skill directory forever.
pub fn normalize_root(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        bail!("SKILL_ROOT_INVALID: a path is required");
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        bail!("SKILL_ROOT_INVALID: the path must be absolute");
    }
    if !candidate.is_dir() {
        bail!("SKILL_ROOT_INVALID: not a directory");
    }
    let unified = trimmed.replace('\\', "/");
    let without_trailing = unified.trim_end_matches('/');
    Ok(if without_trailing.is_empty() {
        unified
    } else {
        without_trailing.to_string()
    })
}

/// Windows paths are case-insensitive, so treat them that way when comparing.
/// Separator style and a trailing slash are not part of the identity, because
/// the stored spelling and what the user types can differ.
fn same_path(a: &str, b: &str) -> bool {
    fn canon(value: &str) -> String {
        value
            .trim()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    }
    let left = canon(a);
    let right = canon(b);
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn adds_and_removes_roots_without_duplicates() {
        let app = tempdir().unwrap();
        let shared = app.path().join("other-agent-skills");
        fs::create_dir_all(&shared).unwrap();
        let other = app.path().join("another");
        fs::create_dir_all(&other).unwrap();

        let mut roots = SkillRoots::new(app.path());
        assert!(roots.list().is_empty());

        let listed = roots.add(shared.to_str().unwrap()).unwrap();
        assert_eq!(listed.len(), 1);
        // A trailing separator and a repeat both resolve to the same entry.
        let with_separator = format!("{}/", shared.to_str().unwrap().replace('\\', "/"));
        assert_eq!(roots.add(&with_separator).unwrap().len(), 1);

        roots.add(other.to_str().unwrap()).unwrap();
        assert_eq!(roots.list().len(), 2);

        // The persisted file is read back by the next registry.
        let reloaded = SkillRoots::new(app.path());
        assert_eq!(reloaded.list().len(), 2);

        let remaining = roots.remove(&with_separator).unwrap();
        assert_eq!(remaining.len(), 1);
        assert!(remaining[0].ends_with("another"));
    }

    #[test]
    fn rejects_relative_missing_and_empty_paths() {
        let app = tempdir().unwrap();
        let mut roots = SkillRoots::new(app.path());
        assert!(roots.add("relative/skills").is_err());
        assert!(roots.add("").is_err());
        let missing = app.path().join("does-not-exist");
        assert!(roots.add(missing.to_str().unwrap()).is_err());
        assert!(roots.list().is_empty());
    }

    #[test]
    fn caps_the_number_of_roots() {
        let app = tempdir().unwrap();
        let mut roots = SkillRoots::new(app.path());
        for index in 0..MAX_SKILL_ROOTS {
            let dir = app.path().join(format!("root-{index}"));
            fs::create_dir_all(&dir).unwrap();
            roots.add(dir.to_str().unwrap()).unwrap();
        }
        let extra = app.path().join("root-overflow");
        fs::create_dir_all(&extra).unwrap();
        assert!(roots.add(extra.to_str().unwrap()).is_err());
    }
}

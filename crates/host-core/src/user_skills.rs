use crate::activation::ActivationScope;
use crate::agent_capabilities::{
    capability_dir, capability_id, copy_directory_tree, display_name_candidate, file_timestamp,
    move_capability_file, normalize_project_path, parse_front_matter, path_stem_for_id,
    set_moved_capability_state, slugify, sorted_files, suffixed_capability_id, valid_capability_id,
    CapabilityLevel, CapabilityState, CapabilityTarget, MAX_ID_SUFFIX,
};
use crate::skill_roots::SkillRoots;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SKILLS: usize = 128;
pub const MAX_SKILL_BYTES: usize = 128 * 1024;
const MAX_NAME_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 400;
const SKILL_KIND: &str = "skills";
/// Documents read from a user-configured extra path; never written by host-core.
const LINKED_SOURCE: &str = "linked";
const LINKED_IMPORT_SOURCE: &str = "linked-import";

// 只识别技能目录内部的链接，不能把技能目录本身或外部扩展根当成可解除的导入。
fn imported_skill_link(path: &Path, directory: &Path) -> Option<PathBuf> {
    let relative = path.strip_prefix(directory).ok()?;
    let mut current = directory.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return None;
        };
        current.push(segment);
        if fs::symlink_metadata(&current).ok()?.file_type().is_symlink() {
            return Some(current);
        }
    }
    None
}

fn remove_imported_skill_link(path: &Path) -> Result<()> {
    #[cfg(windows)]
    if path.is_dir() {
        fs::remove_dir(path)?;
        return Ok(());
    }
    fs::remove_file(path)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillRecord {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub scope: ActivationScope,
    pub source: String,
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub level: Option<String>,
    pub project_path: Option<String>,
    pub description: Option<String>,
    pub body: Option<String>,
    pub enabled: Option<bool>,
    /// Kept for protocol compatibility. Capability pages use directory level
    /// instead of writing activation scope into a skill document.
    #[allow(dead_code)]
    pub scope: Option<ActivationScope>,
    /// Import mode: `"copy"` (default) keeps a private byte-for-byte replica so
    /// deleting or moving the source does not break the skill; `"link"` places
    /// a symlink so an external editor's updates are picked up on the next
    /// scan. Ignored by `create` and `update`.
    pub mode: Option<String>,
    /// Optional shape hint for `import`. When absent, a directory source is
    /// treated as the `<name>/SKILL.md` convention and a regular file is
    /// treated as `<id>.md`. A caller that pre-scanned the candidate can pass
    /// `"dir"` to require the SKILL.md convention.
    pub shape: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportMode {
    Copy,
    Link,
}

impl ImportMode {
    fn parse(value: Option<&str>) -> Result<Self> {
        match value.map(str::trim).unwrap_or("copy") {
            "" | "copy" => Ok(Self::Copy),
            "link" | "symlink" => Ok(Self::Link),
            other => bail!("SKILL_INVALID: unknown import mode `{other}`"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportShape {
    File,
    Dir,
}

impl ImportShape {
    fn parse(value: &str) -> Result<Self> {
        match value.trim() {
            "file" => Ok(Self::File),
            "dir" | "directory" => Ok(Self::Dir),
            other => bail!("SKILL_INVALID: unknown import shape `{other}`"),
        }
    }
}

pub struct UserSkillRegistry {
    state: CapabilityState,
    roots: SkillRoots,
    /// Test seam: replaces the resolved global skills directory so the suite
    /// never reads the developer's real `~/.agents/skills`.
    global_skills_dir: Option<PathBuf>,
}

/// Place a single skill file at `target`, either as a copy or a symlink.
///
/// Copy: `fs::copy` — a private byte replica so a moved or deleted source does
/// not break the skill.
/// Link: `symlink` (unix) / `symlink_file` (windows). On platforms or file
/// systems that reject symlinks the caller receives the OS error and must
/// decide whether to retry with `"copy"`.
fn place_file(source: &Path, target: &Path, mode: ImportMode) -> Result<()> {
    if target.exists() {
        bail!(
            "SKILL_INVALID: destination already exists: {}",
            target.display()
        );
    }
    match mode {
        ImportMode::Copy => {
            fs::copy(source, target)
                .with_context(|| format!("copy {} to {}", source.display(), target.display()))?;
        }
        ImportMode::Link => symlink_path(source, target)?,
    }
    Ok(())
}

/// Place a skill directory (Anthropic `<name>/SKILL.md` shape) at `target_dir`.
///
/// Copy: recursive copy so the destination owns every byte, including resources
/// beside `SKILL.md`.
/// Link: one symlink at the root pointing at the source directory. External
/// edits are picked up on the next scan; the caller is responsible for warning
/// the user that a source rename or deletion silently invalidates the skill.
fn place_dir(source_dir: &Path, target_dir: &Path, mode: ImportMode) -> Result<()> {
    if target_dir.exists() {
        bail!(
            "SKILL_INVALID: destination already exists: {}",
            target_dir.display()
        );
    }
    match mode {
        ImportMode::Copy => copy_directory_tree(source_dir, target_dir, false)?,
        ImportMode::Link => symlink_path(source_dir, target_dir)?,
    }
    Ok(())
}

#[cfg(unix)]
fn symlink_path(source: &Path, target: &Path) -> Result<()> {
    std::os::unix::fs::symlink(source, target)
        .with_context(|| format!("symlink {} -> {}", target.display(), source.display()))
}

#[cfg(windows)]
fn symlink_path(source: &Path, target: &Path) -> Result<()> {
    // Directory vs file must be picked at link time on Windows; falling back to
    // `symlink_file` for a directory would produce a link that resolves to a
    // regular file entry.
    let result = if source.is_dir() {
        std::os::windows::fs::symlink_dir(source, target)
    } else {
        std::os::windows::fs::symlink_file(source, target)
    };
    result.with_context(|| {
        format!(
            "symlink {} -> {} (Windows may require Developer Mode or elevation)",
            target.display(),
            source.display()
        )
    })
}

#[cfg(not(any(unix, windows)))]
fn symlink_path(_source: &Path, _target: &Path) -> Result<()> {
    bail!("SKILL_INVALID: symlink import is not supported on this platform")
}

fn clip(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().take(max_chars).collect()
}

fn valid_id(id: &str) -> bool {
    valid_capability_id(id, 64)
}

fn render_document(name: &str, description: Option<&str>, body: &str) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", name.replace('\n', " ")));
    if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!(
            "description: {}\n",
            description.replace('\n', " ")
        ));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim());
    out.push('\n');
    out
}

fn default_body(name: &str) -> String {
    format!("# {name}\n\nDescribe the steps the agent should follow when this skill applies.\n")
}

fn level_and_project(input: &UserSkillInput) -> Result<(CapabilityLevel, Option<String>)> {
    let level = CapabilityLevel::parse(input.level.as_deref())?;
    let project_path = input
        .project_path
        .as_deref()
        .map(normalize_project_path)
        .filter(|value| !value.is_empty());
    if level == CapabilityLevel::Project && project_path.is_none() {
        bail!("CAPABILITY_INVALID: projectPath is required for project skills");
    }
    if level == CapabilityLevel::Global && project_path.is_some() {
        // A project path on a global request is meaningful only for its local
        // enabled override; the file still belongs to the global directory.
        return Ok((level, project_path));
    }
    Ok((level, project_path))
}

fn merge_active_records(
    global: Vec<UserSkillRecord>,
    project: Vec<UserSkillRecord>,
) -> Vec<UserSkillRecord> {
    let mut result = global;
    for record in project {
        result.retain(|existing| {
            existing.id != record.id && !existing.name.eq_ignore_ascii_case(&record.name)
        });
        if record.enabled {
            result.push(record);
        }
    }
    result.retain(|record| record.enabled);
    result.sort_by_key(|record| record.name.to_lowercase());
    result
}

/// Direct `*.md` documents plus the conventional `<skill>/SKILL.md` shape. The
/// same rule applies to the managed directories and to an extra read-only path,
/// so pointing at another agent's skills root picks up both layouts.
fn collect_skill_paths(directory: &Path, out: &mut Vec<PathBuf>) {
    out.extend(sorted_files(directory, "md"));
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let skill_file = path.join("SKILL.md");
                if skill_file.is_file() {
                    out.push(skill_file);
                }
            }
        }
    }
}

/// The text after the opening `---` line, when `text` really starts frontmatter.
///
/// `parse_front_matter` accepts any first line that trims to `---`, so `--- `,
/// `---\r` and `--- \r\n` all open a block. A stricter check here would send
/// those documents down the "no frontmatter" path and copy the old block into
/// the body of a fresh one, leaving two frontmatter blocks in the file.
fn front_matter_body(text: &str) -> Option<&str> {
    let newline = text.find('\n')?;
    let first = text[..newline].trim_end_matches('\r');
    if first.trim() != "---" {
        return None;
    }
    Some(&text[newline + 1..])
}

/// Give a skill document the display name a destination needs, rewriting the
/// frontmatter `name` line and nothing else.
///
/// A move that has to rename must not reformat the document: `render_document`
/// normalizes prose, drops unknown frontmatter keys, and re-indents the body,
/// which would silently edit a file the user only asked to relocate. Everything
/// outside the rewritten lines — extra fields, whitespace, line endings — is
/// copied through byte for byte.
fn rewrite_document_name(raw: &str, name: &str) -> String {
    let value = name.replace(['\n', '\r'], " ");
    let (bom, text) = match raw.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", raw),
    };
    let Some(front) = front_matter_body(text) else {
        return with_fresh_frontmatter(bom, text, &value);
    };
    let mut out = String::with_capacity(raw.len() + value.len() + 16);
    out.push_str(bom);
    out.push_str("---\n");
    let mut cursor = 0usize;
    let mut replaced = false;
    while cursor < front.len() {
        let end = match front[cursor..].find('\n') {
            Some(at) => cursor + at + 1,
            None => front.len(),
        };
        let line = &front[cursor..end];
        if line.trim_end_matches(['\n', '\r']).trim() == "---" {
            if !replaced {
                out.push_str(&format!("name: {value}\n"));
            }
            // The terminator and everything after it, body included, is copied
            // through untouched.
            out.push_str(&front[cursor..]);
            return out;
        }
        let top_level = !line.starts_with(' ') && !line.starts_with('\t');
        let is_name = top_level
            && line
                .trim_end_matches(['\n', '\r'])
                .split_once(':')
                .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("name"));
        if is_name {
            if !replaced {
                out.push_str(&format!("name: {value}\n"));
                replaced = true;
            }
            // A later `name:` line is dropped rather than kept: the parser
            // inserts into a map, so the *last* line wins. Keeping a stale one
            // would silently defeat the rename — the document would keep its
            // old display name while the move claims it was changed.
        } else {
            out.push_str(line);
        }
        cursor = end;
    }
    // An unterminated opening delimiter is not frontmatter (`parse_front_matter`
    // rejects it), so the text becomes the body of a fresh, complete block.
    with_fresh_frontmatter(bom, text, &value)
}

fn with_fresh_frontmatter(bom: &str, text: &str, value: &str) -> String {
    format!(
        "{bom}---\nname: {value}\n---\n\n{}",
        text.trim_start_matches(['\n', '\r'])
    )
}

/// The directory a `<skill>/SKILL.md` document owns, when the document really is
/// the directory shape.
///
/// A skill may ship sibling resources next to its `SKILL.md`, so moving one
/// document is not enough — the directory is the unit. The guard matters: a
/// loose `SKILL.md` sitting directly in the skills directory has the skills
/// directory itself as its parent, and treating that as the unit would move
/// every skill at once.
fn directory_skill_root(path: &Path, skills_dir: &Path) -> Option<PathBuf> {
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
    {
        return None;
    }
    let dir = path.parent()?;
    if dir == skills_dir {
        return None;
    }
    Some(dir.to_path_buf())
}

/// Where an arriving skill document should land, and under which display name.
struct SkillPlacement {
    name: String,
    stem: String,
}

/// The document a skill with `stem` occupies inside the skills directory.
///
/// Directory-shape skills live at `<stem>/SKILL.md` because the scan gives that
/// document the *directory* name as its path-derived id; flat skills are one
/// `<stem>.md` file. The two shapes are why the landing path cannot be derived
/// from the stem alone.
fn skill_document_path(directory: &Path, stem: &str, shared_directory: bool) -> PathBuf {
    if shared_directory {
        directory.join(stem).join("SKILL.md")
    } else {
        directory.join(format!("{stem}.md"))
    }
}

/// Choose the name and file stem an arriving skill must use at a destination.
///
/// The scan, not the move, decides the arriving document's id: it derives the
/// id from the frontmatter name first and only then from the path. Planning
/// against the file stem alone therefore mismatches every document whose name
/// slugs to something else — a Chinese name, or a name whose slug happens to be
/// another document's id — and a mismatch hides documents: the source is
/// already gone while the arrival is either not found or loses the scan's
/// `seen` de-duplication. So every candidate is put through the real
/// `capability_id` for the exact path it would land on, and only a placement
/// the scan lists as its own record is accepted. `shared_directory` selects the
/// destination's shape, because that shape decides what `path_stem_for_id`
/// reads.
fn plan_skill_placement(
    source: &UserSkillRecord,
    directory: &Path,
    shared_directory: bool,
    existing: &[UserSkillRecord],
) -> Option<SkillPlacement> {
    let taken_names = existing
        .iter()
        .map(|record| record.name.to_lowercase())
        .collect::<HashSet<_>>();
    // Ids are compared lowercased, like the filesystem that will hold them.
    let taken_ids = existing
        .iter()
        .map(|record| record.id.to_lowercase())
        .collect::<HashSet<_>>();
    for ordinal in 1..=MAX_ID_SUFFIX {
        let name = display_name_candidate(&source.name, ordinal, MAX_NAME_CHARS);
        // A duplicate display name makes shadowing merge two records on the
        // next scan, so the destination may not already have it.
        if name.is_empty() || taken_names.contains(&name.to_lowercase()) {
            continue;
        }
        // The scan prefers the name's slug, so a valid slug *is* the id the
        // document will carry and the file stem has to match it.
        let from_name = slugify(&name, 64);
        let stem = if valid_capability_id(&from_name, 64) {
            from_name
        } else {
            suffixed_capability_id(&source.id, &taken_ids, 64)?.0
        };
        let document_path = skill_document_path(directory, &stem, shared_directory);
        // Something already on disk at this path is either a listed document
        // (caught again below) or one the scan refuses to list; never write
        // over it.
        if document_path.exists() {
            continue;
        }
        // Simulate the real scan: `capability_id` can still land on an id the
        // name slug did not predict (the path fallback), and an id collision
        // makes one of the two documents disappear from the catalog.
        let id = capability_id(&name, &document_path, 64);
        if !valid_capability_id(&id, 64) || taken_ids.contains(&id.to_lowercase()) {
            continue;
        }
        return Some(SkillPlacement { name, stem });
    }
    None
}

/// True when a scanned record path names the document a move just wrote.
///
/// The record path comes back from a directory scan and the planned path from a
/// join, so the comparison is normalized and case-insensitive — the same rules
/// project paths use, and the only rules that hold on a volume that ignores
/// case.
fn same_document(record_path: &str, planned: &Path) -> bool {
    normalize_project_path(record_path)
        .eq_ignore_ascii_case(&normalize_project_path(&planned.to_string_lossy()))
}

impl UserSkillRegistry {
    /// Move one skill between the global directory and a project's.
    ///
    /// The document moves instead of being copied: a copy would leave the old
    /// level holding a skill the user just said belongs somewhere else. When the
    /// destination already owns the same id or display name the arriving skill
    /// is renamed, so both survive under names that tell them apart. The
    /// arriving document's id is read back from a scan by path, because a
    /// skill's id can come from its name rather than its file stem, and the
    /// state is written only once that record exists. A landing the scan would
    /// hide is rolled back to the source instead of stranding the skill.
    pub fn transfer(
        &mut self,
        id: &str,
        from: &CapabilityTarget,
        to: &CapabilityTarget,
    ) -> Result<UserSkillRecord> {
        let Some(source) = self.find(id, Some(from.level), from.project_path.as_deref())? else {
            bail!("SKILL_INVALID: unknown skill \"{id}\"");
        };
        if source.source == LINKED_SOURCE || source.source == LINKED_IMPORT_SOURCE {
            bail!("SKILL_READONLY: a skill from an extra path cannot be moved here");
        }
        if from.same_directory(to) {
            return Ok(source);
        }
        let source_path = PathBuf::from(&source.path);
        let raw = fs::read_to_string(&source_path)
            .with_context(|| format!("read {}", source_path.display()))?;
        if raw.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        let existing = self.list(to.level, to.project_path.as_deref())?;
        if existing.len() >= MAX_SKILLS {
            bail!("SKILL_INVALID: at most {MAX_SKILLS} skills");
        }

        let source_dir = self.skills_directory(from.level, from.project_path.as_deref())?;
        let directory = self.skills_directory(to.level, to.project_path.as_deref())?;
        let owned_dir = directory_skill_root(&source_path, &source_dir);
        let shared_directory = owned_dir.is_some();
        let placement = plan_skill_placement(&source, &directory, shared_directory, &existing)
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: no free name at the destination"))?;
        let document_path = skill_document_path(&directory, &placement.stem, shared_directory);
        let source_unit = owned_dir.clone().unwrap_or_else(|| source_path.clone());
        let target_unit = if shared_directory {
            match document_path.parent() {
                Some(parent) => parent.to_path_buf(),
                None => directory.join(&placement.stem),
            }
        } else {
            document_path.clone()
        };
        let rewritten = placement.name != source.name;

        if !rewritten {
            move_capability_file(&source_unit, &target_unit)?;
        } else {
            let document = rewrite_document_name(&raw, &placement.name);
            if document.len() > MAX_SKILL_BYTES {
                bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
            }
            if shared_directory && target_unit.exists() {
                // The destination id is unique at this level, so `<stem>/` is a
                // directory this move creates. Anything already sitting there
                // is not this skill's to overwrite or merge into.
                bail!(
                    "SKILL_INVALID: destination already exists: {}",
                    target_unit.display()
                );
            }
            if let Some(parent) = document_path.parent() {
                fs::create_dir_all(parent)?;
            }
            // Written before the source is removed, so a failure in between
            // leaves a shadowed duplicate rather than no skill at all.
            fs::write(&document_path, document)
                .with_context(|| format!("write {}", document_path.display()))?;
            if let Some(dir) = &owned_dir {
                // Only the document travelled; resources beside it are part of
                // the skill, so the rest of the directory follows. The landing
                // directory is new, so overwriting a same-named leftover from
                // an interrupted move is safe.
                copy_directory_tree(dir, &target_unit, true)?;
                fs::remove_dir_all(dir)
                    .map_err(|error| anyhow::anyhow!("remove {}: {error}", dir.display()))?;
            } else {
                fs::remove_file(&source_path)
                    .map_err(|error| anyhow::anyhow!("remove {}: {error}", source_path.display()))?;
            }
        }

        // The record is resolved by path, never by the planned stem: the scan
        // derives the arriving document's id from its name, and the name's slug
        // is not necessarily the file stem this move chose.
        let landed = self
            .list(to.level, to.project_path.as_deref())?
            .into_iter()
            .find(|record| same_document(&record.path, &document_path));
        let Some(moved) = landed else {
            // The document is on disk but the scan will not list it (empty
            // body, over the byte limit, or shadowed by a same-id document).
            // The source is already gone, so the move has to be undone: put the
            // unit back where it came from and restore the original bytes,
            // because the rewritten name would give the restored document a
            // different id. State was never written, so nothing else changes.
            move_capability_file(&target_unit, &source_unit).map_err(|error| {
                anyhow::anyhow!(
                    "SKILL_INVALID: the moved skill was not found and could not be restored to {}: {error}",
                    source_unit.display()
                )
            })?;
            fs::write(&source_path, &raw)
                .with_context(|| format!("restore {}", source_path.display()))?;
            bail!("SKILL_INVALID: moved skill was not found");
        };
        set_moved_capability_state(
            &mut self.state,
            SKILL_KIND,
            from.level,
            &source.id,
            source.project_path.as_deref(),
            to,
            &moved.id,
            source.enabled,
        )?;
        self.find(&moved.id, Some(to.level), to.project_path.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: moved skill was not found"))
    }
}

impl UserSkillRegistry {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            state: CapabilityState::new(data_dir, SKILL_KIND),
            roots: SkillRoots::new(data_dir),
            global_skills_dir: None,
        }
    }

    #[cfg(test)]
    pub fn with_global_skills_dir(mut self, dir: PathBuf) -> Self {
        self.global_skills_dir = Some(dir);
        self
    }

    fn skills_directory(
        &self,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<PathBuf> {
        if level == CapabilityLevel::Global {
            if let Some(dir) = &self.global_skills_dir {
                return Ok(dir.clone());
            }
        }
        capability_dir(level, project_path, "skills")
    }

    /// Extra directories whose skills are referenced read-only.
    pub fn roots(&self) -> Vec<String> {
        self.roots.list().to_vec()
    }

    pub fn add_root(&mut self, path: &str) -> Result<Vec<String>> {
        self.roots.add(path)
    }

    pub fn remove_root(&mut self, path: &str) -> Result<Vec<String>> {
        self.roots.remove(path)
    }

    fn scan_level(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
        effective_project: Option<&str>,
    ) -> Result<Vec<UserSkillRecord>> {
        let directory = self.skills_directory(level, project_path)?;
        let mut local = Vec::new();
        collect_skill_paths(&directory, &mut local);
        local.sort();
        let mut paths: Vec<(PathBuf, bool)> =
            local.into_iter().map(|path| (path, false)).collect();
        if level == CapabilityLevel::Global {
            // Extra paths are global-only and read live, so edits made by the
            // other agent show up on the next list without a re-import.
            for root in self.roots.list() {
                let mut linked = Vec::new();
                collect_skill_paths(Path::new(root), &mut linked);
                linked.sort();
                paths.extend(linked.into_iter().map(|path| (path, true)));
            }
        }

        let owner_project_path = if level == CapabilityLevel::Project {
            project_path.map(normalize_project_path)
        } else {
            None
        };
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        for (path, linked) in paths {
            let raw = match fs::read_to_string(&path) {
                Ok(raw) if raw.len() <= MAX_SKILL_BYTES => raw,
                _ => continue,
            };
            let (front, body) = parse_front_matter(&raw);
            if body.trim().is_empty() {
                continue;
            }
            let fallback = path_stem_for_id(&path);
            let name = clip(
                front.get("name").map(String::as_str).unwrap_or(&fallback),
                MAX_NAME_CHARS,
            );
            if name.is_empty() {
                continue;
            }
            let id = capability_id(&name, &path, 64);
            if !valid_id(&id) || !seen.insert(id.clone()) {
                continue;
            }
            let scope = scope_for(level, owner_project_path.as_deref());
            let enabled = self
                .state
                .enabled(SKILL_KIND, level, &id, effective_project);
            let description = front
                .get("description")
                .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
                .filter(|value| !value.is_empty());
            let updated_at = file_timestamp(&path);
            records.push(UserSkillRecord {
                id,
                name,
                level: Some(level.as_str().to_string()),
                project_path: owner_project_path.clone(),
                description,
                enabled,
                scope,
                source: if linked {
                    LINKED_SOURCE
                } else if imported_skill_link(&path, &directory).is_some() {
                    LINKED_IMPORT_SOURCE
                } else {
                    "imported"
                }.into(),
                path: path.to_string_lossy().to_string(),
                size_bytes: raw.len() as u64,
                created_at: updated_at.clone(),
                updated_at,
            });
        }
        let ids = records.iter().map(|record| record.id.clone()).collect();
        self.state.prune(SKILL_KIND, level, project_path, &ids)?;
        records.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(records)
    }

    pub fn list(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Vec<UserSkillRecord>> {
        let selected = project_path.map(normalize_project_path);
        self.scan_level(level, project_path, selected.as_deref())
    }

    /// Return the effective user skill catalog. A project document shadows a
    /// global document with the same normalized name.
    pub fn active_for(&mut self, project_path: Option<&str>) -> Result<Vec<UserSkillRecord>> {
        let selected = project_path.map(normalize_project_path);
        let global = self.scan_level(CapabilityLevel::Global, None, selected.as_deref())?;
        let project = selected
            .as_deref()
            .map(|path| self.scan_level(CapabilityLevel::Project, Some(path), Some(path)))
            .transpose()?
            .unwrap_or_default();
        Ok(merge_active_records(global, project))
    }

    fn find(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<UserSkillRecord>> {
        if let Some(level) = level {
            return Ok(self
                .list(level, project_path)?
                .into_iter()
                .find(|record| record.id == id));
        }
        if let Some(project) = project_path {
            if let Some(record) = self
                .list(CapabilityLevel::Project, Some(project))?
                .into_iter()
                .find(|record| record.id == id)
            {
                return Ok(Some(record));
            }
        }
        Ok(self
            .list(CapabilityLevel::Global, project_path)?
            .into_iter()
            .find(|record| record.id == id))
    }

    pub fn create(&mut self, input: UserSkillInput) -> Result<UserSkillRecord> {
        let (level, project_path) = level_and_project(&input)?;
        let directory = capability_dir(level, project_path.as_deref(), "skills")?;
        let name = clip(input.name.as_deref().unwrap_or_default(), MAX_NAME_CHARS);
        if name.is_empty() {
            bail!("SKILL_INVALID: name is required");
        }
        let id = input
            .id
            .as_deref()
            .filter(|value| valid_id(value))
            .map(str::to_string)
            .unwrap_or_else(|| slugify(&name, 64));
        if !valid_id(&id) {
            bail!("SKILL_INVALID: invalid id");
        }
        if self
            .list(level, project_path.as_deref())?
            .iter()
            .any(|record| record.id == id || record.name.eq_ignore_ascii_case(&name))
        {
            bail!("SKILL_INVALID: a skill with this name already exists at this level");
        }
        if self.list(level, project_path.as_deref())?.len() >= MAX_SKILLS {
            bail!("SKILL_INVALID: at most {MAX_SKILLS} skills");
        }
        let body = input
            .body
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| default_body(&name));
        let description = input
            .description
            .as_deref()
            .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
            .filter(|value| !value.is_empty());
        let document = render_document(&name, description.as_deref(), &body);
        if document.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{id}.md"));
        fs::write(&path, &document).with_context(|| format!("write {}", path.display()))?;
        if input.enabled == Some(false) {
            self.state
                .set_enabled(SKILL_KIND, level, &id, project_path.as_deref(), false)?;
        }
        self.find(&id, Some(level), project_path.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: created skill was not found"))
    }

    /// Import a Markdown skill from an external location. `input.shape` picks
    /// between the single-file (`<id>.md`) form and the Anthropic-style
    /// directory form (`<name>/SKILL.md` plus resources); when absent, a
    /// directory source is treated as `"dir"` and a regular file as `"file"`.
    /// `input.mode` chooses between `"copy"` (default, byte-for-byte replica)
    /// and `"link"` (symlink so external edits are picked up on next scan).
    /// The catalog cap and the per-document byte cap are enforced up front so a
    /// batch import never leaves partial state.
    pub fn import(&mut self, source: &str, input: UserSkillInput) -> Result<UserSkillRecord> {
        let source_path = PathBuf::from(source);
        let mode = ImportMode::parse(input.mode.as_deref())?;
        let shape = match input.shape.as_deref() {
            Some(value) => ImportShape::parse(value)?,
            None => {
                if source_path.is_dir() {
                    ImportShape::Dir
                } else if source_path.is_file() {
                    ImportShape::File
                } else {
                    bail!("SKILL_INVALID: import source does not exist");
                }
            }
        };
        let (level, project_path) = level_and_project(&input)?;
        let existing = self.list(level, project_path.as_deref())?;
        if existing.len() >= MAX_SKILLS {
            bail!("SKILL_INVALID: at most {MAX_SKILLS} skills");
        }
        let directory = capability_dir(level, project_path.as_deref(), "skills")?;
        fs::create_dir_all(&directory)?;

        match shape {
            ImportShape::File => self.import_file(
                &source_path,
                &input,
                level,
                project_path.as_deref(),
                mode,
                &directory,
                &existing,
            ),
            ImportShape::Dir => self.import_dir(
                &source_path,
                &input,
                level,
                project_path.as_deref(),
                mode,
                &directory,
                &existing,
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn import_file(
        &mut self,
        source_path: &Path,
        input: &UserSkillInput,
        level: CapabilityLevel,
        project_path: Option<&str>,
        mode: ImportMode,
        directory: &Path,
        existing: &[UserSkillRecord],
    ) -> Result<UserSkillRecord> {
        if !source_path.is_file() {
            bail!("SKILL_INVALID: import file source does not exist");
        }
        let raw = fs::read_to_string(source_path)
            .with_context(|| format!("read {}", source_path.display()))?;
        if raw.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        let (front, body) = parse_front_matter(&raw);
        if body.trim().is_empty() {
            bail!("SKILL_INVALID: document is empty");
        }
        let fallback = path_stem_for_id(source_path);
        let name = clip(
            front.get("name").map(String::as_str).unwrap_or(&fallback),
            MAX_NAME_CHARS,
        );
        if name.is_empty() {
            bail!("SKILL_INVALID: the file needs a name");
        }
        let id = input
            .id
            .as_deref()
            .filter(|value| valid_id(value))
            .map(str::to_string)
            .unwrap_or_else(|| capability_id(&name, source_path, 64));
        if !valid_id(&id) {
            bail!("SKILL_INVALID: the file needs a name or a valid id");
        }
        if existing
            .iter()
            .any(|record| record.id == id || record.name.eq_ignore_ascii_case(&name))
        {
            bail!("SKILL_INVALID: a skill with this name already exists at this level");
        }
        let target = directory.join(format!("{id}.md"));
        place_file(source_path, &target, mode)?;
        self.finish_import(&id, level, project_path, input.enabled)
    }

    #[allow(clippy::too_many_arguments)]
    fn import_dir(
        &mut self,
        source_dir: &Path,
        input: &UserSkillInput,
        level: CapabilityLevel,
        project_path: Option<&str>,
        mode: ImportMode,
        directory: &Path,
        existing: &[UserSkillRecord],
    ) -> Result<UserSkillRecord> {
        if !source_dir.is_dir() {
            bail!("SKILL_INVALID: import directory source does not exist");
        }
        let skill_file = source_dir.join("SKILL.md");
        if !skill_file.is_file() {
            bail!("SKILL_INVALID: directory import needs a SKILL.md at the root");
        }
        let raw = fs::read_to_string(&skill_file)
            .with_context(|| format!("read {}", skill_file.display()))?;
        if raw.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: SKILL.md exceeds {MAX_SKILL_BYTES} bytes");
        }
        let (front, body) = parse_front_matter(&raw);
        if body.trim().is_empty() {
            bail!("SKILL_INVALID: SKILL.md is empty");
        }
        // Directory name is the natural fallback id; file stem "SKILL" is not.
        let dir_name = source_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let name = clip(
            front.get("name").map(String::as_str).unwrap_or(dir_name),
            MAX_NAME_CHARS,
        );
        if name.is_empty() {
            bail!("SKILL_INVALID: SKILL.md needs a name");
        }
        let id = input
            .id
            .as_deref()
            .filter(|value| valid_id(value))
            .map(str::to_string)
            .unwrap_or_else(|| {
                // Prefer the directory basename so nested resources keep their
                // relative paths intact under `<capability_dir>/skills/<id>/`.
                let fallback_path = source_dir.join(format!("{name}"));
                capability_id(&name, &fallback_path, 64)
            });
        if !valid_id(&id) {
            bail!("SKILL_INVALID: the directory needs a name or a valid id");
        }
        if existing
            .iter()
            .any(|record| record.id == id || record.name.eq_ignore_ascii_case(&name))
        {
            bail!("SKILL_INVALID: a skill with this name already exists at this level");
        }
        let target_dir = directory.join(&id);
        if target_dir.exists() {
            bail!(
                "SKILL_INVALID: destination already exists: {}",
                target_dir.display()
            );
        }
        place_dir(source_dir, &target_dir, mode)?;
        self.finish_import(&id, level, project_path, input.enabled)
    }

    fn finish_import(
        &mut self,
        id: &str,
        level: CapabilityLevel,
        project_path: Option<&str>,
        enabled: Option<bool>,
    ) -> Result<UserSkillRecord> {
        if enabled == Some(false) {
            self.state
                .set_enabled(SKILL_KIND, level, id, project_path, false)?;
        }
        self.find(id, Some(level), project_path)?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: imported skill was not found"))
    }

    pub fn update(&mut self, id: &str, input: UserSkillInput) -> Result<Option<UserSkillRecord>> {
        let level = input
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?;
        let record = self.find(id, level, input.project_path.as_deref())?;
        let Some(record) = record else {
            return Ok(None);
        };
        if record.source == LINKED_SOURCE || record.source == LINKED_IMPORT_SOURCE {
            bail!("SKILL_READONLY: a skill from an extra path cannot be edited here");
        }
        let raw = fs::read_to_string(&record.path)?;
        let (front, old_body) = parse_front_matter(&raw);
        let name = input
            .name
            .as_deref()
            .map(|value| clip(value, MAX_NAME_CHARS))
            .filter(|value| !value.is_empty())
            .or_else(|| front.get("name").cloned())
            .unwrap_or(record.name.clone());
        let description = match input.description.as_deref() {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => Some(clip(value, MAX_DESCRIPTION_CHARS)),
            None => record.description.clone(),
        };
        let body = input.body.unwrap_or(old_body);
        if body.trim().is_empty() {
            bail!("SKILL_INVALID: document is empty");
        }
        let document = render_document(&name, description.as_deref(), &body);
        if document.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        fs::write(&record.path, document)?;
        if let Some(enabled) = input.enabled {
            self.state.set_enabled(
                SKILL_KIND,
                record
                    .level
                    .as_deref()
                    .and_then(|value| CapabilityLevel::parse(Some(value)).ok())
                    .unwrap_or(CapabilityLevel::Global),
                id,
                record.project_path.as_deref(),
                enabled,
            )?;
        }
        self.find(id, level, record.project_path.as_deref())
    }

    pub fn read(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<(UserSkillRecord, String)>> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        if raw.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        let (_, body) = parse_front_matter(&raw);
        Ok(Some((record, body)))
    }

    pub fn remove(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<bool> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(false);
        };
        if record.source == LINKED_SOURCE {
            bail!("SKILL_READONLY: a skill from an extra path cannot be removed here");
        }
        let level = record
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        if record.source == LINKED_IMPORT_SOURCE {
            let directory = self.skills_directory(level, record.project_path.as_deref())?;
            let link = imported_skill_link(Path::new(&record.path), &directory)
                .ok_or_else(|| anyhow::anyhow!("SKILL_READONLY: imported link is no longer available"))?;
            remove_imported_skill_link(&link)?;
        } else {
            fs::remove_file(&record.path)?;
        }
        let _ = self.find(id, Some(level), record.project_path.as_deref())?;
        Ok(true)
    }

    pub fn set_enabled(
        &mut self,
        id: &str,
        enabled: bool,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<UserSkillRecord>> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(None);
        };
        let record_level = record
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        self.state.set_enabled(
            SKILL_KIND,
            record_level,
            &record.id,
            project_path.or(record.project_path.as_deref()),
            enabled,
        )?;
        self.find(
            &record.id,
            Some(record_level),
            project_path.or(record.project_path.as_deref()),
        )
    }

    pub fn set_scope(
        &mut self,
        id: &str,
        scope: ActivationScope,
    ) -> Result<Option<UserSkillRecord>> {
        // Scope is no longer persisted in capability files. Keep this RPC
        // harmless for older callers and return the scanned record.
        let _ = scope;
        self.find(id, None, None)
    }
}

fn scope_for(level: CapabilityLevel, project_path: Option<&str>) -> ActivationScope {
    match level {
        CapabilityLevel::Global => ActivationScope::default(),
        CapabilityLevel::Project => ActivationScope {
            mode: crate::activation::ActivationMode::Projects,
            projects: project_path.into_iter().map(str::to_string).collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_capabilities::test_support;
    use tempfile::tempdir;

    fn input(name: &str, level: &str, project_path: Option<&str>) -> UserSkillInput {
        UserSkillInput {
            name: Some(name.into()),
            level: Some(level.into()),
            project_path: project_path.map(str::to_string),
            description: Some("Check the relevant files".into()),
            body: Some("Do the thing.".into()),
            ..Default::default()
        }
    }
    #[test]
    fn imports_a_directory_with_skill_md_in_copy_mode() {
        let app = tempdir().unwrap();
        let source_dir = app.path().join("incoming/example-skill");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("SKILL.md"), "---\nname: Example\ndescription: Anthropic-style skill\n---\n\nBody.\n").unwrap();
        fs::write(source_dir.join("resource.txt"), "extra\n").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry.import(source_dir.to_str().unwrap(), input("Ignored", "project", Some(app.path().to_str().unwrap()))).unwrap();
        let normalized_project = crate::agent_capabilities::normalize_project_path(app.path().to_str().unwrap());
        let expected_root = crate::agent_capabilities::capability_dir(CapabilityLevel::Project, Some(&normalized_project), "skills").unwrap().join("example");
        assert!(expected_root.is_dir());
        assert!(expected_root.join("SKILL.md").is_file());
        assert!(expected_root.join("resource.txt").is_file());
        assert_eq!(record.name, "Example");
        assert_eq!(record.path, expected_root.join("SKILL.md").to_string_lossy());
        assert!(source_dir.join("SKILL.md").is_file());
    }

    #[test]
    fn imports_a_directory_with_skill_md_in_link_mode() {
        let app = tempdir().unwrap();
        let source_dir = app.path().join("incoming/linked-skill");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("SKILL.md"), "---\nname: Linked\n---\n\nBody.\n").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Ignored", "project", Some(app.path().to_str().unwrap()));
        payload.mode = Some("link".into());
        let record = registry.import(source_dir.to_str().unwrap(), payload).unwrap();
        let normalized_project = crate::agent_capabilities::normalize_project_path(app.path().to_str().unwrap());
        let expected_root = crate::agent_capabilities::capability_dir(CapabilityLevel::Project, Some(&normalized_project), "skills").unwrap().join("linked");
        assert!(fs::symlink_metadata(&expected_root).unwrap().file_type().is_symlink());
        assert!(expected_root.join("SKILL.md").is_file());
        assert_eq!(record.name, "Linked");
        assert_eq!(record.source, LINKED_IMPORT_SOURCE);
        let original = fs::read(source_dir.join("SKILL.md")).unwrap();
        let error = registry.update(&record.id, input("Changed", "project", Some(app.path().to_str().unwrap()))).unwrap_err();
        assert!(error.to_string().contains("SKILL_READONLY"));
        assert_eq!(fs::read(source_dir.join("SKILL.md")).unwrap(), original);
        assert!(registry.remove(&record.id, Some(CapabilityLevel::Project), Some(app.path().to_str().unwrap())).unwrap());
        assert!(!expected_root.exists());
        assert_eq!(fs::read(source_dir.join("SKILL.md")).unwrap(), original);
    }

    #[test]
    fn imports_a_file_in_link_mode() {
        let app = tempdir().unwrap();
        let source = app.path().join("incoming/notes.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "---\nname: Notes\ndescription: linked file\n---\n\nBody.\n").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Ignored", "project", Some(app.path().to_str().unwrap()));
        payload.mode = Some("link".into());
        let record = registry.import(source.to_str().unwrap(), payload).unwrap();
        let normalized_project = crate::agent_capabilities::normalize_project_path(app.path().to_str().unwrap());
        let expected = crate::agent_capabilities::capability_dir(CapabilityLevel::Project, Some(&normalized_project), "skills").unwrap().join("notes.md");
        assert!(fs::symlink_metadata(&expected).unwrap().file_type().is_symlink());
        assert_eq!(record.name, "Notes");
        assert_eq!(record.source, LINKED_IMPORT_SOURCE);
        let original = fs::read(&source).unwrap();
        assert!(registry.remove(&record.id, Some(CapabilityLevel::Project), Some(app.path().to_str().unwrap())).unwrap());
        assert!(!expected.exists());
        assert_eq!(fs::read(&source).unwrap(), original);
    }

    #[test]
    fn directory_import_without_skill_md_is_rejected() {
        let app = tempdir().unwrap();
        let source_dir = app.path().join("incoming/no-skill");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("readme.md"), "just docs\n").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let err = registry.import(source_dir.to_str().unwrap(), input("Ignored", "project", Some(app.path().to_str().unwrap()))).unwrap_err().to_string();
        assert!(err.contains("SKILL_INVALID") && err.contains("SKILL.md"), "err = {err}");
    }

    #[test]
    fn unknown_import_mode_is_rejected() {
        let app = tempdir().unwrap();
        let source = app.path().join("incoming.md");
        fs::write(&source, "---\nname: Any\n---\n\nBody.\n").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Ignored", "project", Some(app.path().to_str().unwrap()));
        payload.mode = Some("teleport".into());
        let err = registry.import(source.to_str().unwrap(), payload).unwrap_err().to_string();
        assert!(err.contains("unknown import mode"), "err = {err}");
    }

    #[test]
    fn shape_dir_requires_a_directory_source() {
        let app = tempdir().unwrap();
        let source = app.path().join("incoming.md");
        fs::write(&source, "---\nname: X\n---\n\nBody.\n").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Ignored", "project", Some(app.path().to_str().unwrap()));
        payload.shape = Some("dir".into());
        let err = registry.import(source.to_str().unwrap(), payload).unwrap_err().to_string();
        assert!(err.contains("SKILL_INVALID") && err.contains("directory"), "err = {err}");
    }


    #[test]
    fn imports_one_file_into_the_selected_agents_directory() {
        let app = tempdir().unwrap();
        let source = app.path().join("incoming.md");
        let raw = "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n";
        fs::write(&source, raw).unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry
            .import(
                source.to_str().unwrap(),
                input("Ignored", "project", Some(app.path().to_str().unwrap())),
            )
            .unwrap();
        let target = app.path().join(".agents/skills/review.md");
        assert_eq!(record.level.as_deref(), Some("project"));
        let normalized_project =
            crate::agent_capabilities::normalize_project_path(app.path().to_str().unwrap());
        let expected = crate::agent_capabilities::capability_dir(
            CapabilityLevel::Project,
            Some(&normalized_project),
            "skills",
        )
        .unwrap()
        .join("review.md");
        assert_eq!(record.path, expected.to_string_lossy());
        assert_eq!(fs::read_to_string(target).unwrap(), raw);
        assert!(source.is_file());
    }

    #[test]
    fn project_skills_shadow_global_skills_by_name() {
        let app = tempdir().unwrap();
        let global = app.path().join("global");
        let project = app.path().join("project");
        fs::create_dir_all(global.join("skills")).unwrap();
        fs::create_dir_all(project.join(".agents/skills")).unwrap();
        fs::write(
            global.join("skills/review.md"),
            "---\nname: Review\n---\n\nGlobal\n",
        )
        .unwrap();
        fs::write(
            project.join(".agents/skills/review.md"),
            "---\nname: Review\n---\n\nProject\n",
        )
        .unwrap();
        let (fields, body) = parse_front_matter(
            &fs::read_to_string(project.join(".agents/skills/review.md")).unwrap(),
        );
        assert_eq!(fields.get("name").map(String::as_str), Some("Review"));
        assert_eq!(body, "Project");
    }

    #[test]
    fn disabled_project_skill_shadows_global_skill() {
        let global = UserSkillRecord {
            id: "review".into(),
            name: "Review".into(),
            level: Some("global".into()),
            project_path: None,
            description: Some("Global".into()),
            enabled: true,
            scope: ActivationScope::default(),
            source: "imported".into(),
            path: "/global/review.md".into(),
            size_bytes: 1,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let mut project = global.clone();
        project.level = Some("project".into());
        project.project_path = Some("/repo".into());
        project.enabled = false;

        let active = merge_active_records(vec![global.clone()], vec![project]);
        assert!(active.is_empty());

        let mut project = global.clone();
        project.level = Some("project".into());
        project.project_path = Some("/repo".into());
        project.path = "/repo/.agents/skills/review.md".into();
        let active = merge_active_records(vec![global], vec![project.clone()]);
        assert_eq!(active, vec![project]);
    }

    #[test]
    fn capability_state_is_not_written_into_skill_documents() {
        let app = tempdir().unwrap();
        let mut state = CapabilityState::new(app.path(), SKILL_KIND);
        state
            .set_enabled(
                SKILL_KIND,
                CapabilityLevel::Project,
                "review",
                Some("/repo"),
                false,
            )
            .unwrap();
        assert!(!app
            .path()
            .join("agent-capabilities/skills.json")
            .to_string_lossy()
            .contains(".agents"));
    }

    #[test]
    fn import_uses_parent_directory_when_name_is_not_ascii() {
        let app = tempdir().unwrap();
        let source_dir = app.path().join("incoming/code-review");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("SKILL.md");
        fs::write(
            &source,
            "---\nname: 代码审查\ndescription: >\n  Review diffs before merge.\n---\n\nCheck the patch.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry
            .import(
                source.to_str().unwrap(),
                input("Ignored", "project", Some(app.path().to_str().unwrap())),
            )
            .unwrap();
        assert_eq!(record.id, "code-review");
        assert_eq!(record.name, "代码审查");
        assert_eq!(
            record.description.as_deref(),
            Some("Review diffs before merge.")
        );
        let listed = registry
            .list(CapabilityLevel::Project, Some(app.path().to_str().unwrap()))
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "code-review");
        assert_eq!(listed[0].name, "代码审查");
    }

    #[test]
    fn directory_skills_do_not_collide_on_the_skill_file_stem() {
        let app = tempdir().unwrap();
        let project = app.path().to_str().unwrap();
        fs::create_dir_all(app.path().join(".agents/skills/pdf")).unwrap();
        fs::create_dir_all(app.path().join(".agents/skills/docx")).unwrap();
        fs::write(
            app.path().join(".agents/skills/pdf/SKILL.md"),
            "# PDF\n\nExtract text.\n",
        )
        .unwrap();
        fs::write(
            app.path().join(".agents/skills/docx/SKILL.md"),
            "# DOCX\n\nEdit documents.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let listed = registry
            .list(CapabilityLevel::Project, Some(project))
            .unwrap();
        let ids: Vec<_> = listed.iter().map(|record| record.id.as_str()).collect();
        assert_eq!(ids, vec!["docx", "pdf"]);
    }

    #[test]
    fn extra_roots_are_listed_and_read_only() {
        let app = tempdir().unwrap();
        let external = app.path().join("other-agent");
        fs::create_dir_all(external.join("pdf-review")).unwrap();
        fs::write(
            external.join("pdf-review/SKILL.md"),
            "---\nname: PDF Review\n---\n\nCheck the PDF.\n",
        )
        .unwrap();
        fs::write(
            external.join("standalone.md"),
            "---\nname: Standalone\n---\n\nBody.\n",
        )
        .unwrap();

        let mut registry = UserSkillRegistry::new(app.path())
            .with_global_skills_dir(app.path().join("global/skills"));
        registry.add_root(external.to_str().unwrap()).unwrap();

        let listed = registry.list(CapabilityLevel::Global, None).unwrap();
        let names: Vec<_> = listed.iter().map(|record| record.name.as_str()).collect();
        // Both the `<skill>/SKILL.md` and the direct `*.md` shapes are picked up.
        assert!(names.contains(&"PDF Review"));
        assert!(names.contains(&"Standalone"));
        assert!(listed.iter().all(|record| record.source == LINKED_SOURCE));
        // Referenced skills are usable without an explicit enable step.
        assert!(listed.iter().all(|record| record.enabled));

        let id = listed[0].id.clone();
        assert!(registry
            .update(&id, input("Renamed", "global", None))
            .is_err());
        assert!(registry
            .remove(&id, Some(CapabilityLevel::Global), None)
            .is_err());
        let project = app.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let error = registry.transfer(
            &id,
            &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            &CapabilityTarget::new(CapabilityLevel::Project, project.to_str()).unwrap(),
        ).unwrap_err();
        assert!(error.to_string().contains("SKILL_READONLY"));
        assert!(fs::read_to_string(external.join("pdf-review/SKILL.md")).is_ok());
    }

    #[test]
    fn project_skills_shadow_a_linked_skill_with_the_same_name() {
        let app = tempdir().unwrap();
        let external = app.path().join("other-agent");
        let project = app.path().join("project");
        fs::create_dir_all(&external).unwrap();
        fs::create_dir_all(project.join(".agents/skills")).unwrap();
        fs::write(
            external.join("review.md"),
            "---\nname: Review\n---\n\nLinked\n",
        )
        .unwrap();
        fs::write(
            project.join(".agents/skills/review.md"),
            "---\nname: Review\n---\n\nProject\n",
        )
        .unwrap();

        let mut registry = UserSkillRegistry::new(app.path())
            .with_global_skills_dir(app.path().join("global/skills"));
        registry.add_root(external.to_str().unwrap()).unwrap();
        let active = registry.active_for(Some(project.to_str().unwrap())).unwrap();

        assert_eq!(active.len(), 1);
        assert_eq!(active[0].source, "imported");
        assert_eq!(
            fs::read_to_string(&active[0].path).unwrap().trim(),
            "---\nname: Review\n---\n\nProject"
        );
    }

    /// A global skill document plus the project directory it can move into.
    fn skill_home(home: &Path) {
        fs::create_dir_all(home.join("skills")).unwrap();
    }

    fn project_dir(project: &Path) -> String {
        project.to_str().unwrap().to_string()
    }

    fn record(id: &str, name: &str) -> UserSkillRecord {
        UserSkillRecord {
            id: id.into(),
            name: name.into(),
            level: None,
            project_path: None,
            description: None,
            enabled: true,
            scope: ActivationScope::default(),
            source: "imported".into(),
            path: String::new(),
            size_bytes: 0,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    /// A level may never list two records with the same id or the same name:
    /// either collision makes one of them disappear from the catalog.
    fn assert_unique_records(records: &[UserSkillRecord]) {
        let ids: HashSet<&str> = records.iter().map(|record| record.id.as_str()).collect();
        let names: HashSet<String> = records
            .iter()
            .map(|record| record.name.to_lowercase())
            .collect();
        assert_eq!(ids.len(), records.len(), "duplicate ids: {records:?}");
        assert_eq!(names.len(), records.len(), "duplicate names: {records:?}");
    }

    #[test]
    fn a_global_skill_moves_into_a_project() {
        let home = tempdir().unwrap();
        let app = tempdir().unwrap();
        let project = tempdir().unwrap();
        let project_path = project_dir(project.path());
        test_support::with_global_agents(home.path(), || {
            skill_home(home.path());
            fs::write(
                home.path().join("skills/review.md"),
                "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n",
            )
            .unwrap();
            let mut registry = UserSkillRegistry::new(app.path());

            let moved = registry
                .transfer(
                    "review",
                    &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                    &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                )
                .unwrap();

            assert_eq!(moved.id, "review");
            assert_eq!(moved.level.as_deref(), Some("project"));
            assert_eq!(moved.project_path.as_deref(), Some(project_path.as_str()));
            assert!(!home.path().join("skills/review.md").exists());
            let target = project.path().join(".agents/skills/review.md");
            assert_eq!(
                fs::read_to_string(&target).unwrap(),
                "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n"
            );
            assert!(registry.list(CapabilityLevel::Global, None).unwrap().is_empty());
        });
    }

    #[test]
    fn a_name_collision_rewrites_only_the_documents_name_line() {
        let home = tempdir().unwrap();
        let app = tempdir().unwrap();
        let project = tempdir().unwrap();
        let project_path = project_dir(project.path());
        test_support::with_global_agents(home.path(), || {
            skill_home(home.path());
            fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
            // Extra frontmatter and deliberate body formatting: a renaming move
            // must not reformat the document the user only asked to relocate.
            let original = "---\nname: Review\nlicense: MIT\n---\n\n## Step 1\n\n   indented\n";
            fs::write(home.path().join("skills/review.md"), original).unwrap();
            fs::write(
                project.path().join(".agents/skills/review.md"),
                "---\nname: Review\n---\n\nProject copy\n",
            )
            .unwrap();
            let mut registry = UserSkillRegistry::new(app.path());

            let moved = registry
                .transfer(
                    "review",
                    &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                    &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                )
                .unwrap();

            assert_eq!(moved.id, "review-2");
            assert_eq!(moved.name, "Review (2)");
            let document =
                fs::read_to_string(project.path().join(".agents/skills/review-2.md")).unwrap();
            assert_eq!(
                document,
                "---\nname: Review (2)\nlicense: MIT\n---\n\n## Step 1\n\n   indented\n"
            );
            // The skill that was already there is untouched.
            assert_eq!(
                fs::read_to_string(project.path().join(".agents/skills/review.md")).unwrap(),
                "---\nname: Review\n---\n\nProject copy\n"
            );
        });
    }

    #[test]
    fn a_directory_skill_moves_with_its_resources() {
        let home = tempdir().unwrap();
        let app = tempdir().unwrap();
        let project = tempdir().unwrap();
        let project_path = project_dir(project.path());
        test_support::with_global_agents(home.path(), || {
            skill_home(home.path());
            let source = home.path().join("skills/pdf");
            fs::create_dir_all(source.join("templates")).unwrap();
            fs::write(source.join("SKILL.md"), "# PDF\n\nExtract text.\n").unwrap();
            fs::write(source.join("templates/page.html"), "<p>page</p>").unwrap();
            let mut registry = UserSkillRegistry::new(app.path());

            let moved = registry
                .transfer(
                    "pdf",
                    &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                    &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                )
                .unwrap();

            assert_eq!(moved.id, "pdf");
            assert!(!source.exists());
            let target = project.path().join(".agents/skills/pdf");
            assert_eq!(
                fs::read_to_string(target.join("SKILL.md")).unwrap(),
                "# PDF\n\nExtract text.\n"
            );
            // The resource beside the document is part of the skill.
            assert_eq!(
                fs::read_to_string(target.join("templates/page.html")).unwrap(),
                "<p>page</p>"
            );
        });
    }

    #[test]
    fn a_renamed_directory_skill_keeps_its_resources() {
        let home = tempdir().unwrap();
        let app = tempdir().unwrap();
        let project = tempdir().unwrap();
        let project_path = project_dir(project.path());
        test_support::with_global_agents(home.path(), || {
            skill_home(home.path());
            fs::create_dir_all(project.path().join(".agents/skills/pdf")).unwrap();
            fs::write(
                project.path().join(".agents/skills/pdf/SKILL.md"),
                "# PDF\n\nProject copy.\n",
            )
            .unwrap();
            let source = home.path().join("skills/pdf");
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join("SKILL.md"), "# PDF\n\nGlobal copy.\n").unwrap();
            fs::write(source.join("notes.txt"), "keep me").unwrap();
            let mut registry = UserSkillRegistry::new(app.path());

            let moved = registry
                .transfer(
                    "pdf",
                    &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                    &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                )
                .unwrap();

            assert_eq!(moved.id, "pdf-2");
            assert!(!source.exists());
            let target = project.path().join(".agents/skills/pdf-2");
            assert_eq!(
                fs::read_to_string(target.join("notes.txt")).unwrap(),
                "keep me"
            );
            assert_eq!(
                fs::read_to_string(project.path().join(".agents/skills/pdf/SKILL.md")).unwrap(),
                "# PDF\n\nProject copy.\n"
            );
        });
    }

    #[test]
    fn a_disabled_project_skill_becomes_the_global_default() {
        let home = tempdir().unwrap();
        let app = tempdir().unwrap();
        let project = tempdir().unwrap();
        let project_path = project_dir(project.path());
        test_support::with_global_agents(home.path(), || {
            skill_home(home.path());
            let mut registry = UserSkillRegistry::new(app.path());
            let mut request = input("Review", "project", Some(&project_path));
            request.enabled = Some(false);
            registry.create(request).unwrap();

            let moved = registry
                .transfer(
                    "review",
                    &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                    &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                )
                .unwrap();

            assert_eq!(moved.level.as_deref(), Some("global"));
            assert!(!moved.enabled);
            assert!(home.path().join("skills/review.md").is_file());
            assert!(!project.path().join(".agents/skills/review.md").exists());
            // Off everywhere, because the document is off and its state is now
            // the global default rather than one project's leftover override.
            assert!(!registry
                .state
                .enabled(SKILL_KIND, CapabilityLevel::Global, "review", Some("/elsewhere")));
        });
    }

    #[test]
    fn a_skill_without_frontmatter_gains_a_name_when_it_has_to_rename() {
        let home = tempdir().unwrap();
        let app = tempdir().unwrap();
        let project = tempdir().unwrap();
        let project_path = project_dir(project.path());
        test_support::with_global_agents(home.path(), || {
            skill_home(home.path());
            fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
            // No frontmatter: the display name falls back to the file stem, so a
            // move that must rename has to open a block to carry the new name.
            fs::write(home.path().join("skills/review.md"), "# Review\n\nDo it.\n").unwrap();
            fs::write(
                project.path().join(".agents/skills/review.md"),
                "---\nname: Review\n---\n\nProject copy\n",
            )
            .unwrap();
            let mut registry = UserSkillRegistry::new(app.path());

            let moved = registry
                .transfer(
                    "review",
                    &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                    &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                )
                .unwrap();
            // With no stored name the display name is the file stem, so that is
            // what the suffix is applied to.
            assert_eq!(moved.id, "review-2");
            assert_eq!(moved.name, "review (2)");
            assert_eq!(
                fs::read_to_string(project.path().join(".agents/skills/review-2.md")).unwrap(),
                "---\nname: review (2)\n---\n\n# Review\n\nDo it.\n"
            );
        });
    }

    #[test]
    fn placement_uses_the_id_the_scan_will_derive_from_the_name() {
        let directory = tempdir().unwrap();
        let source = record("code-review", "代码审查");
        let existing = vec![record("code-review", "代码审查")];

        let placement = plan_skill_placement(&source, directory.path(), true, &existing).unwrap();
        assert_eq!(placement.name, "代码审查 (2)");
        // The rename's slug is `2`, not the file stem the move started from, so
        // that is what both the directory and the next scan will call it.
        assert_eq!(placement.stem, "2");
        let document = skill_document_path(directory.path(), &placement.stem, true);
        assert_eq!(capability_id(&placement.name, &document, 64), placement.stem);

        // A flat destination derives the same id from the `.md` stem.
        let placement = plan_skill_placement(&source, directory.path(), false, &existing).unwrap();
        let document = skill_document_path(directory.path(), &placement.stem, false);
        assert_eq!(capability_id(&placement.name, &document, 64), placement.stem);
    }

    #[test]
    fn placement_reports_exhaustion_instead_of_reusing_a_taken_name() {
        let directory = tempdir().unwrap();
        let source = record("review", "Review");
        let existing: Vec<UserSkillRecord> = (1..=MAX_ID_SUFFIX)
            .map(|ordinal| {
                record(
                    &format!("other-{ordinal}"),
                    &display_name_candidate("Review", ordinal, MAX_NAME_CHARS),
                )
            })
            .collect();
        // Every candidate the planner could use is already a displayed name, so
        // there is no collision-free placement and the move must refuse rather
        // than write a duplicate.
        assert!(plan_skill_placement(&source, directory.path(), false, &existing).is_none());
    }

    #[test]
    fn a_chinese_named_skill_moves_without_hiding_the_other_levels_copy() {
        let home = tempdir().unwrap();
        let app = tempdir().unwrap();
        let project = tempdir().unwrap();
        let project_path = project_dir(project.path());
        test_support::with_global_agents(home.path(), || {
            skill_home(home.path());
            fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
            // Both names slug to nothing, so each document's id comes from its
            // file stem — while the renamed candidate `代码审查 (2)` slugs to
            // `2`, which is nothing like the stem the old move would have used.
            fs::write(
                home.path().join("skills/code-review.md"),
                "---\nname: 代码审查\n---\n\nGlobal copy.\n",
            )
            .unwrap();
            fs::write(
                project.path().join(".agents/skills/code-review.md"),
                "---\nname: 代码审查\n---\n\nProject copy.\n",
            )
            .unwrap();
            let mut registry = UserSkillRegistry::new(app.path());

            let moved = registry
                .transfer(
                    "code-review",
                    &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                    &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                )
                .unwrap();

            assert_eq!(moved.id, "2");
            assert_eq!(moved.name, "代码审查 (2)");
            assert!(!home.path().join("skills/code-review.md").exists());
            assert_eq!(
                fs::read_to_string(project.path().join(".agents/skills/2.md")).unwrap(),
                "---\nname: 代码审查 (2)\n---\n\nGlobal copy.\n"
            );
            // The project's own copy is untouched and both documents are listed
            // under distinct ids and names.
            assert_eq!(
                fs::read_to_string(project.path().join(".agents/skills/code-review.md")).unwrap(),
                "---\nname: 代码审查\n---\n\nProject copy.\n"
            );
            let listed = registry
                .list(CapabilityLevel::Project, Some(&project_path))
                .unwrap();
            assert_eq!(listed.len(), 2);
            assert_unique_records(&listed);
            assert!(listed.iter().any(|record| record.name == "代码审查"));
            assert!(listed.iter().any(|record| record.name == "代码审查 (2)"));

            // The same document moves back to the global level under its new
            // name, keeping the id the scan gave it.
            let back = registry
                .transfer(
                    "2",
                    &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                    &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                )
                .unwrap();
            assert_eq!(back.id, "2");
            assert_eq!(back.name, "代码审查 (2)");
            assert!(home.path().join("skills/2.md").is_file());
            assert_unique_records(
                &registry
                    .list(CapabilityLevel::Project, Some(&project_path))
                    .unwrap(),
            );
        });
    }

    #[test]
    fn a_names_slug_is_not_used_when_that_id_belongs_to_another_document() {
        let home = tempdir().unwrap();
        let app = tempdir().unwrap();
        let project = tempdir().unwrap();
        let project_path = project_dir(project.path());
        test_support::with_global_agents(home.path(), || {
            skill_home(home.path());
            fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
            fs::write(
                home.path().join("skills/code-review.md"),
                "---\nname: 代码审查\n---\n\nGlobal copy.\n",
            )
            .unwrap();
            fs::write(
                project.path().join(".agents/skills/code-review.md"),
                "---\nname: 代码审查\n---\n\nProject copy.\n",
            )
            .unwrap();
            // This document's id is exactly the slug the renamed candidate
            // `代码审查 (2)` would produce, so that candidate cannot be used.
            fs::write(
                project.path().join(".agents/skills/2.md"),
                "---\nname: 2\n---\n\nTakes the id 2.\n",
            )
            .unwrap();
            let mut registry = UserSkillRegistry::new(app.path());

            let moved = registry
                .transfer(
                    "code-review",
                    &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                    &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                )
                .unwrap();

            assert_eq!(moved.name, "代码审查 (3)");
            assert_eq!(moved.id, "3");
            assert!(project.path().join(".agents/skills/3.md").is_file());
            assert_eq!(
                fs::read_to_string(project.path().join(".agents/skills/2.md")).unwrap(),
                "---\nname: 2\n---\n\nTakes the id 2.\n"
            );
            let listed = registry
                .list(CapabilityLevel::Project, Some(&project_path))
                .unwrap();
            assert_eq!(listed.len(), 3);
            assert_unique_records(&listed);
        });
    }
    #[test]
    fn rewriting_a_name_keeps_the_frontmatter_shaped_document_intact() {
        // The helper is unit-tested directly because it is the only place a move
        // edits a document, and every byte it does not touch is a byte the user
        // gets to keep.
        let with_extra_fields =
            "---\nlicense: MIT\nname: Review\nallowed-tools: Read\n---\n\nBody\n";
        assert_eq!(
            rewrite_document_name(with_extra_fields, "Review (2)"),
            "---\nlicense: MIT\nname: Review (2)\nallowed-tools: Read\n---\n\nBody\n"
        );
        assert_eq!(
            rewrite_document_name("---\r\nname: A\r\n---\r\n\r\nBody\r\n", "B"),
            "---\nname: B\n---\r\n\r\nBody\r\n"
        );
        assert_eq!(
            rewrite_document_name("no frontmatter\n", "B"),
            "---\nname: B\n---\n\nno frontmatter\n"
        );
        assert_eq!(
            rewrite_document_name("---\nname: A\nnever closed\n", "B"),
            "---\nname: B\n---\n\n---\nname: A\nnever closed\n"
        );
        // A newline in the name would break the block it is written into.
        assert_eq!(
            rewrite_document_name("---\nname: A\n---\n\nBody\n", "Two\nLines"),
            "---\nname: Two Lines\n---\n\nBody\n"
        );
        // The parser keeps the *last* `name:` line, so a stale second one must
        // be dropped: keeping it would make the old name win again on the next
        // scan, silently defeating the rename.
        assert_eq!(
            rewrite_document_name("---\nname: A\nname: B\n---\n\nBody\n", "C"),
            "---\nname: C\n---\n\nBody\n"
        );
        assert_eq!(
            rewrite_document_name("---\nname: A\nlicense: MIT\nname: B\n---\n\nBody\n", "C"),
            "---\nname: C\nlicense: MIT\n---\n\nBody\n"
        );
        // A first line that only trims to `---` still opens frontmatter. Not
        // recognizing it would copy the old block into the new body, leaving
        // two frontmatter blocks in the document.
        assert_eq!(
            rewrite_document_name("--- \nname: A\n---\n\nBody\n", "C"),
            "---\nname: C\n---\n\nBody\n"
        );
        assert_eq!(
            rewrite_document_name("--- \r\nname: A\r\n---\r\n\r\nBody\r\n", "C"),
            "---\nname: C\n---\r\n\r\nBody\r\n"
        );
        // An indented `name:` is a nested map value, not the document's name.
        assert_eq!(
            rewrite_document_name("---\nmeta:\n  name: A\nname: B\n---\n\nBody\n", "C"),
            "---\nmeta:\n  name: A\nname: C\n---\n\nBody\n"
        );
    }
}

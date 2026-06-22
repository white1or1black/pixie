use anyhow::{Context, Result};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tokio::sync::Mutex;

use crate::search::index::SearchIndex;

// ---------------------------------------------------------------------------
// Concurrency & dedup guards
// ---------------------------------------------------------------------------

/// Per-conversation in-flight dedupe: skip if a write for the same conv_id
/// is already running.
static INFLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummarizeInput {
    pub conversation_id: String,
    pub vault_path: Option<String>,
    pub workspace_path: Option<String>,
    pub title_hint: String,
    /// Full conversation transcript in markdown format.
    pub transcript: String,
    pub engine: Option<String>,
    /// If true, overwrite an existing note (used by backfill to replace old
    /// summary-style notes with full conversations).
    pub force_overwrite: bool,
}

// ---------------------------------------------------------------------------
// Entry point (called from tokio::spawn — failures are logged, never surfaced)
// ---------------------------------------------------------------------------

pub async fn summarize_with_guard(input: SummarizeInput) -> Result<()> {
    let conv_id = input.conversation_id.clone();

    // Use configured vault path, or fall back to ~/Documents/Pixie/.
    let vault_path = match input.vault_path.as_deref() {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => crate::default_vault_dir(),
    };

    // Ensure the vault directory has Obsidian metadata (.obsidian/) so the
    // folder is a recognizable vault even if the user has never clicked
    // "Open in Obsidian".  Failures are logged but never block note writes.
    if let Some(p) = vault_path.to_str() {
        if let Err(e) = crate::ensure_obsidian_vault(p) {
            log::warn!("[kb] ensure_obsidian_vault failed: {e}");
        }
    }

    // Dedup check: skip if already writing this conv.
    {
        let mut set = INFLIGHT.lock().await;
        if set.contains(&conv_id) {
            log::info!("[kb] {conv_id}: already in-flight, skipping");
            return Ok(());
        }
        set.insert(conv_id.clone());
    }

    // Ensure we clean up the in-flight set on exit.
    struct InflightGuard(String);
    impl Drop for InflightGuard {
        fn drop(&mut self) {
            if let Ok(mut set) = INFLIGHT.try_lock() {
                set.remove(&self.0);
            }
        }
    }
    let _guard = InflightGuard(conv_id.clone());

    let title = if input.title_hint.trim().is_empty() {
        "Untitled Conversation".to_string()
    } else {
        input.title_hint.trim().to_string()
    };
    let slug = slugify(&title);
    let vault_dir = vault_path.join("Pixie");

    // Ensure the Pixie/ subdirectory exists.
    std::fs::create_dir_all(&vault_dir)
        .with_context(|| format!("create vault dir {}", vault_dir.display()))?;

    let note_path = resolve_note_path(&vault_dir, &slug, &conv_id);

    // First-write-only: if a note for this conversation already exists, skip
    // (unless force_overwrite is set, e.g. during backfill).
    if !input.force_overwrite && note_path.exists() {
        log::info!(
            "[kb] {conv_id}: note already exists at {}, skipping",
            note_path.display()
        );
        return Ok(());
    }

    // Search existing notes for related content using BM25 + inverted index.
    let related = find_related(&vault_dir, &title, &input.transcript, &conv_id).unwrap_or_default();

    let content = render_note(
        &title,
        &conv_id,
        input.workspace_path.as_deref(),
        input.engine.as_deref(),
        &input.transcript,
        &related,
    );
    crate::atomic_write(&note_path, &content)
        .map_err(|e| anyhow::anyhow!("write note {}: {e}", note_path.display()))?;

    log::info!("[kb] {conv_id}: wrote {}", note_path.display());

    // Rebuild the search index in the background so new notes are searchable.
    let vault_for_reindex = vault_path.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::search::rebuild_index(&vault_for_reindex).await {
            log::warn!("[kb] index rebuild failed: {e:#}");
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Find up to 3 existing notes related to this conversation using BM25 search.
/// Returns (title, path) pairs. Excludes the current conversation_id.
fn find_related(
    vault_dir: &Path,
    title: &str,
    transcript: &str,
    current_conv_id: &str,
) -> Result<Vec<(String, String)>> {
    // Build a fresh index from the existing notes (before this one is written).
    let index = SearchIndex::build_from_dir(vault_dir)?;
    if index.doc_count() == 0 {
        return Ok(vec![]);
    }

    // Use title + first 300 chars of body as the search query.
    let query = format!(
        "{} {}",
        title,
        transcript.chars().take(300).collect::<String>()
    );

    let results = index.search(&query, 5);
    let related: Vec<_> = results
        .into_iter()
        .filter(|r| r.conversation_id != current_conv_id)
        .take(3)
        .map(|r| (r.title, r.path))
        .collect();

    Ok(related)
}
fn slugify(title: &str) -> String {
    let mut slug: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else if c.is_whitespace() {
                '-'
            } else {
                // CJK and other Unicode chars are kept as-is (Obsidian handles them).
                c
            }
        })
        .collect();
    // Collapse consecutive dashes.
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    // Trim leading/trailing dashes.
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Find the note path for a conversation. Pattern: `<slug>-<convId>.md`.
/// Glob the vault dir for an existing `*<convId>.md`; if found, return that
/// exact path (preserving whatever slug/human-rename it has).
fn resolve_note_path(vault_dir: &Path, slug: &str, conv_id: &str) -> PathBuf {
    if let Ok(entries) = std::fs::read_dir(vault_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(&format!("{conv_id}.md")) {
                return entry.path();
            }
        }
    }
    // No existing note — create a new one.
    vault_dir.join(format!("{slug}-{conv_id}.md"))
}

/// Render the full conversation as an Obsidian-flavored markdown note.
fn render_note(
    title: &str,
    conv_id: &str,
    workspace_path: Option<&str>,
    engine: Option<&str>,
    body: &str,
    related: &[(String, String)],
) -> String {
    let created = Local::now().to_rfc3339();
    let ws = workspace_path.unwrap_or("");
    let eng = engine.unwrap_or("claude");

    let mut note = format!(
        "---\n\
         title: \"{title}\"\n\
         conversation_id: \"{conv_id}\"\n\
         workspace: \"{ws}\"\n\
         engine: {eng}\n\
         source: pixie\n\
         tags: [pixie, ai-conversation]\n\
         aliases: []\n\
         created: {created}\n\
         ---\n\n\
         {body}\n"
    );

    if !related.is_empty() {
        note.push_str("\n---\n\n## Related Knowledge\n\n");
        for (rel_title, rel_path) in related {
            // Obsidian wiki-link: use the note filename without extension.
            let link_name = Path::new(rel_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(rel_title);
            note.push_str(&format!("- [[{link_name}|{rel_title}]]\n"));
        }
    }

    note
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("Hello World"), "Hello-World");
        assert_eq!(slugify("foo--bar  baz"), "foo-bar-baz");
        assert_eq!(slugify("--leading-trailing--"), "leading-trailing");
        assert_eq!(slugify("中文测试"), "中文测试");
    }

    #[test]
    fn test_render_note() {
        let content = render_note(
            "Test Title",
            "abc-123",
            Some("/tmp/project"),
            Some("claude"),
            "## User\nHello\n\n## Assistant\nHi there",
            &[],
        );
        assert!(content.starts_with("---\n"));
        assert!(content.contains("title: \"Test Title\""));
        assert!(content.contains("conversation_id: \"abc-123\""));
        assert!(content.contains("workspace: \"/tmp/project\""));
        assert!(content.contains("tags: [pixie, ai-conversation]"));
        assert!(content.contains("## User"));
        assert!(content.contains("Hi there"));
    }
}

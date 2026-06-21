pub mod bm25;
pub mod index;
pub mod parser;

use anyhow::Result;
use index::{SearchIndex, SearchIndexStats, SearchResult};
use std::path::Path;
use std::sync::LazyLock;
use tokio::sync::Mutex;

/// Module-level singleton: lazily-built search index.
/// `bool` flag tracks whether the index has been built at least once
/// (even if it's empty — avoids rebuilding on every search).
static INDEX: LazyLock<Mutex<(Option<SearchIndex>, bool)>> =
    LazyLock::new(|| Mutex::new((None, false)));

/// Ensure the index is built for the given vault directory.
/// Only builds once per session; subsequent calls skip.
pub async fn ensure_index(vault_dir: &Path) -> Result<()> {
    // 1. Check under lock — fast path.
    {
        let guard = INDEX.lock().await;
        if guard.1 {
            return Ok(()); // Already built, skip.
        }
    }

    // 2. Build outside the lock — no I/O while holding the mutex.
    let pixie_dir = vault_dir.join("Pixie");
    let new_index = SearchIndex::build_from_dir(&pixie_dir)?;
    log::info!(
        "[search] index built: {} docs, {} terms",
        new_index.doc_count(),
        new_index.term_count()
    );

    // 3. Write under lock.
    let mut guard = INDEX.lock().await;
    guard.0 = Some(new_index);
    guard.1 = true;
    Ok(())
}

/// Force-rebuild the index (e.g. after a new note is written).
pub async fn rebuild_index(vault_dir: &Path) -> Result<SearchIndexStats> {
    // Build outside the lock.
    let pixie_dir = vault_dir.join("Pixie");
    let new_index = SearchIndex::build_from_dir(&pixie_dir)?;
    let stats = SearchIndexStats {
        doc_count: new_index.doc_count(),
        term_count: new_index.term_count(),
    };
    log::info!(
        "[search] index rebuilt: {} docs, {} terms",
        stats.doc_count, stats.term_count
    );

    // Write under lock.
    let mut guard = INDEX.lock().await;
    guard.0 = Some(new_index);
    guard.1 = true;
    Ok(stats)
}

/// Search the index. Builds it first if needed.
pub async fn search(query: &str, vault_dir: &Path, limit: usize) -> Result<Vec<SearchResult>> {
    ensure_index(vault_dir).await?;
    let guard = INDEX.lock().await;
    match &guard.0 {
        Some(idx) => Ok(idx.search(query, limit)),
        None => Ok(vec![]),
    }
}

/// Get index stats (builds if needed).
#[allow(dead_code)]
pub async fn stats(vault_dir: &Path) -> Result<SearchIndexStats> {
    ensure_index(vault_dir).await?;
    let guard = INDEX.lock().await;
    match &guard.0 {
        Some(idx) => Ok(SearchIndexStats {
            doc_count: idx.doc_count(),
            term_count: idx.term_count(),
        }),
        None => Ok(SearchIndexStats {
            doc_count: 0,
            term_count: 0,
        }),
    }
}

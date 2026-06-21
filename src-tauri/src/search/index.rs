use super::bm25::{bm25_score, term_freqs, tokenize};
use super::parser::parse_note;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// A single indexed document.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Document {
    title: String,
    conversation_id: String,
    path: String,
    tags: Vec<String>,
    created: String,
    raw_body: String,
    body_tokens: Vec<String>,
    body_tf: HashMap<String, usize>,
    meta_tokens: Vec<String>,
    meta_tf: HashMap<String, usize>,
}

/// In-memory search index with inverted posting lists for O(k) search
/// (k = number of docs containing at least one query term).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchIndex {
    docs: Vec<Document>,
    avg_dl: f64,
    df: HashMap<String, usize>,
    postings: HashMap<String, Vec<usize>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub conversation_id: String,
    pub path: String,
    pub snippet: String,
    pub tags: Vec<String>,
    pub created: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchIndexStats {
    pub doc_count: usize,
    pub term_count: usize,
}

impl SearchIndex {
    /// Build an index from all `*.md` files in the given directory.
    pub fn build_from_dir(vault_dir: &Path) -> Result<Self> {
        let mut docs = Vec::new();

        if !vault_dir.exists() {
            return Ok(Self::default());
        }

        let entries = std::fs::read_dir(vault_dir)?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }

            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let (fm, body) = parse_note(&content);

            // Tokenize body.
            let body_tokens = tokenize(&body);
            let body_tf = term_freqs(&body_tokens);

            // Tokenize meta fields (title + tags + workspace) for search.
            let meta_text = format!(
                "{} {} {} {}",
                fm.title,
                fm.tags.join(" "),
                fm.workspace,
                fm.aliases.join(" ")
            );
            let meta_tokens = tokenize(&meta_text);
            let meta_tf = term_freqs(&meta_tokens);

            docs.push(Document {
                title: if fm.title.is_empty() {
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Untitled")
                        .to_string()
                } else {
                    fm.title
                },
                conversation_id: fm.conversation_id,
                path: path.to_string_lossy().into_owned(),
                tags: fm.tags,
                created: fm.created,
                raw_body: body,
                body_tokens,
                body_tf,
                meta_tokens,
                meta_tf,
            });
        }

        // Compute avg_dl.
        let total_tokens: usize = docs.iter().map(|d| d.body_tokens.len()).sum();
        let avg_dl = if docs.is_empty() {
            1.0
        } else {
            total_tokens as f64 / docs.len() as f64
        };

        // Compute document frequency + posting lists (combined body + meta).
        let mut df: HashMap<String, usize> = HashMap::new();
        let mut postings: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, doc) in docs.iter().enumerate() {
            let mut seen = std::collections::HashSet::new();
            for token in doc.body_tokens.iter().chain(doc.meta_tokens.iter()) {
                if seen.insert(token.clone()) {
                    *df.entry(token.clone()).or_insert(0) += 1;
                    postings.entry(token.clone()).or_default().push(i);
                }
            }
        }

        Ok(Self { docs, avg_dl, df, postings })
    }

    /// Search the index with a query string, returning top `limit` results.
    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchResult> {
        let query_terms = tokenize(query);
        if query_terms.is_empty() || self.docs.is_empty() {
            return vec![];
        }

        // Use posting lists to find candidate docs — only score docs that
        // contain at least one query term (O(k) instead of O(n)).
        let mut candidates: HashMap<usize, f64> = HashMap::new();
        for qt in &query_terms {
            if let Some(hits) = self.postings.get(qt) {
                for &doc_idx in hits {
                    // Accumulate per-term contribution to avoid double-counting
                    // when the same doc matches multiple query terms.
                    *candidates.entry(doc_idx).or_insert(0.0) += 1.0;
                }
            }
        }

        let doc_count = self.docs.len();
        let mut scored: Vec<(usize, f64)> = Vec::with_capacity(candidates.len());

        for (&doc_idx, _) in &candidates {
            let doc = &self.docs[doc_idx];
            let doc_len = doc.body_tokens.len();

            let body_score = bm25_score(
                &doc.body_tf,
                doc_len,
                self.avg_dl,
                doc_count,
                &self.df,
                &query_terms,
            );

            let meta_len = doc.meta_tokens.len();
            let meta_avg_dl = if doc_count > 0 {
                self.docs.iter().map(|d| d.meta_tokens.len()).sum::<usize>() as f64
                    / doc_count as f64
            } else {
                1.0
            };
            let meta_score = bm25_score(
                &doc.meta_tf,
                meta_len,
                meta_avg_dl,
                doc_count,
                &self.df,
                &query_terms,
            );

            let combined = body_score + meta_score * 2.0;
            if combined > 0.0 {
                scored.push((doc_idx, combined));
            }
        }

        // Sort by score descending.
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);

        scored
            .into_iter()
            .map(|(i, score)| {
                let doc = &self.docs[i];
                SearchResult {
                    title: doc.title.clone(),
                    conversation_id: doc.conversation_id.clone(),
                    path: doc.path.clone(),
                    snippet: extract_snippet(&doc.raw_body, &query_terms, 200),
                    tags: doc.tags.clone(),
                    created: doc.created.clone(),
                    score,
                }
            })
            .collect()
    }

    pub fn doc_count(&self) -> usize {
        self.docs.len()
    }

    pub fn term_count(&self) -> usize {
        self.df.len()
    }

    /// Serialize the index to a JSON file for cold-start fast loading.
    pub fn save_to_disk(&self, path: &Path) -> Result<()> {
        let json = serde_json::to_string(self)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Atomic write: temp file + rename.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Load a previously saved index from disk.
    pub fn load_from_disk(path: &Path) -> Result<Self> {
        let json = std::fs::read_to_string(path)?;
        let index: Self = serde_json::from_str(&json)?;
        Ok(index)
    }
}

/// Extract a snippet from the body around the first matching query term.
fn extract_snippet(body: &str, query_terms: &[String], max_len: usize) -> String {
    let lower_body = body.to_ascii_lowercase();
    let query_lower: Vec<String> = query_terms.iter().map(|t| t.to_ascii_lowercase()).collect();

    // Find the position of the first query term in the body.
    let mut match_pos = None;
    let mut match_len = 0;
    for qt in &query_lower {
        if let Some(pos) = lower_body.find(qt.as_str()) {
            match_pos = Some(pos);
            match_len = qt.len();
            break;
        }
    }

    // Convert byte offsets to char indices.
    let chars: Vec<char> = body.chars().collect();
    let char_count = chars.len();

    let (start, end) = match match_pos {
        Some(bp) => {
            // byte offset → char index
            let ci = body[..bp].chars().count();
            let ci_end = (ci + match_len).min(char_count);
            // Center the window around the match.
            let half = max_len / 2;
            let s = if ci > half { ci - half } else { 0 };
            let e = (s + max_len).min(char_count);
            // Ensure the match itself is included.
            let s = s.min(ci);
            (s, e.max(ci_end))
        }
        None => (0, max_len.min(char_count)),
    };

    let mut snippet: String = chars[start..end].iter().collect();
    if end < char_count {
        snippet.push('…');
    }
    if start > 0 {
        snippet = format!("…{snippet}");
    }

    snippet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_snippet_match() {
        let body = "This is a long body of text that contains the keyword somewhere in the middle of the document.";
        let snippet = extract_snippet(body, &["keyword".to_string()], 40);
        assert!(snippet.contains("keyword"));
    }

    #[test]
    fn test_extract_snippet_no_match() {
        let body = "Short text.";
        let snippet = extract_snippet(body, &["missing".to_string()], 40);
        assert_eq!(snippet, "Short text.");
    }
}

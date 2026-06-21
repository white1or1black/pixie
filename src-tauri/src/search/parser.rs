use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Parsed YAML frontmatter from an Obsidian note.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Frontmatter {
    pub title: String,
    pub conversation_id: String,
    pub workspace: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub created: String,
}

/// Parse an Obsidian markdown note into (frontmatter, body).
/// If no valid frontmatter is found, returns default frontmatter + the whole content as body.
pub fn parse_note(content: &str) -> (Frontmatter, String) {
    let trimmed = content.trim_start();

    // Frontmatter is delimited by `---` at the start.
    if !trimmed.starts_with("---") {
        return (Frontmatter::default(), content.to_string());
    }

    // Find the closing `---`.
    let rest = &trimmed[3..]; // skip opening ---
    if let Some(end) = rest.find("\n---") {
        let yaml_str = &rest[..end];
        let body = rest[end + 4..].trim_start().to_string();
        let fm = parse_yaml_frontmatter(yaml_str);
        return (fm, body);
    }

    // No closing --- found; treat entire content as body.
    (Frontmatter::default(), content.to_string())
}

/// Minimal YAML parser for our flat key-value frontmatter.
/// Handles: `key: value`, `key: "quoted"`, `key: [a, b, c]`.
fn parse_yaml_frontmatter(yaml: &str) -> Frontmatter {
    let mut map: HashMap<String, String> = HashMap::new();

    for line in yaml.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_string();
            let value = value.trim().to_string();
            map.insert(key, value);
        }
    }

    Frontmatter {
        title: extract_string(&map, "title"),
        conversation_id: extract_string(&map, "conversation_id"),
        workspace: extract_string(&map, "workspace"),
        tags: extract_list(&map, "tags"),
        aliases: extract_list(&map, "aliases"),
        created: extract_string(&map, "created"),
    }
}

/// Extract a string value, stripping quotes.
fn extract_string(map: &HashMap<String, String>, key: &str) -> String {
    map.get(key)
        .map(|v| v.trim_matches('"').trim_matches('\'').to_string())
        .unwrap_or_default()
}

/// Extract a YAML list like `[pixie, ai-conversation]` or `pixie` (single).
fn extract_list(map: &HashMap<String, String>, key: &str) -> Vec<String> {
    let raw = match map.get(key) {
        Some(v) => v,
        None => return vec![],
    };

    let trimmed = raw.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        // Parse [a, b, c]
        let inner = &trimmed[1..trimmed.len() - 1];
        inner
            .split(',')
            .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else if !trimmed.is_empty() {
        vec![trimmed.to_string()]
    } else {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_note_with_frontmatter() {
        let content = "---\ntitle: \"My Title\"\nconversation_id: \"abc-123\"\ntags: [pixie, test]\ncreated: 2026-01-01\n---\n\n## Decisions\n- Did thing A";
        let (fm, body) = parse_note(content);
        assert_eq!(fm.title, "My Title");
        assert_eq!(fm.conversation_id, "abc-123");
        assert_eq!(fm.tags, vec!["pixie", "test"]);
        assert!(body.contains("## Decisions"));
    }

    #[test]
    fn test_parse_note_no_frontmatter() {
        let content = "Just some text\nNo frontmatter here";
        let (fm, body) = parse_note(content);
        assert!(fm.title.is_empty());
        assert_eq!(body, content);
    }

    #[test]
    fn test_extract_list_single() {
        let mut map = HashMap::new();
        map.insert("tags".to_string(), "solo".to_string());
        assert_eq!(extract_list(&map, "tags"), vec!["solo"]);
    }
}

use std::collections::HashMap;
use std::sync::LazyLock;

use jieba_rs::Jieba;

const K1: f64 = 1.2;
const B: f64 = 0.75;

/// Global Jieba instance — loads the default dictionary once (~5 MB).
static JIEBA: LazyLock<Jieba> = LazyLock::new(Jieba::new);

/// Tokenize text for BM25 indexing / querying.
///
/// Strategy by script:
/// - **Latin / Cyrillic etc.**: lowercase, split on whitespace/punctuation.
/// - **CJK (Chinese, Japanese, Korean)**: jieba dictionary segmentation.
///   "知识管理系统" → ["知识", "管理", "系统"] — proper word boundaries.
/// - **Mixed**: CJK runs and Latin words are tokenized independently.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut cjk_run = String::new();

    let flush_current = |current: &mut String, tokens: &mut Vec<String>| {
        if !current.is_empty() {
            tokens.push(std::mem::take(current));
        }
    };

    // Segment accumulated CJK text with jieba.
    let flush_cjk = |cjk_run: &mut String, tokens: &mut Vec<String>| {
        if cjk_run.is_empty() {
            return;
        }
        let words = JIEBA.cut(cjk_run, false);
        for token in words {
            let w = token.word.trim();
            if !w.is_empty() {
                tokens.push(w.to_string());
            }
        }
        cjk_run.clear();
    };

    for ch in text.chars() {
        if is_cjk(ch) {
            flush_current(&mut current, &mut tokens);
            cjk_run.push(ch);
        } else if ch.is_alphanumeric() || ch == '_' || ch == '-' {
            flush_cjk(&mut cjk_run, &mut tokens);
            current.push(ch.to_ascii_lowercase());
        } else {
            flush_current(&mut current, &mut tokens);
            flush_cjk(&mut cjk_run, &mut tokens);
        }
    }
    flush_current(&mut current, &mut tokens);
    flush_cjk(&mut cjk_run, &mut tokens);

    tokens
}

/// Compute term frequencies for a list of tokens.
pub fn term_freqs(tokens: &[String]) -> HashMap<String, usize> {
    let mut freqs = HashMap::new();
    for token in tokens {
        *freqs.entry(token.clone()).or_insert(0) += 1;
    }
    freqs
}

/// Compute BM25 score for a single document given a query.
///
/// - `doc_tf`: term frequencies in the document
/// - `doc_len`: number of tokens in the document
/// - `avg_dl`: average document length across the corpus
/// - `doc_count`: total number of documents
/// - `df`: document frequency for each term (how many docs contain it)
/// - `query_terms`: pre-tokenized query terms
pub fn bm25_score(
    doc_tf: &HashMap<String, usize>,
    doc_len: usize,
    avg_dl: f64,
    doc_count: usize,
    df: &HashMap<String, usize>,
    query_terms: &[String],
) -> f64 {
    let dl = doc_len as f64;
    let n = doc_count as f64;
    let mut score = 0.0;

    for term in query_terms {
        let tf = match doc_tf.get(term) {
            Some(&f) => f as f64,
            None => continue,
        };

        let df_val = df.get(term).copied().unwrap_or(0) as f64;
        // IDF = ln((N - df + 0.5) / (df + 0.5) + 1)
        let idf = ((n - df_val + 0.5) / (df_val + 0.5) + 1.0).ln();

        // TF component: (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl/avgdl))
        let denominator = tf + K1 * (1.0 - B + B * (dl / avg_dl));
        let tf_component = (tf * (K1 + 1.0)) / denominator;

        score += idf * tf_component;
    }

    score
}

/// Check if a character is CJK (Chinese, Japanese, Korean).
fn is_cjk(ch: char) -> bool {
    let cp = ch as u32;
    // CJK Unified Ideographs: 4E00-9FFF
    // CJK Compatibility Ideographs: F900-FAFF
    // CJK Extension A: 3400-4DBF
    // CJK Extension B-I: 20000-2EBEF
    // CJK Radicals Supplement: 2E80-2EFF
    // Kangxi Radicals: 2F00-2FDF
    // Hiragana: 3040-309F, Katakana: 30A0-30FF
    // Hangul Syllables: AC00-D7AF
    (0x4E00..=0x9FFF).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0x3400..=0x4DBF).contains(&cp)
        || (0x20000..=0x2EBEF).contains(&cp)
        || (0x2E80..=0x2EFF).contains(&cp)
        || (0x2F00..=0x2FDF).contains(&cp)
        || (0x3040..=0x309F).contains(&cp)
        || (0x30A0..=0x30FF).contains(&cp)
        || (0xAC00..=0xD7AF).contains(&cp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_english() {
        let tokens = tokenize("Hello, World! This is a test.");
        assert_eq!(tokens, vec!["hello", "world", "this", "is", "a", "test"]);
    }

    #[test]
    fn test_tokenize_chinese_jieba() {
        let tokens = tokenize("知识管理");
        // jieba segments "知识管理" into ["知识", "管理"]
        assert!(tokens.contains(&"知识".to_string()));
        assert!(tokens.contains(&"管理".to_string()));
        // No bigram noise like "识管"
        assert!(!tokens.contains(&"识管".to_string()));
    }

    #[test]
    fn test_tokenize_chinese_sentence() {
        let tokens = tokenize("我们中出了一个叛徒");
        // Classic jieba test: "我们", "中", "出", "了", "一个", "叛徒"
        assert!(tokens.contains(&"我们".to_string()));
        assert!(tokens.contains(&"一个".to_string()));
        assert!(tokens.contains(&"叛徒".to_string()));
    }

    #[test]
    fn test_tokenize_cjk_single_char() {
        let tokens = tokenize("中");
        assert!(tokens.contains(&"中".to_string()));
    }

    #[test]
    fn test_tokenize_mixed() {
        let tokens = tokenize("API key: sk-abc123");
        assert!(tokens.contains(&"api".to_string()));
        assert!(tokens.contains(&"sk-abc123".to_string()));
    }

    #[test]
    fn test_tokenize_cjk_english_mix() {
        let tokens = tokenize("使用React开发前端");
        // jieba segments CJK, English kept as words
        assert!(tokens.contains(&"使用".to_string()));
        assert!(tokens.contains(&"react".to_string()));
        assert!(tokens.contains(&"开发".to_string()));
        assert!(tokens.contains(&"前端".to_string()));
    }

    #[test]
    fn test_bm25_basic() {
        let doc_tf: HashMap<String, usize> =
            vec![("hello".to_string(), 2), ("world".to_string(), 1)]
                .into_iter()
                .collect();
        let df: HashMap<String, usize> =
            vec![("hello".to_string(), 3), ("world".to_string(), 10)]
                .into_iter()
                .collect();
        let query = vec!["hello".to_string()];
        let score = bm25_score(&doc_tf, 5, 10.0, 100, &df, &query);
        assert!(score > 0.0, "BM25 score should be positive for matching term");
    }

    #[test]
    fn test_bm25_no_match() {
        let doc_tf: HashMap<String, usize> = vec![("hello".to_string(), 1)].into_iter().collect();
        let df: HashMap<String, usize> = vec![("hello".to_string(), 5)].into_iter().collect();
        let query = vec!["missing".to_string()];
        let score = bm25_score(&doc_tf, 5, 10.0, 100, &df, &query);
        assert_eq!(score, 0.0, "BM25 score should be 0 for no matching terms");
    }

    #[test]
    fn test_chinese_search_end_to_end() {
        // Doc contains "知识管理系统", query is "知识"
        let doc_tokens = tokenize("知识管理系统");
        let doc_tf = term_freqs(&doc_tokens);
        let query_tokens = tokenize("知识");
        assert!(doc_tf.contains_key("知识"), "'知识' should be in doc tokens");
        assert!(query_tokens.contains(&"知识".to_string()), "query should contain '知识'");
    }
}

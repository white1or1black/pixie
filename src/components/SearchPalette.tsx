import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KbSearchResult } from "../types";
import { getConfig } from "../lib/storage";

const DEBOUNCE_MS = 350;

interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Open a file in the right-side preview panel. */
  onOpenPreview: (path: string) => void;
}

export default function SearchPalette(props: SearchPaletteProps) {
  if (!props.open) return null;
  return <SearchPaletteInner onClose={props.onClose} onOpenPreview={props.onOpenPreview} />;
}

function SearchPaletteInner({ onClose, onOpenPreview }: Omit<SearchPaletteProps, "open">) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KbSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Request serial number to discard stale responses.
  const seqRef = useRef(0);

  // Focus the input on mount.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  // Debounced search — fires 350 ms after the user stops typing.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (query.trim().length < 2) {
      return;
    }

    const seq = ++seqRef.current;

    timerRef.current = setTimeout(async () => {
      try {
        const vaultPath = getConfig().vaultPath ?? null;
        const hits = await invoke<KbSearchResult[]>("search_kb", {
          query: query.trim(),
          vaultPath,
        });
        // Only update if this is still the latest request.
        if (seqRef.current === seq) {
          setResults(hits);
          setSelected(0);
        }
      } catch (e) {
        console.error("[search] failed:", e);
        if (seqRef.current === seq) setResults([]);
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  // Keyboard navigation.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, results.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Enter" && results.length > 0) {
        e.preventDefault();
        onOpenPreview(results[selected].path);
        return;
      }
    },
    [results, selected, onClose, onOpenPreview],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      {/* Backdrop — subtle dim, click to close */}
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
      />

      {/* Popup panel */}
      <div className="relative w-full max-w-xl bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border-color)] shadow-2xl overflow-hidden search-palette-enter max-h-[55vh] flex flex-col">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-color)]">
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            className="shrink-0 text-[var(--text-secondary)]"
          >
            <circle cx="7.5" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11.5 11.5L16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              const next = e.target.value;
              setQuery(next);
              setSelected(0);

              if (timerRef.current) clearTimeout(timerRef.current);

              if (next.trim().length < 2) {
                // Cancel any in-flight requests and clear the list immediately.
                seqRef.current++;
                setResults([]);
                setLoading(false);
              } else {
                setLoading(true);
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search knowledge base…"
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none"
            autoFocus
          />
          {loading && (
            <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin shrink-0" />
          )}
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
            title="Close (Esc)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

{/* Results */}
      {results.length > 0 && (
        <div className="flex-1 overflow-y-auto border-b border-[var(--border-color)]">
          {results.map((result, i) => (
            <div
              key={result.conversation_id || result.path}
              onClick={() => {
                setSelected(i);
                onOpenPreview(result.path);
              }}
              className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${
                i === selected
                  ? "bg-[var(--accent)]/10"
                  : "hover:bg-[var(--bg-tertiary)]/40"
              }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                      {result.title}
                    </span>
                    {result.tags.length > 0 && (
                      <div className="flex gap-1 shrink-0">
                        {result.tags.slice(0, 2).map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0 rounded-full bg-[var(--accent)]/10 text-[10px] text-[var(--accent)]"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] line-clamp-3">
                    {result.snippet}
                  </p>
                  {result.created && (
                    <p className="text-[10px] text-[var(--text-secondary)] mt-1 opacity-60">
                      {result.created.split("T")[0]}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {query.trim().length >= 2 && !loading && results.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-[var(--text-secondary)]">No results found</p>
            <p className="text-xs text-[var(--text-secondary)] mt-1 opacity-60">
              Try different keywords or check your vault settings
            </p>
          </div>
        )}

        {/* Hint */}
        {query.trim().length < 2 && (
          <div className="px-4 py-4 text-center">
            <p className="text-xs text-[var(--text-secondary)]">
              Type at least 2 characters to search your knowledge base
            </p>
          </div>
        )}

{/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 text-[10px] text-[var(--text-secondary)]">
          <span>
            <kbd className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)]">↑↓</kbd> select
          </span>
          <span>
            <kbd className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)]">Enter</kbd> preview
          </span>
          <span>
            <kbd className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)]">Esc</kbd> close
          </span>
        </div>
    </div>
    </div>
  );
}

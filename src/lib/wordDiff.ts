import { diffWords } from "diff";

/**
 * Word-level diff for a paired old/new line (split view). Delegates to jsdiff's
 * `diffWords`; unchanged parts render on both sides, removed parts highlight on
 * the old side, added parts on the new side. Returns [] on failure so the
 * caller falls back to per-token syntax coloring instead.
 */
export interface WordPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export function wordDiffParts(oldText: string, newText: string): WordPart[] {
  if (!oldText && !newText) return [];
  try {
    return diffWords(oldText, newText).map((p) => ({
      value: p.value,
      added: p.added,
      removed: p.removed,
    }));
  } catch {
    return [];
  }
}

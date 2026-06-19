import { refractor } from "refractor";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

/**
 * Per-line syntax highlighting for the diff viewer.
 *
 * We tokenize each file's full source ONCE with refractor (the same engine the
 * Prism CodeBlock elsewhere uses), flatten the resulting hast tree into leaf
 * segments carrying their Prism token type, then re-split by newline so every
 * source line maps to its own colored segments. Tokenizing the whole file
 * (rather than line-by-line) keeps multi-line constructs — block comments,
 * template strings, heredocs — correctly colored across lines.
 *
 * Colors are read from the existing `oneDark` style object so the diff matches
 * the rest of the app exactly; no second theme to maintain.
 */

export interface TokenSegment {
  text: string;
  /** Prism token type (e.g. "keyword", "string") used to look up its color. */
  cls?: string;
}

type StyleMap = Record<string, { color?: string }>;
const STYLE: StyleMap = oneDark as unknown as StyleMap;

// Base text color from oneDark's `code` rule — the default for untyped text.
const BASE_COLOR = STYLE['code[class*="language-"]']?.color;

function tokenColor(cls?: string): string | undefined {
  return cls ? STYLE[cls]?.color : undefined;
}

/** Resolve a segment's color, falling back to the oneDark base text color. */
export function segmentColor(seg: TokenSegment): string | undefined {
  return tokenColor(seg.cls) ?? BASE_COLOR;
}

// Flatten a hast node tree into leaf segments, each tagged with the nearest
// Prism token type so colors survive across nested tokens.
function collect(node: HastNode, inherited: string | undefined, out: TokenSegment[]): void {
  if (node.type === "text") {
    if (node.value) out.push({ text: node.value, cls: inherited });
    return;
  }
  if (node.type === "element") {
    const className: string[] = node.properties?.className ?? [];
    // refractor elements use className ['token', '<type>', ...aliases].
    const type = className.length > 1 && className[0] === "token" ? className[1] : undefined;
    const next = type ?? inherited;
    for (const child of node.children ?? []) collect(child, next, out);
  }
}

// Re-segment a flat token list by newline → per-line segment arrays.
function segmentToLines(segs: TokenSegment[]): TokenSegment[][] {
  const lines: TokenSegment[][] = [[]];
  for (const seg of segs) {
    const parts = seg.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i].length) lines[lines.length - 1].push({ text: parts[i], cls: seg.cls });
    }
  }
  return lines;
}

/**
 * Tokenize a whole-file source string into per-line segments.
 * Returns null when the language isn't registered, so the caller can render
 * plain uncolored text instead.
 */
export function tokenizeSource(source: string, language: string): TokenSegment[][] | null {
  if (!source) return null;
  const lang = language.toLowerCase();
  if (!lang || !refractor.registered(lang)) return null;
  try {
    const root = refractor.highlight(source, lang) as unknown as HastNode;
    const segs: TokenSegment[] = [];
    collect(root, undefined, segs);
    return segmentToLines(segs);
  } catch {
    return null;
  }
}

// Minimal hast subset refractor returns.
interface HastProperties {
  className?: string[];
}
interface HastNode {
  type: "element" | "text" | "root";
  value?: string;
  properties?: HastProperties;
  children?: HastNode[];
}

import { memo, useMemo, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import type {
  DiffFile,
  DiffFileStatus,
  DiffLine,
  DiffLineType,
  DiffViewMode,
} from "../types";
import { parseGitDiff } from "../lib/diffParser";
import { tokenizeSource, segmentColor, type TokenSegment } from "../lib/highlight";
import { languageOfPath } from "../lib/languages";
import { wordDiffParts, type WordPart } from "../lib/wordDiff";

interface DiffViewerProps {
  /** Raw `git diff` unified output. */
  diff: string;
  viewMode: DiffViewMode;
  /** Called when user wants to reveal a diff file in the OS file manager. */
  onRevealPath?: (relativePath: string) => void;
}

const MAX_LINES_PER_FILE = 2000;

// Status badge → {label, color}.
const STATUS_META: Record<DiffFileStatus, { label: string; color: string }> = {
  added: { label: "A", color: "#3fb950" },
  modified: { label: "M", color: "#d29922" },
  deleted: { label: "D", color: "#f85149" },
  renamed: { label: "R", color: "#58a6ff" },
};

const SIGN: Record<DiffLineType, string> = { add: "+", delete: "-", context: " " };
const ROW_BG: Record<DiffLineType, string> = {
  add: "rgba(46, 160, 67, 0.12)",
  delete: "rgba(248, 81, 73, 0.12)",
  context: "transparent",
};
const SIGN_COLOR: Record<DiffLineType, string> = {
  add: "#3fb950",
  delete: "#f85149",
  context: "var(--text-secondary)",
};
const ADD_WORD_BG = "rgba(46, 160, 67, 0.28)";
const DEL_WORD_BG = "rgba(248, 81, 73, 0.28)";

const GUTTER_TD: CSSProperties = {
  width: "3.5ch",
  paddingRight: "0.5rem",
  textAlign: "right",
  userSelect: "none",
  color: "var(--text-secondary)",
  opacity: 0.6,
};
const CODE_TD: CSSProperties = {
  whiteSpace: "pre",
  paddingLeft: "0.5rem",
  paddingRight: "1rem",
};

/** Render either colored token spans (known language) or plain text. */
function CodeCell({
  text,
  segments,
}: {
  text: string;
  segments: TokenSegment[] | null;
}) {
  if (segments && segments.length > 0) {
    return (
      <>
        {segments.map((seg, i) => (
          <span key={i} style={{ color: segmentColor(seg) }}>
            {seg.text}
          </span>
        ))}
      </>
    );
  }
  return <>{text}</>;
}

/** Render word-level changes for a paired add/delete line. */
function WordDiffCell({ parts, side }: { parts: WordPart[]; side: "old" | "new" }) {
  return (
    <>
      {parts.map((p, i) => {
        const isOld = p.removed;
        const isNew = p.added;
        const show = side === "old" ? !isNew : !isOld;
        if (!show) return null;
        const highlight = side === "old" ? isOld : isNew;
        return (
          <span
            key={i}
            style={{
              backgroundColor: highlight ? (side === "old" ? DEL_WORD_BG : ADD_WORD_BG) : undefined,
              borderRadius: highlight ? "2px" : undefined,
            }}
          >
            {p.value}
          </span>
        );
      })}
    </>
  );
}

const UnifiedRow = memo(function UnifiedRow({
  line,
  segments,
}: {
  line: DiffLine;
  segments: TokenSegment[] | null;
}) {
  return (
    <tr style={{ backgroundColor: ROW_BG[line.type] }}>
      <td style={GUTTER_TD}>{line.oldNumber ?? ""}</td>
      <td style={GUTTER_TD}>{line.newNumber ?? ""}</td>
      <td style={{ width: "1.5ch", textAlign: "center", userSelect: "none", color: SIGN_COLOR[line.type] }}>
        {SIGN[line.type]}
      </td>
      <td style={CODE_TD}>
        <CodeCell text={line.text} segments={segments} />
      </td>
    </tr>
  );
});

// A paired old/new line for split view. Either side may be absent.
interface SplitPair {
  left?: { line: DiffLine; seg: number };
  right?: { line: DiffLine; seg: number };
  // word-diff parts between the old and new text (only when both sides present).
  words?: WordPart[];
}

function pairHunkLines(lines: DiffLine[], segStart: number, cap: number): { pairs: SplitPair[]; consumed: number } {
  const pairs: SplitPair[] = [];
  let s = segStart;
  let i = 0;
  while (i < lines.length) {
    if (s >= cap) break;
    const cur = lines[i];
    if (cur.type === "context") {
      const idx = s++;
      pairs.push({ left: { line: cur, seg: idx }, right: { line: cur, seg: idx } });
      i++;
      continue;
    }
    const dels: { line: DiffLine; seg: number }[] = [];
    while (i < lines.length && lines[i].type === "delete" && s < cap) {
      dels.push({ line: lines[i], seg: s++ });
      i++;
    }
    const adds: { line: DiffLine; seg: number }[] = [];
    while (i < lines.length && lines[i].type === "add" && s < cap) {
      adds.push({ line: lines[i], seg: s++ });
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const left = dels[k];
      const right = adds[k];
      const words = left && right ? wordDiffParts(left.line.text, right.line.text) : undefined;
      pairs.push({ left, right, words });
    }
  }
  return { pairs, consumed: s - segStart };
}

const SplitRow = memo(function SplitRow({ pair, segments }: { pair: SplitPair; segments: TokenSegment[][] | null }) {
  const left = pair.left;
  const right = pair.right;
  return (
    <tr>
      <td style={GUTTER_TD}>{left?.line.oldNumber ?? ""}</td>
      <td
        style={{
          ...CODE_TD,
          backgroundColor: left ? ROW_BG[left.line.type] : "var(--bg-tertiary)",
          borderRight: "1px solid var(--border-color)",
          opacity: left ? 1 : 0.4,
        }}
      >
        {left &&
          (pair.words ? (
            <WordDiffCell parts={pair.words} side="old" />
          ) : (
            <CodeCell text={left.line.text} segments={segments?.[left.seg] ?? null} />
          ))}
      </td>
      <td style={GUTTER_TD}>{right?.line.newNumber ?? ""}</td>
      <td style={{ ...CODE_TD, backgroundColor: right ? ROW_BG[right.line.type] : "var(--bg-tertiary)" }}>
        {right &&
          (pair.words ? (
            <WordDiffCell parts={pair.words} side="new" />
          ) : (
            <CodeCell text={right.line.text} segments={segments?.[right.seg] ?? null} />
          ))}
      </td>
    </tr>
  );
});

function DiffFileCard({
  file,
  viewMode,
  onRevealPath,
}: {
  file: DiffFile;
  viewMode: DiffViewMode;
  onRevealPath?: (relativePath: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const meta = STATUS_META[file.status];

  // Tokenize the file's full source once (context+add+delete lines in order);
  // the per-line segments zip back onto those lines, preserving multi-line
  // tokens. Capped at MAX_LINES_PER_FILE so a generated file never stalls it.
  const { segments, cap, totalLines } = useMemo(() => {
    const content: DiffLine[] = file.hunks.flatMap((h) => h.lines);
    const total = content.length;
    const limit = Math.min(total, MAX_LINES_PER_FILE);
    const source = content.slice(0, limit).map((l) => l.text).join("\n");
    return {
      segments: tokenizeSource(source, languageOfPath(file.path)),
      cap: limit,
      totalLines: total,
    };
  }, [file]);

  const renderBody = (): ReactElement => {
    if (file.binary) {
      return (
        <div className="px-3 py-2 text-[11px] text-[var(--text-secondary)] italic">Binary file changed</div>
      );
    }
    if (file.hunks.length === 0) {
      return (
        <div className="px-3 py-2 text-[11px] text-[var(--text-secondary)] italic">
          {file.status === "renamed" ? "Renamed — no content changes" : "No textual changes"}
        </div>
      );
    }

    const rows: ReactElement[] = [];
    let seg = 0;
    for (const hunk of file.hunks) {
      const keyH = `h${rows.length}`;
      const headerCell = (
        <tr key={keyH}>
          <td
            colSpan={4}
            style={{ padding: 0 }}
          >
            <div
              style={{
                padding: "0.15rem 0.5rem",
                color: "var(--text-secondary)",
                opacity: 0.7,
                fontSize: "0.65rem",
                backgroundColor: "var(--bg-tertiary)",
              }}
            >
              {hunk.header}
            </div>
          </td>
        </tr>
      );

      if (viewMode === "split") {
        rows.push(headerCell);
        const { pairs, consumed } = pairHunkLines(hunk.lines, seg, cap);
        for (const pair of pairs) {
          rows.push(<SplitRow key={`l${rows.length}`} pair={pair} segments={segments} />);
        }
        seg += consumed;
      } else {
        rows.push(headerCell);
        for (const line of hunk.lines) {
          if (seg >= cap) break;
          rows.push(<UnifiedRow key={`l${rows.length}`} line={line} segments={segments?.[seg] ?? null} />);
          seg++;
        }
      }
      if (seg >= cap) break;
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-max min-w-full border-collapse font-mono text-[11px]" style={{ lineHeight: 1.5 }}>
          <tbody>{rows}</tbody>
        </table>
        {totalLines > cap && (
          <div className="px-3 py-1.5 text-[10px] text-[var(--text-secondary)] italic">
            Showing first {cap} of {totalLines} changed lines.
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="border-b border-[var(--border-color)] last:border-b-0">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        <span
          className="text-[10px] font-bold w-4 h-4 flex items-center justify-center rounded shrink-0"
          style={{ color: meta.color, backgroundColor: `${meta.color}22` }}
          title={file.status}
        >
          {meta.label}
        </span>
        <span
          className="text-[10px] text-[var(--text-secondary)] shrink-0"
          style={{ transition: "transform 0.15s", transform: collapsed ? "rotate(-90deg)" : "none" }}
        >
          ▾
        </span>
        <span className="text-[11px] text-[var(--text-primary)] truncate flex-1 font-mono">
          {file.path}
        </span>
        {onRevealPath && (
          <span
            role="button"
            tabIndex={0}
            title="在文件管理器中显示"
            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onRevealPath(file.path);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onRevealPath(file.path);
              }
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </span>
        )}
        {file.status === "renamed" && file.oldPath && (
          <span className="text-[10px] text-[var(--text-secondary)] truncate shrink-0">← {file.oldPath}</span>
        )}
        {file.additions > 0 && (
          <span className="text-[10px] font-mono shrink-0" style={{ color: "#3fb950" }}>
            +{file.additions}
          </span>
        )}
        {file.deletions > 0 && (
          <span className="text-[10px] font-mono shrink-0" style={{ color: "#f85149" }}>
            −{file.deletions}
          </span>
        )}
      </button>
      {!collapsed && renderBody()}
    </div>
  );
}

const DiffFileCardMemo = memo(DiffFileCard);

function DiffViewerImpl({ diff, viewMode, onRevealPath }: DiffViewerProps) {
  const parsed = useMemo(() => parseGitDiff(diff), [diff]);

  if (parsed.empty) {
    return (
      <div className="px-3 py-6 text-center text-xs text-[var(--text-secondary)]">No changes</div>
    );
  }

  return (
    <div className="flex flex-col">
      {parsed.files.map((file, i) => (
        <DiffFileCardMemo key={`${i}:${file.path}`} file={file} viewMode={viewMode} onRevealPath={onRevealPath} />
      ))}
    </div>
  );
}

const DiffViewer = memo(DiffViewerImpl);
export default DiffViewer;

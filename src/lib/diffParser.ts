import { parsePatch } from "diff";
import type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  ParsedDiff,
} from "../types";

/**
 * Parse raw `git diff` (unified) output into structured files → hunks → lines.
 *
 * jsdiff's `parsePatch` does the heavy lifting (hunk ranges, +/-/space line
 * prefixes, "\\ No newline" markers, a//b//dev/null path stripping and
 * unquoting). We layer on top of it:
 *   - per-file status (added/deleted/renamed/modified) from git header lines,
 *     which parsePatch discards;
 *   - binary detection;
 *   - rename-only / mode-only files (which have no hunks and so produce no
 *     parsePatch entry at all) recovered from their explicit header lines.
 */

// Cast target — decouples us from diff's exported type names.
interface JsHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}
interface JsPatch {
  oldFileName: string | null;
  newFileName: string | null;
  hunks: JsHunk[];
}

// Split raw diff into per-file text blocks on the leading `diff --git` line,
// preserving the header lines (mode/rename/index) parsePatch drops.
function splitFileBlocks(diff: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && cur.length) {
      blocks.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length && cur.some((l) => l.trim())) blocks.push(cur.join("\n"));
  return blocks;
}

function detectStatus(block: string, oldName: string | null, newName: string | null): DiffFileStatus {
  if (/^new file mode /m.test(block)) return "added";
  if (/^deleted file mode /m.test(block)) return "deleted";
  if (/^rename (from|to) /m.test(block)) return "renamed";
  if (oldName === "/dev/null") return "added";
  if (newName === "/dev/null") return "deleted";
  return "modified";
}

function isBinary(block: string): boolean {
  return /^Binary files /m.test(block) || /^GIT binary patch/m.test(block);
}

function parseHunkLines(
  lines: string[],
  oldStart: number,
  newStart: number,
): { lines: DiffLine[]; additions: number; deletions: number } {
  const out: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let oldN = oldStart;
  let newN = newStart;
  for (const raw of lines) {
    // "\ No newline at end of file" attaches to the previous line.
    if (raw[0] === "\\") {
      if (out.length) out[out.length - 1].noNewline = true;
      continue;
    }
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === "+") {
      out.push({ type: "add", text, newNumber: newN++ });
      additions++;
    } else if (sign === "-") {
      out.push({ type: "delete", text, oldNumber: oldN++ });
      deletions++;
    } else {
      // " " context (or anything unexpected) — treat as context.
      out.push({ type: "context", text, oldNumber: oldN++, newNumber: newN++ });
    }
  }
  return { lines: out, additions, deletions };
}

function parseBlock(block: string): DiffFile | null {
  const patch = (parsePatch(block) as unknown as JsPatch[])[0];

  const renameFrom = block.match(/^rename from (.+)$/m)?.[1];
  const renameTo = block.match(/^rename to (.+)$/m)?.[1];

  // Path resolution. jsdiff's parsePatch keeps git's `a/`/`b/` prefixes on the
  // ---/+++ paths (e.g. "b/package.json"); strip them. Rename from/to lines are
  // already clean. detectStatus gets the RAW names so its /dev/null checks fire.
  const cleanPath = (p: string | null): string | null => {
    if (!p || p === "/dev/null") return null;
    if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
    return p;
  };
  const newName = renameTo ?? cleanPath(patch?.newFileName ?? null) ?? null;
  const oldName = renameFrom ?? cleanPath(patch?.oldFileName ?? null) ?? null;
  const status = detectStatus(block, patch?.oldFileName ?? null, patch?.newFileName ?? null);
  const path = newName ?? oldName ?? "<unknown>";

  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (const h of patch?.hunks ?? []) {
    const parsed = parseHunkLines(h.lines, h.oldStart, h.newStart);
    hunks.push({
      header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      lines: parsed.lines,
    });
    additions += parsed.additions;
    deletions += parsed.deletions;
  }

  return {
    path,
    oldPath: status === "renamed" && oldName ? oldName : undefined,
    status,
    binary: isBinary(block),
    hunks,
    additions,
    deletions,
  };
}

export function parseGitDiff(diff: string): ParsedDiff {
  if (!diff || !diff.trim()) return { files: [], empty: true };
  const files = splitFileBlocks(diff)
    .map(parseBlock)
    .filter((f): f is DiffFile => f !== null);
  return { files, empty: files.length === 0 };
}

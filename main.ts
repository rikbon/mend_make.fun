// mend — deterministic multi-format AI patch tool (SPEC.md).
// Node 22 standard library only.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type PatchFormat = 'unified' | 'search-replace' | 'v4a' | 'json';
type FormatOption = PatchFormat | 'auto';
type EditFailureCode = 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe';

const VALID_FORMATS = new Set<FormatOption>(['unified', 'search-replace', 'v4a', 'json', 'auto']);

interface CliArgs {
  format: FormatOption;
  check: boolean;
  strict: boolean;
  patchArg: string | null;
}

// --- Section 1: Invocation ---

function parseCliArgs(argv: string[]): CliArgs | null {
  let format: FormatOption = 'auto';
  let seenFormat = false;
  let check = false;
  let strict = false;
  let patchArg: string | null = null;
  let endOfOptions = false;

  for (const arg of argv) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (check) return null;
        check = true;
      } else if (arg === '--strict') {
        if (strict) return null;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return null;
        const val = arg.slice('--format='.length) as FormatOption;
        if (!VALID_FORMATS.has(val)) return null;
        format = val;
        seenFormat = true;
      } else {
        return null;
      }
      continue;
    }
    if (patchArg !== null) return null;
    patchArg = arg;
  }

  return { format, check, strict, patchArg };
}

// --- Section 3: Files, Lines, Paths ---

function isSafePath(p: string): boolean {
  if (p.length === 0 || p.startsWith('/') || p.includes('\\')) return false;
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function splitPatchLines(text: string): string[] {
  if (text.length === 0) return [];
  const raw = text.endsWith('\n') ? text.slice(0, -1) : text;
  return raw.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function detectFileEol(text: string): '\n' | '\r\n' {
  const firstLf = text.indexOf('\n');
  return firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
}

interface ParsedFileLines {
  eol: '\n' | '\r\n';
  lines: string[];
  finalBreak: boolean;
}

function parseFileLines(text: string): ParsedFileLines {
  const eol = detectFileEol(text);
  if (text.length === 0) {
    return { eol: '\n', lines: [], finalBreak: false };
  }
  const finalBreak = text.endsWith('\n');
  const lines = splitPatchLines(text);
  return { eol, lines, finalBreak };
}

function serializeFileLines(lines: string[], eol: '\n' | '\r\n', finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(eol) + (finalBreak ? eol : '');
}

// --- Section 4: Detecting Format ---

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

function detectFormat(lines: string[]): PatchFormat | null {
  const firstNonBlank = lines.find((l) => !isBlankLine(l));
  if (firstNonBlank !== undefined) {
    const trimmed = firstNonBlank.trim();
    if (trimmed === '*** Begin Patch') return 'v4a';
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';
  }
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) {
    return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// --- Section 5: Matching Lines ---

function stripTrailingSpacesTabs(s: string): string {
  return s.replace(/[\t ]+$/, '');
}

function stripBothSpacesTabs(s: string): string {
  return s.replace(/^[\t ]+|[\t ]+$/g, '');
}

function linesEqualAtTier(a: string, b: string, tier: 0 | 1 | 2): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingSpacesTabs(a) === stripTrailingSpacesTabs(b);
  return stripBothSpacesTabs(a) === stripBothSpacesTabs(b);
}

interface MatchResult {
  tier: 0 | 1 | 2;
  positions: number[];
}

function findLineOccurrences(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  startFrom = 0,
  requireEof = false,
): MatchResult | null {
  const maxTier: 0 | 2 = strict ? 0 : 2;
  const m = oldLines.length;
  if (m === 0) {
    return { tier: 0, positions: [requireEof ? fileLines.length : startFrom] };
  }
  if (m > fileLines.length) return null;

  for (let tier: 0 | 1 | 2 = 0; tier <= maxTier; tier = (tier + 1) as 0 | 1 | 2) {
    const positions: number[] = [];
    const minPos = requireEof ? Math.max(startFrom, fileLines.length - m) : startFrom;
    const maxPos = fileLines.length - m;
    for (let pos = minPos; pos <= maxPos; pos++) {
      let ok = true;
      for (let k = 0; k < m; k++) {
        if (!linesEqualAtTier(fileLines[pos + k], oldLines[k], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(pos);
    }
    if (positions.length > 0) {
      return { tier, positions };
    }
  }
  return null;
}

function leadingSpacesTabs(s: string): string {
  const m = /^[\t ]*/.exec(s);
  return m ? m[0] : '';
}

function buildReplacementLines(
  fileLines: string[],
  matchPos: number,
  oldLines: string[],
  newLines: string[],
  originInO: (number | null)[],
  tier: 0 | 1 | 2,
): string[] {
  const F = oldLines.length > 0 && matchPos < fileLines.length ? leadingSpacesTabs(fileLines[matchPos]) : '';
  const P = oldLines.length > 0 ? leadingSpacesTabs(oldLines[0]) : '';
  const out: string[] = [];

  for (let j = 0; j < newLines.length; j++) {
    const oIdx = originInO[j];
    if (oIdx !== null) {
      out.push(fileLines[matchPos + oIdx]);
      continue;
    }
    const line = newLines[j];
    if (tier === 2 && line.length > 0 && !/^[\t ]*$/.test(line) && line.startsWith(P)) {
      out.push(F + line.slice(P.length));
    } else {
      out.push(line);
    }
  }
  return out;
}

// --- Edit Representation ---

interface UnifiedHunk {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
  originInO: (number | null)[];
  noNewlineAfterLastKeep: boolean;
  noNewlineAfterLastPlus: boolean;
  hasPlusLines: boolean;
}

interface UnifiedSectionEdit {
  kind: 'unified';
  mode: 'create' | 'delete' | 'move' | 'modify';
  oldPath: string | null;
  newPath: string | null;
  hunks: UnifiedHunk[];
}

interface SearchReplaceEdit {
  kind: 'search-replace';
  path: string;
  oldLines: string[];
  newLines: string[];
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newLines: string[];
  originInO: (number | null)[];
}

type V4AEdit =
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-delete'; path: string }
  | { kind: 'v4a-update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

type JsonEdit =
  | { kind: 'json-create'; path: string; fileText: string }
  | { kind: 'json-str-replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; insertLine: number; newStr: string };

type PatchEdit = UnifiedSectionEdit | SearchReplaceEdit | V4AEdit | JsonEdit;

type ParseResult = { ok: true; edits: PatchEdit[] } | { ok: false; line: number };

// --- Section 6: Unified Diffs ---

function parseUnifiedPathHeader(rest: string): string | null {
  const beforeTab = rest.split('\t')[0].replace(/^[ ]+|[ ]+$/g, '');
  if (beforeTab === '/dev/null') return null;
  if (beforeTab.startsWith('a/') || beforeTab.startsWith('b/')) {
    return beforeTab.slice(2);
  }
  return beforeTab;
}

interface RawUnifiedSection {
  startLine: number;
  gitOld: string | null;
  gitNew: string | null;
  hasMinusPlus: boolean;
  minusPath: string | null;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UnifiedHunk[];
}

function parseUnifiedDiff(lines: string[]): ParseResult {
  const sections: RawUnifiedSection[] = [];
  let current: RawUnifiedSection | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Check for diff --git header
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m || m[1].length === 0 || m[2].length === 0) {
        return { ok: false, line: i + 1 };
      }
      current = {
        startLine: i + 1,
        gitOld: m[1],
        gitNew: m[2],
        hasMinusPlus: false,
        minusPath: null,
        plusPath: null,
        renameFrom: null,
        renameTo: null,
        newFileMode: false,
        deletedFileMode: false,
        hunks: [],
      };
      sections.push(current);
      i++;
      continue;
    }

    // 2. Check for --- header line
    if (line.startsWith('--- ')) {
      if (i + 1 >= lines.length || !lines[i + 1].startsWith('+++ ')) {
        return { ok: false, line: i + 2 };
      }
      const minusPath = parseUnifiedPathHeader(line.slice(4));
      const plusPath = parseUnifiedPathHeader(lines[i + 1].slice(4));

      if (current !== null && current.hunks.length === 0 && !current.hasMinusPlus) {
        current.hasMinusPlus = true;
        current.minusPath = minusPath;
        current.plusPath = plusPath;
      } else {
        current = {
          startLine: i + 1,
          gitOld: null,
          gitNew: null,
          hasMinusPlus: true,
          minusPath,
          plusPath,
          renameFrom: null,
          renameTo: null,
          newFileMode: false,
          deletedFileMode: false,
          hunks: [],
        };
        sections.push(current);
      }
      i += 2;
      continue;
    }

    // 3. Check for @@ hunk header
    if (line.startsWith('@@')) {
      if (current === null) {
        return { ok: false, line: i + 1 };
      }
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!hm) {
        return { ok: false, line: i + 1 };
      }
      const oldStart = Number(hm[1]);
      i++;

      const rawBody: { raw: string; lineNo: number }[] = [];
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.startsWith('diff --git')) break;
        if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          rawBody.push({ raw: bl, lineNo: i + 1 });
          i++;
        } else {
          break;
        }
      }

      // Empty lines at the end of a body are not part of it.
      while (rawBody.length > 0 && rawBody[rawBody.length - 1].raw === '') {
        rawBody.pop();
      }

      const oldLines: string[] = [];
      const newLines: string[] = [];
      const originInO: (number | null)[] = [];
      let prevKind: ' ' | '+' | '-' | null = null;
      let noNewlineAfterLastKeep = false;
      let noNewlineAfterLastPlus = false;
      let hasPlusLines = false;

      for (const item of rawBody) {
        const raw = item.raw;
        if (raw === '' || raw.startsWith(' ')) {
          const content = raw === '' ? '' : raw.slice(1);
          const oIdx = oldLines.length;
          oldLines.push(content);
          newLines.push(content);
          originInO.push(oIdx);
          prevKind = ' ';
          noNewlineAfterLastKeep = false;
        } else if (raw.startsWith('-')) {
          oldLines.push(raw.slice(1));
          prevKind = '-';
        } else if (raw.startsWith('+')) {
          newLines.push(raw.slice(1));
          originInO.push(null);
          prevKind = '+';
          hasPlusLines = true;
          noNewlineAfterLastKeep = false;
          noNewlineAfterLastPlus = false;
        } else if (raw.startsWith('\\')) {
          if (prevKind === null) {
            return { ok: false, line: item.lineNo };
          }
          if (prevKind === ' ' || prevKind === '+') {
            noNewlineAfterLastKeep = true;
          }
          if (prevKind === '+') {
            noNewlineAfterLastPlus = true;
          }
        }
      }

      current.hunks.push({
        oldStart,
        oldLines,
        newLines,
        originInO,
        noNewlineAfterLastKeep,
        noNewlineAfterLastPlus,
        hasPlusLines,
      });
      continue;
    }

    // 4. Within a section, before its first hunk: header metadata
    if (current !== null && current.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        current.renameFrom = line.slice('rename from '.length).split('\t')[0].replace(/^[ ]+|[ ]+$/g, '');
      } else if (line.startsWith('rename to ')) {
        current.renameTo = line.slice('rename to '.length).split('\t')[0].replace(/^[ ]+|[ ]+$/g, '');
      } else if (line.startsWith('new file mode')) {
        current.newFileMode = true;
      } else if (line.startsWith('deleted file mode')) {
        current.deletedFileMode = true;
      }
    }

    i++;
  }

  if (sections.length === 0) {
    return { ok: false, line: 1 };
  }

  const edits: UnifiedSectionEdit[] = [];
  for (const sec of sections) {
    let oldPath: string | null = null;
    let newPath: string | null = null;

    if (sec.hasMinusPlus) {
      oldPath = sec.minusPath;
      newPath = sec.plusPath;
    } else if (sec.renameFrom !== null || sec.renameTo !== null) {
      oldPath = sec.renameFrom ?? sec.gitOld;
      newPath = sec.renameTo ?? sec.gitNew;
    } else {
      oldPath = sec.gitOld;
      newPath = sec.gitNew;
    }

    const isCreate = sec.newFileMode || (sec.hasMinusPlus && sec.minusPath === null);
    const isDelete = sec.deletedFileMode || (sec.hasMinusPlus && sec.plusPath === null);

    if (isCreate && isDelete) {
      return { ok: false, line: sec.startLine };
    }

    if (isCreate) {
      const target = newPath ?? sec.gitNew ?? sec.renameTo;
      if (target === null) return { ok: false, line: sec.startLine };
      edits.push({ kind: 'unified', mode: 'create', oldPath: null, newPath: target, hunks: sec.hunks });
    } else if (isDelete) {
      const target = oldPath ?? sec.gitOld ?? sec.renameFrom;
      if (target === null) return { ok: false, line: sec.startLine };
      edits.push({ kind: 'unified', mode: 'delete', oldPath: target, newPath: null, hunks: sec.hunks });
    } else {
      const resolvedOld = oldPath ?? sec.gitOld;
      const resolvedNew = newPath ?? sec.gitNew;
      if (resolvedOld === null || resolvedNew === null) {
        return { ok: false, line: sec.startLine };
      }
      if (resolvedOld !== resolvedNew) {
        edits.push({ kind: 'unified', mode: 'move', oldPath: resolvedOld, newPath: resolvedNew, hunks: sec.hunks });
      } else {
        edits.push({ kind: 'unified', mode: 'modify', oldPath: resolvedOld, newPath: resolvedNew, hunks: sec.hunks });
      }
    }
  }

  return { ok: true, edits };
}

// --- Section 7: SEARCH/REPLACE Blocks ---

function parseSearchReplace(lines: string[]): ParseResult {
  const edits: SearchReplaceEdit[] = [];
  let prevEndLineIdx = 0;
  let lastPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }

    const searchLineIdx = i;
    const searchLineNo = i + 1;

    // Find nearest line before <<<<<<< SEARCH and after previous block's >>>>>>> REPLACE
    let candidatePath: string | null = null;
    for (let j = searchLineIdx - 1; j >= prevEndLineIdx; j--) {
      const trimmed = lines[j].trim();
      if (trimmed.length === 0 || trimmed.startsWith('```')) continue;
      candidatePath = trimmed;
      break;
    }

    const resolvedPath = candidatePath ?? lastPath;
    if (resolvedPath === null) {
      return { ok: false, line: searchLineNo };
    }

    // Locate ======= and then >>>>>>> REPLACE
    let dividerIdx = -1;
    for (let j = searchLineIdx + 1; j < lines.length; j++) {
      const t = lines[j].trimEnd();
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') {
        return { ok: false, line: searchLineNo };
      }
      if (t === '=======') {
        dividerIdx = j;
        break;
      }
    }
    if (dividerIdx < 0) {
      return { ok: false, line: searchLineNo };
    }

    let replaceEndIdx = -1;
    for (let j = dividerIdx + 1; j < lines.length; j++) {
      const t = lines[j].trimEnd();
      if (t === '<<<<<<< SEARCH') {
        return { ok: false, line: searchLineNo };
      }
      if (t === '>>>>>>> REPLACE') {
        replaceEndIdx = j;
        break;
      }
    }
    if (replaceEndIdx < 0) {
      return { ok: false, line: searchLineNo };
    }

    edits.push({
      kind: 'search-replace',
      path: resolvedPath,
      oldLines: lines.slice(searchLineIdx + 1, dividerIdx),
      newLines: lines.slice(dividerIdx + 1, replaceEndIdx),
    });

    lastPath = resolvedPath;
    prevEndLineIdx = replaceEndIdx + 1;
    i = replaceEndIdx + 1;
  }

  if (edits.length === 0) {
    return { ok: false, line: 1 };
  }
  return { ok: true, edits };
}

// --- Section 8: V4A Patches ---

function isV4ASectionHeader(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function parseV4A(lines: string[]): ParseResult {
  let firstNonBlankIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      firstNonBlankIdx = i;
      break;
    }
  }
  if (firstNonBlankIdx < 0) {
    return { ok: false, line: 1 };
  }
  if (lines[firstNonBlankIdx].trim() !== '*** Begin Patch') {
    return { ok: false, line: firstNonBlankIdx + 1 };
  }

  let lastNonBlankIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlankLine(lines[i])) {
      lastNonBlankIdx = i;
      break;
    }
  }
  if (lastNonBlankIdx <= firstNonBlankIdx || lines[lastNonBlankIdx].trim() !== '*** End Patch') {
    return { ok: false, line: lines.length + 1 };
  }

  const edits: V4AEdit[] = [];
  let i = firstNonBlankIdx + 1;

  while (i < lastNonBlankIdx) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }

    if (!isV4ASectionHeader(line)) {
      return { ok: false, line: i + 1 };
    }

    const headerLineNo = i + 1;
    let sectionStart = i + 1;
    let sectionEnd = sectionStart;
    while (sectionEnd < lastNonBlankIdx && !isV4ASectionHeader(lines[sectionEnd])) {
      if (lines[sectionEnd].trim() === '*** End Patch') {
        return { ok: false, line: sectionEnd + 1 };
      }
      sectionEnd++;
    }

    // Blank lines at the end of a section are not part of it.
    let bodyEnd = sectionEnd;
    while (bodyEnd > sectionStart && isBlankLine(lines[bodyEnd - 1])) {
      bodyEnd--;
    }

    if (line.startsWith('*** Add File: ')) {
      const targetPath = line.slice('*** Add File: '.length).replace(/^[ ]+|[ ]+$/g, '');
      const addedLines: string[] = [];
      for (let j = sectionStart; j < bodyEnd; j++) {
        const bl = lines[j];
        if (bl === '') {
          addedLines.push('');
        } else if (bl.startsWith('+')) {
          addedLines.push(bl.slice(1));
        } else {
          return { ok: false, line: j + 1 };
        }
      }
      edits.push({ kind: 'v4a-add', path: targetPath, lines: addedLines });
    } else if (line.startsWith('*** Delete File: ')) {
      const targetPath = line.slice('*** Delete File: '.length).replace(/^[ ]+|[ ]+$/g, '');
      if (bodyEnd > sectionStart) {
        return { ok: false, line: sectionStart + 1 };
      }
      edits.push({ kind: 'v4a-delete', path: targetPath });
    } else if (line.startsWith('*** Update File: ')) {
      const targetPath = line.slice('*** Update File: '.length).replace(/^[ ]+|[ ]+$/g, '');
      let moveTo: string | null = null;
      let cursorIdx = sectionStart;

      if (cursorIdx < bodyEnd && lines[cursorIdx].startsWith('*** Move to: ')) {
        moveTo = lines[cursorIdx].slice('*** Move to: '.length).replace(/^[ ]+|[ ]+$/g, '');
        cursorIdx++;
      }

      const chunks: V4AChunk[] = [];
      let currentChunk: V4AChunk | null = null;
      let chunkClosedByEof = false;

      for (let j = cursorIdx; j < bodyEnd; j++) {
        const bl = lines[j];

        if (bl.startsWith('@@')) {
          const anchorText = bl.slice(2).replace(/^[ ]+|[ ]+$/g, '');
          currentChunk = {
            anchor: anchorText.length > 0 ? anchorText : null,
            eof: false,
            oldLines: [],
            newLines: [],
            originInO: [],
          };
          chunks.push(currentChunk);
          chunkClosedByEof = false;
          continue;
        }

        if (bl === '*** End of File') {
          if (currentChunk === null || chunkClosedByEof) {
            return { ok: false, line: j + 1 };
          }
          currentChunk.eof = true;
          chunkClosedByEof = true;
          continue;
        }

        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (chunkClosedByEof) {
            return { ok: false, line: j + 1 };
          }
          if (currentChunk === null) {
            // Only the first chunk may start directly at a body line without @@
            if (chunks.length > 0) {
              return { ok: false, line: j + 1 };
            }
            currentChunk = {
              anchor: null,
              eof: false,
              oldLines: [],
              newLines: [],
              originInO: [],
            };
            chunks.push(currentChunk);
          }

          if (bl === '' || bl.startsWith(' ')) {
            const content = bl === '' ? '' : bl.slice(1);
            const oIdx = currentChunk.oldLines.length;
            currentChunk.oldLines.push(content);
            currentChunk.newLines.push(content);
            currentChunk.originInO.push(oIdx);
          } else if (bl.startsWith('-')) {
            currentChunk.oldLines.push(bl.slice(1));
          } else if (bl.startsWith('+')) {
            currentChunk.newLines.push(bl.slice(1));
            currentChunk.originInO.push(null);
          }
          continue;
        }

        return { ok: false, line: j + 1 };
      }

      if (chunks.length === 0 && moveTo === null) {
        return { ok: false, line: headerLineNo };
      }

      edits.push({ kind: 'v4a-update', path: targetPath, moveTo, chunks });
    }

    i = sectionEnd;
  }

  if (edits.length === 0) {
    return { ok: false, line: 1 };
  }

  return { ok: true, edits };
}

// --- Section 9: JSON / JSONL str_replace_editor ---

function jsonSyntaxErrorLine(text: string, err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const posMatch = /position (\d+)/.exec(msg);
  if (posMatch) {
    const pos = Math.min(Number(posMatch[1]), text.length);
    let line = 1;
    for (let i = 0; i < pos; i++) {
      if (text[i] === '\n') line++;
    }
    return line;
  }
  return 1;
}

function decodeJsonCall(raw: unknown): JsonEdit | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let obj = raw as Record<string, unknown>;

  if ('name' in obj && (obj.arguments !== undefined || obj.input !== undefined)) {
    if (obj.name !== 'str_replace_editor') return null;
    const inner = obj.arguments !== undefined ? obj.arguments : obj.input;
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return null;
    obj = inner as Record<string, unknown>;
  }

  const command = obj.command;
  const path = obj.path;
  if (typeof command !== 'string' || typeof path !== 'string') return null;

  if (command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    return { kind: 'json-create', path, fileText: obj.file_text };
  }
  if (command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || typeof obj.new_str !== 'string') return null;
    if (obj.old_str.length === 0) return null;
    return { kind: 'json-str-replace', path, oldStr: obj.old_str, newStr: obj.new_str };
  }
  if (command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    return { kind: 'json-insert', path, insertLine: obj.insert_line, newStr: obj.new_str };
  }

  return null;
}

function parseJsonPatch(text: string, lines: string[]): ParseResult {
  const firstNonBlankIdx = lines.findIndex((l) => !isBlankLine(l));
  if (firstNonBlankIdx < 0) {
    return { ok: false, line: 1 };
  }

  const firstTrimmed = lines[firstNonBlankIdx].trim();

  // JSON array
  if (firstTrimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, line: jsonSyntaxErrorLine(text, err) };
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { ok: false, line: 1 };
    }
    const edits: JsonEdit[] = [];
    for (const item of parsed) {
      const edit = decodeJsonCall(item);
      if (!edit) return { ok: false, line: 1 };
      edits.push(edit);
    }
    return { ok: true, edits };
  }

  // Try whole-patch single JSON object first if it starts with '{'
  const nonBlankLineCount = lines.filter((l) => !isBlankLine(l)).length;
  if (firstTrimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const edit = decodeJsonCall(parsed);
      if (!edit) {
        return { ok: false, line: nonBlankLineCount === 1 ? firstNonBlankIdx + 1 : 1 };
      }
      return { ok: true, edits: [edit] };
    } catch (err) {
      // If it's not a multi-line single JSON object, try JSONL below.
      //Wait: how do we distinguish a malformed multi-line single JSON object from JSONL?
    }
  }

  // JSONL: one JSON object per non-blank line
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlankLine(lines[i])) continue;
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(lines[i]);
    } catch {
      // If the whole text looked like a single multi-line JSON object (e.g. first line is just "{"),
      // compute the syntax error line in the whole text if line i is '{'.
      if (lines[i].trim() === '{') {
        try {
          JSON.parse(text);
        } catch (err2) {
          return { ok: false, line: jsonSyntaxErrorLine(text, err2) };
        }
      }
      return { ok: false, line: i + 1 };
    }
    const edit = decodeJsonCall(parsedLine);
    if (!edit) {
      return { ok: false, line: i + 1 };
    }
    edits.push(edit);
  }

  if (edits.length === 0) {
    return { ok: false, line: 1 };
  }
  return { ok: true, edits };
}

// --- Virtual Workspace & Edit Execution ---

class VirtualWorkspace {
  private cwd: string;
  private initial = new Map<string, string | null>();
  private current = new Map<string, string | null>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private load(relPath: string): string | null {
    if (this.current.has(relPath)) {
      return this.current.get(relPath)!;
    }
    const abs = join(this.cwd, ...relPath.split('/'));
    let content: string | null = null;
    try {
      if (existsSync(abs) && statSync(abs).isFile()) {
        content = readFileSync(abs, 'utf8');
      }
    } catch {
      content = null;
    }
    this.initial.set(relPath, content);
    this.current.set(relPath, content);
    return content;
  }

  get(relPath: string): string | null {
    return this.load(relPath);
  }

  set(relPath: string, content: string | null): void {
    this.load(relPath);
    this.current.set(relPath, content);
  }

  entries(): IterableIterator<[string, { before: string | null; after: string | null }]> {
    const map = new Map<string, { before: string | null; after: string | null }>();
    for (const [k, after] of this.current.entries()) {
      const before = this.initial.get(k) ?? null;
      map.set(k, { before, after });
    }
    return map.entries();
  }

  commitToDisk(): void {
    for (const [relPath, after] of this.current.entries()) {
      const before = this.initial.get(relPath) ?? null;
      if (before === after) continue;
      const abs = join(this.cwd, ...relPath.split('/'));
      if (after === null) {
        if (existsSync(abs)) unlinkSync(abs);
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, after, 'utf8');
      }
    }
  }
}

interface EditFailure {
  code: EditFailureCode;
  path: string;
}

interface MoveRecord {
  oldPath: string;
  newPath: string;
}

function recordMove(moves: MoveRecord[], oldPath: string, newPath: string): void {
  const chained = moves.find((m) => m.newPath === oldPath);
  if (chained) {
    chained.newPath = newPath;
  } else {
    moves.push({ oldPath, newPath });
  }
}

function applyHunksToUnifiedFile(
  initialLines: string[],
  initialFinalBreak: boolean,
  hunks: UnifiedHunk[],
  strict: boolean,
): { ok: true; lines: string[]; finalBreak: boolean } | { ok: false } {
  const lines = [...initialLines];
  let finalBreak = initialFinalBreak;
  let delta = 0;

  for (const hunk of hunks) {
    const O = hunk.oldLines;
    const N = hunk.newLines;

    if (O.length === 0) {
      const rawTarget = hunk.oldStart + delta;
      const insertPos = Math.max(0, Math.min(lines.length, rawTarget));
      const touchedEof = insertPos === lines.length;
      lines.splice(insertPos, 0, ...N);
      delta += N.length;
      if (touchedEof && N.length > 0) {
        finalBreak = !hunk.noNewlineAfterLastKeep;
      }
      continue;
    }

    const match = findLineOccurrences(lines, O, strict);
    if (!match) return { ok: false };

    const targetPos = hunk.oldStart - 1 + delta;
    let bestPos = match.positions[0];
    let bestDist = Math.abs(bestPos - targetPos);
    for (let i = 1; i < match.positions.length; i++) {
      const p = match.positions[i];
      const dist = Math.abs(p - targetPos);
      if (dist < bestDist) {
        bestDist = dist;
        bestPos = p;
      }
    }

    const touchedEof = bestPos + O.length === lines.length;
    const replaced = buildReplacementLines(lines, bestPos, O, N, hunk.originInO, match.tier);
    lines.splice(bestPos, O.length, ...replaced);
    delta += N.length - O.length;

    if (touchedEof) {
      finalBreak = lines.length === 0 ? false : !hunk.noNewlineAfterLastKeep;
    }
  }

  if (lines.length === 0) {
    finalBreak = false;
  }

  return { ok: true, lines, finalBreak };
}

function executeUnifiedEdit(
  edit: UnifiedSectionEdit,
  ws: VirtualWorkspace,
  strict: boolean,
  moves: MoveRecord[],
): EditFailure | null {
  if (edit.mode === 'create') {
    const target = edit.newPath!;
    if (!isSafePath(target)) return { code: 'unsafe', path: target };
    if (ws.get(target) !== null) return { code: 'exists', path: target };

    const createdLines: string[] = [];
    let lastPlusNoNewline = false;
    for (const hunk of edit.hunks) {
      for (let j = 0; j < hunk.newLines.length; j++) {
        if (hunk.originInO[j] === null) {
          createdLines.push(hunk.newLines[j]);
        }
      }
      if (hunk.hasPlusLines) {
        lastPlusNoNewline = hunk.noNewlineAfterLastPlus;
      }
    }
    const finalBreak = createdLines.length > 0 && !lastPlusNoNewline;
    ws.set(target, serializeFileLines(createdLines, '\n', finalBreak));
    return null;
  }

  if (edit.mode === 'delete') {
    const target = edit.oldPath!;
    if (!isSafePath(target)) return { code: 'unsafe', path: target };
    if (ws.get(target) === null) return { code: 'missing', path: target };
    ws.set(target, null);
    return null;
  }

  if (edit.mode === 'move') {
    const oldPath = edit.oldPath!;
    const newPath = edit.newPath!;
    if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
    if (!isSafePath(newPath)) return { code: 'unsafe', path: newPath };
    const existing = ws.get(oldPath);
    if (existing === null) return { code: 'missing', path: oldPath };
    if (ws.get(newPath) !== null) return { code: 'exists', path: newPath };

    const parsed = parseFileLines(existing);
    const applied = applyHunksToUnifiedFile(parsed.lines, parsed.finalBreak, edit.hunks, strict);
    if (!applied.ok) return { code: 'no-match', path: oldPath };

    ws.set(oldPath, null);
    ws.set(newPath, serializeFileLines(applied.lines, parsed.eol, applied.finalBreak));
    recordMove(moves, oldPath, newPath);
    return null;
  }

  // mode === 'modify'
  const target = edit.oldPath!;
  if (!isSafePath(target)) return { code: 'unsafe', path: target };
  const existing = ws.get(target);
  if (existing === null) return { code: 'missing', path: target };

  const parsed = parseFileLines(existing);
  const applied = applyHunksToUnifiedFile(parsed.lines, parsed.finalBreak, edit.hunks, strict);
  if (!applied.ok) return { code: 'no-match', path: target };

  ws.set(target, serializeFileLines(applied.lines, parsed.eol, applied.finalBreak));
  return null;
}

function executeSearchReplaceEdit(
  edit: SearchReplaceEdit,
  ws: VirtualWorkspace,
  strict: boolean,
): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };

  if (edit.oldLines.length === 0) {
    if (ws.get(edit.path) !== null) return { code: 'exists', path: edit.path };
    const finalBreak = edit.newLines.length > 0;
    ws.set(edit.path, serializeFileLines(edit.newLines, '\n', finalBreak));
    return null;
  }

  const existing = ws.get(edit.path);
  if (existing === null) return { code: 'missing', path: edit.path };

  const parsed = parseFileLines(existing);
  const match = findLineOccurrences(parsed.lines, edit.oldLines, strict);
  if (!match) return { code: 'no-match', path: edit.path };
  if (match.positions.length > 1) return { code: 'ambiguous', path: edit.path };

  const pos = match.positions[0];
  const originInO = edit.newLines.map(() => null);
  const replaced = buildReplacementLines(parsed.lines, pos, edit.oldLines, edit.newLines, originInO, match.tier);
  const nextLines = [...parsed.lines];
  nextLines.splice(pos, edit.oldLines.length, ...replaced);

  ws.set(edit.path, serializeFileLines(nextLines, parsed.eol, parsed.finalBreak));
  return null;
}

function executeV4AEdit(
  edit: V4AEdit,
  ws: VirtualWorkspace,
  strict: boolean,
  moves: MoveRecord[],
): EditFailure | null {
  if (edit.kind === 'v4a-add') {
    if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
    if (ws.get(edit.path) !== null) return { code: 'exists', path: edit.path };
    const finalBreak = edit.lines.length > 0;
    ws.set(edit.path, serializeFileLines(edit.lines, '\n', finalBreak));
    return null;
  }

  if (edit.kind === 'v4a-delete') {
    if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
    if (ws.get(edit.path) === null) return { code: 'missing', path: edit.path };
    ws.set(edit.path, null);
    return null;
  }

  // v4a-update
  const oldPath = edit.path;
  if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
  const newPath = edit.moveTo !== null && edit.moveTo !== oldPath ? edit.moveTo : null;
  if (newPath !== null && !isSafePath(newPath)) return { code: 'unsafe', path: newPath };

  const existing = ws.get(oldPath);
  if (existing === null) return { code: 'missing', path: oldPath };
  if (newPath !== null && ws.get(newPath) !== null) return { code: 'exists', path: newPath };

  const parsed = parseFileLines(existing);
  const lines = [...parsed.lines];
  let cursor = 0;

  for (const chunk of edit.chunks) {
    if (chunk.anchor !== null) {
      const anchorMatch = findLineOccurrences(lines, [chunk.anchor], strict, cursor, false);
      if (!anchorMatch) return { code: 'no-match', path: oldPath };
      cursor = anchorMatch.positions[0] + 1;
    }

    const O = chunk.oldLines;
    const N = chunk.newLines;

    if (O.length === 0) {
      const insertPos = chunk.eof ? lines.length : cursor;
      lines.splice(insertPos, 0, ...N);
      cursor = insertPos + N.length;
      continue;
    }

    const match = findLineOccurrences(lines, O, strict, cursor, chunk.eof);
    if (!match) return { code: 'no-match', path: oldPath };

    const pos = match.positions[0];
    const replaced = buildReplacementLines(lines, pos, O, N, chunk.originInO, match.tier);
    lines.splice(pos, O.length, ...replaced);
    cursor = pos + replaced.length;
  }

  const serialized = serializeFileLines(lines, parsed.eol, parsed.finalBreak);
  if (newPath !== null) {
    ws.set(oldPath, null);
    ws.set(newPath, serialized);
    recordMove(moves, oldPath, newPath);
  } else {
    ws.set(oldPath, serialized);
  }
  return null;
}

function normalizeJsonStrToEol(str: string, eol: '\n' | '\r\n'): string {
  const lf = str.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

function executeJsonEdit(edit: JsonEdit, ws: VirtualWorkspace): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };

  if (edit.kind === 'json-create') {
    if (ws.get(edit.path) !== null) return { code: 'exists', path: edit.path };
    ws.set(edit.path, edit.fileText);
    return null;
  }

  const existing = ws.get(edit.path);
  if (existing === null) return { code: 'missing', path: edit.path };

  if (edit.kind === 'json-str-replace') {
    const eol = detectFileEol(existing);
    const oldNorm = normalizeJsonStrToEol(edit.oldStr, eol);
    const newNorm = normalizeJsonStrToEol(edit.newStr, eol);

    const firstIdx = existing.indexOf(oldNorm);
    if (firstIdx < 0) return { code: 'no-match', path: edit.path };
    const secondIdx = existing.indexOf(oldNorm, firstIdx + 1);
    if (secondIdx >= 0) return { code: 'ambiguous', path: edit.path };

    const updated = existing.slice(0, firstIdx) + newNorm + existing.slice(firstIdx + oldNorm.length);
    ws.set(edit.path, updated);
    return null;
  }

  // json-insert
  const parsed = parseFileLines(existing);
  if (edit.insertLine < 0 || edit.insertLine > parsed.lines.length) {
    return { code: 'no-match', path: edit.path };
  }

  const normalizedNew = edit.newStr.replace(/\r\n/g, '\n');
  const trimmedNew = normalizedNew.endsWith('\n') ? normalizedNew.slice(0, -1) : normalizedNew;
  const insertedLines = trimmedNew.split('\n');

  const nextLines = [...parsed.lines];
  nextLines.splice(edit.insertLine, 0, ...insertedLines);

  // If the file was empty (0 lines), inserting lines into it produces lines with LF and a final break.
  const finalBreak = parsed.lines.length === 0 ? nextLines.length > 0 : parsed.finalBreak;
  ws.set(edit.path, serializeFileLines(nextLines, parsed.eol, finalBreak));
  return null;
}

// --- Section 2: Output and Exit Codes ---

function compareUtf8Paths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function main(): number {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli) {
    process.stdout.write('error: usage\n');
    return 2;
  }

  let patchText: string;
  try {
    if (cli.patchArg === null || cli.patchArg === '-') {
      patchText = readFileSync(0, 'utf8');
    } else {
      if (!existsSync(cli.patchArg) || !statSync(cli.patchArg).isFile()) {
        process.stdout.write('error: no-patch\n');
        return 2;
      }
      patchText = readFileSync(cli.patchArg, 'utf8');
    }
  } catch {
    process.stdout.write('error: no-patch\n');
    return 2;
  }

  const lines = splitPatchLines(patchText);
  const format: PatchFormat | null = cli.format === 'auto' ? detectFormat(lines) : cli.format;
  if (format === null) {
    process.stdout.write('error: format\n');
    return 2;
  }

  let parsed: ParseResult;
  if (format === 'unified') {
    parsed = parseUnifiedDiff(lines);
  } else if (format === 'search-replace') {
    parsed = parseSearchReplace(lines);
  } else if (format === 'v4a') {
    parsed = parseV4A(lines);
  } else {
    parsed = parseJsonPatch(patchText, lines);
  }

  if (!parsed.ok) {
    process.stdout.write(`error: parse ${parsed.line}\n`);
    return 2;
  }

  const ws = new VirtualWorkspace(process.cwd());
  const failures: EditFailure[] = [];
  const moves: MoveRecord[] = [];

  for (const edit of parsed.edits) {
    let failure: EditFailure | null = null;
    if (edit.kind === 'unified') {
      failure = executeUnifiedEdit(edit, ws, cli.strict, moves);
    } else if (edit.kind === 'search-replace') {
      failure = executeSearchReplaceEdit(edit, ws, cli.strict);
    } else if (edit.kind === 'v4a-add' || edit.kind === 'v4a-delete' || edit.kind === 'v4a-update') {
      failure = executeV4AEdit(edit, ws, cli.strict, moves);
    } else {
      failure = executeJsonEdit(edit, ws);
    }
    if (failure !== null) {
      failures.push(failure);
    }
  }

  if (failures.length > 0) {
    for (const f of failures) {
      process.stdout.write(`error: ${f.code} ${f.path}\n`);
    }
    process.stdout.write(`failed: ${failures.length} of ${parsed.edits.length} edits\n`);
    return 1;
  }

  if (!cli.check) {
    ws.commitToDisk();
  }

  const stateByPath = new Map<string, { before: string | null; after: string | null }>();
  for (const [p, state] of ws.entries()) {
    stateByPath.set(p, state);
  }

  const consumedPaths = new Set<string>();
  const reportItems: { sortKey: string; line: string }[] = [];

  for (const mv of moves) {
    if (consumedPaths.has(mv.oldPath) || consumedPaths.has(mv.newPath)) continue;
    const oldState = stateByPath.get(mv.oldPath);
    const newState = stateByPath.get(mv.newPath);
    if (
      oldState &&
      newState &&
      oldState.before !== null &&
      oldState.after === null &&
      newState.before === null &&
      newState.after !== null
    ) {
      consumedPaths.add(mv.oldPath);
      consumedPaths.add(mv.newPath);
      reportItems.push({
        sortKey: mv.newPath,
        line: `R ${mv.oldPath} -> ${mv.newPath}`,
      });
    }
  }

  for (const [p, { before, after }] of stateByPath.entries()) {
    if (consumedPaths.has(p)) continue;
    if (before === null && after !== null) {
      reportItems.push({ sortKey: p, line: `A ${p}` });
    } else if (before !== null && after === null) {
      reportItems.push({ sortKey: p, line: `D ${p}` });
    } else if (before !== null && after !== null && before !== after) {
      reportItems.push({ sortKey: p, line: `M ${p}` });
    }
  }

  reportItems.sort((a, b) => compareUtf8Paths(a.sortKey, b.sortKey));

  for (const item of reportItems) {
    process.stdout.write(`${item.line}\n`);
  }
  const n = reportItems.length;
  process.stdout.write(`ok: ${n} ${n === 1 ? 'file' : 'files'}\n`);
  return 0;
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  process.exitCode = main();
}

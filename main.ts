// mend — one patch tool for every AI edit format.
//
// Applies an edit a model wrote, in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A patches, JSON tool calls), to the tree of text
// files rooted at the working directory. Written from SPEC.md (version 1):
// every file is changed or nothing is, and the output and exit code say
// what changed or why it failed. Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The patch cannot be read in its format; `line` is the 1-based patch line. */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit failed; `code` is a SPEC.md section 2 code, `path` the file. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** What an edit records while it runs: the moves it made, for the R lines. */
interface RunState {
  moves: Array<[string, string]>;
}

/** An edit: apply it to the tree, or throw an EditFault and change nothing. */
type Edit = (tree: WorkTree, state: RunState) => void;

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A file, split at its own line break. */
interface SplitFile {
  lines: string[];
  br: string;
  ended: boolean;
}

function splitFile(text: string): SplitFile {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, ended: false };
  const parts = text.split(br);
  const ended = text.endsWith(br);
  if (ended) parts.pop();
  return { lines: parts, br, ended };
}

function joinFile(lines: string[], br: string, ended: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ended ? br : '');
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A line as a tier sees it: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  const noTrail = line.replace(/[ \t]+$/, '');
  if (tier === 1) return noTrail;
  return noTrail.replace(/^[ \t]+/, '');
}

/** Every 0-based position at which `old` occurs in `lines` at `tier`. */
function occurrences(lines: string[], old: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const last = lines.length - old.length;
  for (let i = from; i <= last; i += 1) {
    if (eofOnly && i + old.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== tierKey(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs, with its positions, or null. */
function findTier(
  lines: string[],
  old: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(lines, old, tier, from, eofOnly);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One line of N: `fromO` is its index in O when it is a context line, else -1. */
interface NewSeg {
  text: string;
  fromO: number;
}

/** Re-indent one new line at tier 2; at tiers 0 and 1 it is written as it is. */
function reindent(text: string, tier: number, fileLead: string, patchLead: string): string {
  if (tier !== 2) return text;
  if (text.trim() === '') return text;
  if (text.startsWith(patchLead)) return fileLead + text.slice(patchLead.length);
  return text;
}

/** Replace O at `at` with N. Context lines come from the file's own lines. */
function spliceLines(lines: string[], at: number, oldLines: string[], segs: NewSeg[], tier: number): string[] {
  const fileLead = oldLines.length > 0 ? leadingWs(lines[at]!) : '';
  const patchLead = oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  const made = segs.map((s) => (s.fromO >= 0 ? lines[at + s.fromO]! : reindent(s.text, tier, fileLead, patchLead)));
  return [...lines.slice(0, at), ...made, ...lines.slice(at + oldLines.length)];
}

/** The tree as the edits leave it: changed paths in `now`, the rest from disk. */
class WorkTree {
  private readonly orig = new Map<string, string | null>();
  private readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }

  changed(): string[] {
    return [...this.now.keys()];
  }
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4)                                */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  created: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

/** The text after `--- ` or `+++ `, up to the first tab, spaces removed, one leading `a/` or `b/` off. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!;
  const p = raw.trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** A hunk header `@@ -A[,B] +C[,D] @@`, or null when the line is not one. */
function hunkStart(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** A `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  return m === null ? null : [m[1]!, m[2]!];
}

/**
 * Read one section's header, starting at `i`. Returns the index after the
 * header: the first hunk, the next section, or the end of the patch.
 * `pairSeen` says whether this section already named its paths with a pair.
 */
function readHeader(lines: string[], i: number, sec: Section): number {
  let pairSeen = sec.pairOld !== null;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (pairSeen) return i;
        sec.pairOld = headerPath(l);
        sec.pairNew = headerPath(lines[i + 1]!);
        pairSeen = true;
        i += 2;
        continue;
      }
      throw new ParseFault(i + 2);
    }
    if (l.startsWith('diff --git ') || l.startsWith('@@')) return i;
    if (l.startsWith('rename from ')) {
      if (sec.renameOld === null) sec.renameOld = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (sec.renameNew === null) sec.renameNew = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) sec.created = true;
    else if (l.startsWith('deleted file mode')) sec.deleted = true;
    i += 1;
  }
  return i;
}

/** Read one hunk's body, starting after its header. Returns [body, next index]. */
function readBody(lines: string[], i: number): [string[], number] {
  const body: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return [body, i];
}

/** O is the context and `-` lines, N the context and `+` lines, in order. */
function hunkLines(body: string[]): { oldLines: string[]; newSegs: NewSeg[] } {
  const oldLines: string[] = [];
  const newSegs: NewSeg[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const text = l === '' ? '' : l.slice(1);
      const idx = oldLines.length;
      oldLines.push(text);
      newSegs.push({ text, fromO: idx });
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      newSegs.push({ text: l.slice(1), fromO: -1 });
    }
  }
  return { oldLines, newSegs };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: string[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const l = body[i]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') {
      return body[i + 1] !== undefined && body[i + 1]![0] === '\\';
    }
  }
  return false;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    let sec: Section | null = null;
    if (l.startsWith('diff --git ')) {
      const paths = gitPaths(l);
      if (paths === null) throw new ParseFault(i + 1);
      sec = { gitOld: paths[0], gitNew: paths[1], pairOld: null, pairNew: null, renameOld: null, renameNew: null, created: false, deleted: false, hunks: [] };
      i += 1;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renameOld: null, renameNew: null, created: false, deleted: false, hunks: [] };
    } else if (l.startsWith('@@')) {
      throw new ParseFault(i + 1);
    } else {
      i += 1;
      continue;
    }
    i = readHeader(lines, i, sec);
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('@@')) {
        const a = hunkStart(h);
        if (a === null) throw new ParseFault(i + 1);
        i += 1;
        const [body, next] = readBody(lines, i);
        sec.hunks.push({ a, body });
        i = next;
        continue;
      }
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      i += 1;
    }
    edits.push(unifiedEdit(sec, strict));
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree, state) => {
    // A `---`/`+++` pair names the paths; else `rename from`/`to`; else `diff --git`.
    const oldPath = sec.pairOld ?? sec.renameOld ?? sec.gitOld;
    const newPath = sec.pairNew ?? sec.renameNew ?? sec.gitNew;
    if (oldPath === null || newPath === null) throw new EditFault('missing', oldPath ?? '');
    const created = oldPath === '/dev/null' || sec.created;
    const deleted = newPath === '/dev/null' || sec.deleted;
    if (created) {
      if (!isSafePath(newPath)) throw new EditFault('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new EditFault('exists', newPath);
      const plus: string[] = [];
      let noEol = false;
      let lastPlus: { body: string[]; at: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          if (h.body[k]![0] === '+') lastPlus = { body: h.body, at: k };
        }
        for (const b of h.body) if (b[0] === '+') plus.push(b.slice(1));
      }
      if (lastPlus !== null) {
        const after = lastPlus.body[lastPlus.at + 1];
        noEol = after !== undefined && after[0] === '\\';
      }
      tree.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (deleted) {
      if (!isSafePath(oldPath)) throw new EditFault('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new EditFault('missing', oldPath);
      tree.set(oldPath, null);
      return;
    }
    const moved = oldPath !== newPath;
    if (!isSafePath(oldPath)) throw new EditFault('unsafe', oldPath);
    if (moved && !isSafePath(newPath)) throw new EditFault('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new EditFault('missing', oldPath);
    if (moved && tree.get(newPath) !== null) throw new EditFault('exists', newPath);
    const f = splitFile(before);
    let lines = f.lines;
    let ended = f.ended;
    let d = 0;
    for (const h of sec.hunks) {
      const { oldLines, newSegs } = hunkLines(h.body);
      if (oldLines.length === 0) {
        const at = Math.min(h.a + d, lines.length);
        const ins = newSegs.map((s) => s.text);
        const atEnd = at === lines.length;
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        if (atEnd) ended = !hunkNoEol(h.body);
        d += newSegs.length;
        continue;
      }
      const found = findTier(lines, oldLines, strict, 0, false);
      if (found === null) throw new EditFault('no-match', oldPath);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + oldLines.length === lines.length;
      lines = spliceLines(lines, best, oldLines, newSegs, found.tier);
      if (atEnd) ended = !hunkNoEol(h.body);
      d += newSegs.length - oldLines.length;
    }
    const text = joinFile(lines, f.br, ended);
    if (moved) {
      tree.set(oldPath, null);
      tree.set(newPath, text);
      state.moves.push([oldPath, newPath]);
    } else {
      tree.set(oldPath, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchLine);
    let j = i + 1;
    const oldLines: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      oldLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new ParseFault(searchLine);
    j += 1;
    const newLines: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new ParseFault(searchLine);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = j + 1;
    i = j + 1;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict, 0, false);
    if (found === null) throw new EditFault('no-match', path);
    if (found.pos.length > 1) throw new EditFault('ambiguous', path);
    const segs = newLines.map((text) => ({ text, fromO: -1 }));
    tree.set(path, joinFile(spliceLines(f.lines, found.pos[0]!, oldLines, segs, found.tier), f.br, f.ended));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last) {
        const x = lines[i]!;
        if (x.startsWith('*** Add File: ') || x.startsWith('*** Delete File: ') || x.startsWith('*** Update File: ')) break;
        if (x === '') {
          fileLines.push('');
          i += 1;
          continue;
        }
        if (x[0] === '+') {
          fileLines.push(x.slice(1));
          i += 1;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      while (fileLines.length > 0 && isBlank(fileLines[fileLines.length - 1]!)) fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i += 1;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      let firstLine = true;
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const x = lines[i]!;
        if (x.startsWith('*** Add File: ') || x.startsWith('*** Delete File: ') || x.startsWith('*** Update File: ')) break;
        if (firstLine && x.startsWith('*** Move to: ')) {
          moveTo = x.slice('*** Move to: '.length).trim();
          firstLine = false;
          i += 1;
          continue;
        }
        firstLine = false;
        if (x.startsWith('@@')) {
          close();
          const anchor = x.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          i += 1;
          continue;
        }
        if (x === '*** End of File') {
          if (cur === null) throw new ParseFault(i + 1);
          cur.eof = true;
          close();
          i += 1;
          continue;
        }
        if (x === '' || x[0] === ' ' || x[0] === '-' || x[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseFault(i + 1);
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push(x);
          i += 1;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      close();
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        while (tail.body.length > 0 && isBlank(tail.body[tail.body.length - 1]!)) tail.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateLine);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new ParseFault(i + 1);
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) !== null) throw new EditFault('exists', path);
    tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) === null) throw new EditFault('missing', path);
    tree.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree, state) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const f = splitFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], strict, cursor, false);
        if (found === null) throw new EditFault('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const { oldLines, newSegs } = hunkLines(ch.body);
      if (oldLines.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const ins = newSegs.map((s) => s.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      const found = findTier(lines, oldLines, strict, cursor, ch.eof);
      if (found === null) throw new EditFault('no-match', path);
      const pos = found.pos[0]!;
      lines = spliceLines(lines, pos, oldLines, newSegs, found.tier);
      cursor = pos + newSegs.length;
    }
    const text = joinFile(lines, f.br, f.ended);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, text);
      state.moves.push([path, moveTo]);
    } else {
      tree.set(path, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const crlf = fileIsCrlf(before);
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        count += 1;
        if (at < 0) at = k;
      }
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const f = splitFile(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new EditFault('no-match', p);
      const lines = [...f.lines];
      lines.splice(lineNo, 0, ...add);
      tree.set(p, joinFile(lines, f.br, f.ended));
    };
  }
  return null;
}

function fileIsCrlf(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseFault(1);
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2 and 10)                      */
/* ------------------------------------------------------------------ */

interface RunResult {
  code: number;
  out: string[];
}

function usageResult(): RunResult {
  return { code: 2, out: ['error: usage'] };
}

function run(argv: string[]): RunResult {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usageResult();
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usageResult();
        format = v;
      } else if (a === '--check') {
        if (check) return usageResult();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usageResult();
        strict = true;
      } else {
        return usageResult();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usageResult();
  const patchArg = pos.length === 0 ? null : pos[0]!;
  const patchFile = patchArg === null || patchArg === '-' ? null : patchArg;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(text, lines);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new WorkTree();
  const state: RunState = { moves: [] };
  const fails: EditFault[] = [];
  for (const edit of edits) {
    try {
      edit(tree, state);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const movedOld = new Map<string, string>();
  const movedNew = new Set<string>();
  for (const [o, n] of state.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      movedOld.set(o, n);
      movedNew.add(n);
    }
  }
  for (const p of tree.changed()) {
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    if (movedOld.has(p)) continue;
    if (movedNew.has(p)) {
      let old = '';
      for (const [o, n] of state.moves) {
        if (n === p) {
          old = o;
          break;
        }
      }
      rows.push({ key: p, line: `R ${old} -> ${p}` });
      continue;
    }
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of tree.changed()) {
      const now = tree.get(p);
      if (now === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of tree.changed()) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (now === null || was === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

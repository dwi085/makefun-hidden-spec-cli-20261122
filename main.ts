// mend: one patch tool for every AI edit format, as SPEC.md specifies.
// Reads a unified diff, SEARCH/REPLACE blocks, a V4A patch or text-editor
// tool calls as JSON, finds the lines each edit names at the first of three
// matching tiers (exact, trailing whitespace, full trim with re-indentation),
// and changes every file or none. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, and whether it ends with one (SPEC section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: { from: string; to: string }[] = [];
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
  /** Remember a move of a file that existed before the patch, for the `R` output line. */
  noteMove(from: string, to: string): void {
    if (this.original(from) === null) return;
    const prev = this.moves.find((m) => m.to === from);
    const origin = prev ? prev.from : from;
    this.moves = this.moves.filter((m) => m.to !== from);
    if (origin !== to) this.moves = [...this.moves, { from: origin, to }];
  }
}

type Edit = (tree: Tree) => void;

/** One line of N: a context line remembers its index in O, a new line does not. */
interface NLine {
  text: string;
  oIndex: number | null;
  bs: boolean;
}

interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  bs: boolean;
}

/** O (context + old lines) and N (context + new lines) of a hunk or chunk. */
interface ChunkData {
  o: string[];
  n: NLine[];
  noNl: boolean;
}

function buildChunk(entries: BodyEntry[]): ChunkData {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, oIndex: o.length - 1, bs: e.bs });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else {
      n.push({ text: e.text, oIndex: null, bs: e.bs });
    }
  }
  let noNl = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'ctx' || e.kind === 'new') {
      noNl = e.bs;
      break;
    }
  }
  return { o, n, noNl };
}

/** A hunk's or chunk's raw body lines, trailing empty lines removed, as entries. */
function entriesFromRaw(raw: string[]): BodyEntry[] {
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const entries: BodyEntry[] = [];
  for (const l of raw) {
    if (l === '') {
      entries.push({ kind: 'ctx', text: '', bs: false });
      continue;
    }
    const c = l[0];
    if (c === ' ') entries.push({ kind: 'ctx', text: l.slice(1), bs: false });
    else if (c === '-') entries.push({ kind: 'old', text: l.slice(1), bs: false });
    else if (c === '+') entries.push({ kind: 'new', text: l.slice(1), bs: false });
    else if (c === '\\' && entries.length > 0) entries[entries.length - 1]!.bs = true;
  }
  return entries;
}

// ---- matching (SPEC section 5) ----

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const want = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with its occurrences. */
function findOcc(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  eof: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from).filter((p) => !eof || p + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

function reindent(line: string, f: string, p: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** N with context lines taken from the file's own matched lines (SPEC section 5). */
function buildN(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(fileLines[at]!);
    p = leadingWs(o[0]!);
  }
  for (const e of n) {
    if (e.oIndex !== null) out.push(fileLines[at + e.oIndex]!);
    else if (tier === 2) out.push(reindent(e.text, f, p));
    else out.push(e.text);
  }
  return out;
}

/** Apply one hunk or chunk (non-empty O) to a file's lines at position `at`. */
function spliceChunk(fs: FileState, at: number, c: ChunkData, tier: number): void {
  const repl = buildN(fs.lines, at, c.o, c.n, tier);
  fs.lines.splice(at, c.o.length, ...repl);
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC section 6) ----

interface Hunk {
  a: number;
  chunk: ChunkData;
}

interface USection {
  oldP: string | null;
  newP: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` or `+++ `, or null for /dev/null. */
function patchPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function bodyKind(line: string): 'ctx' | 'old' | 'new' | 'bslash' | 'empty' | null {
  if (line === '') return 'empty';
  const c = line[0];
  if (c === ' ') return 'ctx';
  if (c === '-') return 'old';
  if (c === '+') return 'new';
  if (c === '\\') return 'bslash';
  return null;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let pairSeen = false;
  let raw: string[] | null = null;
  let curA = 0;

  const flushHunk = (): void => {
    if (raw !== null && cur !== null) {
      cur.hunks.push({ a: curA, chunk: buildChunk(entriesFromRaw(raw)) });
      raw = null;
    }
  };
  const startSection = (oldP: string | null, newP: string | null): void => {
    flushHunk();
    cur = { oldP, newP, create: false, del: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    pairSeen = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const nextPlusPlus = (lines[i + 1] ?? '').startsWith('+++ ');
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && nextPlusPlus) {
        startSection(null, null);
        cur!.oldP = patchPath(line);
        cur!.newP = patchPath(lines[i + 1]!);
        pairSeen = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        flushHunk();
        curA = parseInt(m[1]!, 10);
        raw = [];
        inHeader = false;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (nextPlusPlus) {
          cur.oldP = patchPath(line);
          cur.newP = patchPath(lines[i + 1]!);
          pairSeen = true;
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (!pairSeen) cur.oldP = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!pairSeen) cur.newP = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        continue;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flushHunk();
      curA = parseInt(m[1]!, 10);
      raw = [];
      continue;
    }
    if (line.startsWith('--- ') && nextPlusPlus) {
      startSection(null, null);
      cur!.oldP = patchPath(line);
      cur!.newP = patchPath(lines[i + 1]!);
      pairSeen = true;
      i++;
      continue;
    }
    if (raw !== null && bodyKind(line) !== null) {
      raw.push(line);
      continue;
    }
    flushHunk();
  }
  flushHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file's lines (SPEC section 6). */
function applyHunks(fs: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const c = h.chunk;
    if (c.o.length > 0) {
      const found = findOcc(fs.lines, c.o, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = found.occ[0]!;
      let best = Math.abs(at - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          at = p;
        }
      }
      const runsToEnd = at + c.o.length === fs.lines.length;
      spliceChunk(fs, at, c, found.tier);
      if (runsToEnd) fs.final = !c.noNl;
      d += c.n.length - c.o.length;
    } else {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > fs.lines.length) at = fs.lines.length;
      const atEnd = at === fs.lines.length;
      fs.lines.splice(at, 0, ...c.n.map((e) => e.text));
      if (atEnd) fs.final = !c.noNl;
      d += c.n.length;
    }
  }
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldP;
    const newP = s.newP;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null || s.create) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      let lastPlusBs = false;
      for (const h of s.hunks) {
        for (const e of h.chunk.n) {
          if (e.oIndex === null) {
            out.push(e.text);
            lastPlusBs = e.bs;
          }
        }
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (newP === null || s.del) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const fs = parseFile(text);
      applyHunks(fs, s.hunks, strict, oldP);
      tree.now.set(newP, renderFile(fs));
      tree.now.set(oldP, null);
      tree.noteMove(oldP, newP);
      return;
    }
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    const fs = parseFile(text);
    applyHunks(fs, s.hunks, strict, oldP);
    tree.now.set(oldP, renderFile(fs));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const fs = parseFile(text);
    const found = findOcc(fs.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, oIndex: null, bs: false }));
    spliceChunk(fs, at, { o: oldLines, n, noNl: false }, found.tier);
    tree.now.set(path, renderFile(fs));
  };
}

// ---- V4A patches (SPEC section 8) ----

const isV4aSection = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

interface VChunk {
  anchor: string | null;
  eof: boolean;
  chunk: ChunkData;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (isV4aSection(line)) {
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : 'upd';
      const hdrLen = kind === 'add' ? '*** Add File: '.length : kind === 'del' ? '*** Delete File: '.length : '*** Update File: '.length;
      const path = line.slice(hdrLen).trim();
      const hdrLine = i + 1;
      i++;
      const raw: { t: string; n: number }[] = [];
      while (i < last && !isV4aSection(lines[i]!)) {
        raw.push({ t: lines[i]!, n: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
      if (kind === 'add') {
        const fileLines: string[] = [];
        for (const r of raw) {
          if (r.t.startsWith('+')) fileLines.push(r.t.slice(1));
          else if (r.t === '') fileLines.push('');
          else throw new Exit2(`error: parse ${r.n}`);
        }
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
        });
      } else if (kind === 'del') {
        if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.n}`);
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        });
      } else {
        edits.push(v4aUpdateEdit(path, raw, hdrLine, strict));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aUpdateEdit(path: string, raw: { t: string; n: number }[], hdrLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (raw.length > 0 && raw[0]!.t.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.t.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; entries: BodyEntry[] } | null = null;
  const pushChunk = (): void => {
    if (cur !== null) {
      chunks.push({ anchor: cur.anchor, eof: cur.eof, chunk: buildChunk(cur.entries) });
      cur = null;
    }
  };
  for (; k < raw.length; k++) {
    const { t, n } = raw[k]!;
    if (t.startsWith('@@')) {
      pushChunk();
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, entries: [] };
      continue;
    }
    if (t === '*** End of File') {
      if (cur === null) cur = { anchor: null, eof: false, entries: [] };
      cur.eof = true;
      pushChunk();
      continue;
    }
    if (cur === null) {
      if (chunks.length === 0) cur = { anchor: null, eof: false, entries: [] };
      else throw new Exit2(`error: parse ${n}`);
    }
    if (t === '') {
      cur.entries.push({ kind: 'ctx', text: '', bs: false });
      continue;
    }
    const c = t[0]!;
    if (c === ' ') cur.entries.push({ kind: 'ctx', text: t.slice(1), bs: false });
    else if (c === '-') cur.entries.push({ kind: 'old', text: t.slice(1), bs: false });
    else if (c === '+') cur.entries.push({ kind: 'new', text: t.slice(1), bs: false });
    else throw new Exit2(`error: parse ${n}`);
  }
  pushChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${hdrLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fs = parseFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(fs.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const c = ch.chunk;
      if (c.o.length > 0) {
        const found = findOcc(fs.lines, c.o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.occ[0]!;
        spliceChunk(fs, at, c, found.tier);
        cursor = at + c.n.length;
      } else {
        const at = ch.eof ? fs.lines.length : cursor;
        fs.lines.splice(at, 0, ...c.n.map((e) => e.text));
        cursor = at + c.n.length;
      }
    }
    const out = renderFile(fs);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.noteMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---- running the CLI (SPEC sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const rMoves = tree.moves.filter((m) => {
    const wasFrom = tree.original(m.from);
    const nowFrom = tree.get(m.from);
    const wasTo = tree.original(m.to);
    const nowTo = tree.get(m.to);
    return wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null;
  });
  const rFroms = new Set(rMoves.map((m) => m.from));
  const rTos = new Set(rMoves.map((m) => m.to));
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rFroms.has(p) || rTos.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of rMoves) rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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

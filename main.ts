// mend: one patch tool for every AI edit format.
//
// Node 22, standard library only. Implements SPEC.md in full: unified diffs,
// SEARCH/REPLACE blocks, V4A patches and JSON edits, three-tier line
// matching, and all-or-nothing writes. The working directory is the root of
// a tree of text files; a patch comes from a file or standard input.
//
// Exit codes: 0 the tree is written, 1 some edit failed (nothing written),
// 2 usage, unreadable patch, undetected format or parse error.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { runTrial } from './runner.ts';

type Brk = '\n' | '\r\n';

/** One file of the tree: its line break, its lines, and whether it ends with a break. */
interface FileData {
  brk: Brk;
  lines: string[];
  endBreak: boolean;
}

/** A failure of one edit: the code and the path the failure concerns. */
interface EditFailure {
  code: string;
  path: string;
}

/** What one edit did: a failure, or a move it made (for the R output line). */
interface RunResult {
  failure: EditFailure | null;
  move: { from: string; to: string } | null;
}

/** One edit of the patch, applied in order to the working tree. */
interface Edit {
  run(tree: Tree): RunResult;
}

type Tree = Map<string, FileData>;

/** True when the CLI was given --strict: only tier 0 matching is tried. */
let strictMode = false;

function fail(code: string, path: string): RunResult {
  return { failure: { code, path }, move: null };
}

function ok(move: { from: string; to: string } | null = null): RunResult {
  return { failure: null, move };
}

/** Split a file's text at its own line break (section 3 of SPEC.md). */
function parseFile(text: string): FileData {
  let brk: Brk = '\n';
  const firstLf = text.indexOf('\n');
  if (firstLf > 0 && text[firstLf - 1] === '\r') brk = '\r\n';
  if (text === '') return { brk, lines: [], endBreak: false };
  const parts = text.split(brk);
  let endBreak = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    endBreak = true;
  }
  return { brk, lines: parts, endBreak };
}

/** Join a file's lines back with its own break and final break. */
function renderFile(f: FileData): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.endBreak ? f.brk : '');
}

/** Split a patch's text at \n, each line with one trailing \r removed. */
function patchLines(text: string): string[] {
  const raw = text.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash,
 * and none of its segments is empty, . or .. (section 3 of SPEC.md). */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** One line normalised for a matching tier (section 5 of SPEC.md). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Positions where needle occurs in hay at one tier, at or after `from`. */
function findOccurrences(needle: string[], hay: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = needle.length;
  if (n === 0) return out;
  const nn = needle.map((l) => normLine(l, tier));
  for (let i = from; i + n <= hay.length; i++) {
    let good = true;
    for (let j = 0; j < n; j++) {
      if (normLine(hay[i + j], tier) !== nn[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/** The first tier at which needle occurs in hay at or after `from`, or -1. */
function firstTierWith(needle: string[], hay: string[], from: number): number {
  const top = strictMode ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    if (findOccurrences(needle, hay, t, from).length > 0) return t;
  }
  return -1;
}

/** One line of N: its text, whether it is a context line, and its index in O. */
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** Build the lines that replace a match: context lines are written as the
 * file's own matched lines, and at tier 2 every other line is re-indented
 * from the old lines' leading whitespace to the file's (section 5). */
function buildReplacement(nLines: NLine[], fileLines: string[], pos: number, tier: number, oLines: string[]): string[] {
  const out: string[] = [];
  for (const nl of nLines) {
    if (nl.ctx) {
      out.push(fileLines[pos + nl.oIndex]);
    } else if (tier === 2 && oLines.length > 0) {
      const f = leadingWs(fileLines[pos]);
      const p = leadingWs(oLines[0]);
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** One body line of a hunk or chunk: context, old, new, or a backslash line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** Split a hunk or chunk body into its old lines O and its new lines N. */
function splitON(body: BodyLine[]): { o: { text: string }[]; n: NLine[] } {
  const o: { text: string }[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const oi = o.length;
      o.push({ text: b.text });
      n.push({ text: b.text, ctx: true, oIndex: oi });
    } else if (b.kind === 'old') {
      o.push({ text: b.text });
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

/** Whether a backslash line immediately follows the body's last context
 * or new line: that is what decides the result's final line break. */
function hasBsAfterLastCtxOrNew(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].kind === 'ctx' || body[i].kind === 'new') {
      return i + 1 < body.length && body[i + 1].kind === 'bs';
    }
  }
  return false;
}

/** Read every regular file under dir into a tree of relative paths. */
function loadTree(dir: string): Tree {
  const tree: Tree = new Map();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const rel = relative(dir, p).split(sep).join('/');
        tree.set(rel, parseFile(readFileSync(p, 'utf8')));
      }
    }
  };
  walk(dir);
  return tree;
}

/** Compare two paths in UTF-8 byte order. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The change lines between the tree before the patch and after it: A, D, M
 * lines and R lines for moves, in byte order of the paths (section 2). */
function diffTrees(initial: Tree, final: Tree, moves: { from: string; to: string }[]): string[] {
  const out: { key: string; line: string }[] = [];
  const suppressedD = new Set<string>();
  const suppressedA = new Set<string>();
  for (const m of moves) {
    if (initial.has(m.from) && !final.has(m.from) && !initial.has(m.to) && final.has(m.to)) {
      out.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      suppressedD.add(m.from);
      suppressedA.add(m.to);
    }
  }
  for (const [p, f] of initial) {
    if (suppressedD.has(p)) continue;
    if (!final.has(p)) {
      out.push({ key: p, line: `D ${p}` });
    } else {
      const g = final.get(p) as FileData;
      if (renderFile(f) !== renderFile(g)) out.push({ key: p, line: `M ${p}` });
    }
  }
  for (const [p] of final) {
    if (suppressedA.has(p)) continue;
    if (!initial.has(p)) out.push({ key: p, line: `A ${p}` });
  }
  out.sort((a, b) => byteCompare(a.key, b.key));
  return out.map((e) => e.line);
}

/** Write the final tree over the initial one: changed and added files are
 * written, files that are gone are deleted. */
function writeTree(initial: Tree, final: Tree): void {
  const cwd = process.cwd();
  for (const [p, f] of final) {
    const g = initial.get(p);
    if (g === undefined || renderFile(g) !== renderFile(f)) {
      const full = join(cwd, ...p.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, renderFile(f), 'utf8');
    }
  }
  for (const [p] of initial) {
    if (!final.has(p)) rmSync(join(cwd, ...p.split('/')), { force: true });
  }
}

/** The command line (section 1 of SPEC.md). */
interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Options | null {
  let format = 'auto';
  let formatSeen = false;
  let check = false;
  let checkSeen = false;
  let strict = false;
  let strictSeen = false;
  let patch: string | null = null;
  let noMoreOpts = false;
  for (const arg of argv) {
    if (!noMoreOpts && arg === '--') {
      noMoreOpts = true;
      continue;
    }
    if (!noMoreOpts && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (checkSeen) return null;
        checkSeen = true;
        check = true;
      } else if (arg === '--strict') {
        if (strictSeen) return null;
        strictSeen = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (formatSeen) return null;
        formatSeen = true;
        const v = arg.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      if (patch !== null) return null;
      patch = arg;
    }
  }
  return { format, check, strict, patch };
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6 of SPEC.md)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path of a --- or +++ header line: text after the four characters, up
 * to the first tab, surrounding spaces removed; /dev/null means no file and
 * a leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab !== -1) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines: string[]): { sections: UniSection[]; error: number | null } {
  const sections: UniSection[] = [];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  let cur: UniSection | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let pairSeen = false;
  let renFrom: string | null = null;
  let renTo: string | null = null;
  let diffA: string | null = null;
  let diffB: string | null = null;
  let isCreate = false;
  let isDelete = false;
  let state: 'outside' | 'header' | 'body' | 'between' = 'outside';
  let hunk: Hunk | null = null;

  function finishSection(): void {
    if (cur === null) return;
    cur.oldPath = pairOld !== null ? pairOld : renFrom !== null ? renFrom : diffA;
    cur.newPath = pairNew !== null ? pairNew : renTo !== null ? renTo : diffB;
    cur.isCreate = isCreate;
    cur.isDelete = isDelete;
    sections.push(cur);
    cur = null;
  }

  function startSection(a: string | null, b: string | null): void {
    cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
    pairOld = null;
    pairNew = null;
    pairSeen = false;
    renFrom = null;
    renTo = null;
    diffA = a;
    diffB = b;
    isCreate = false;
    isDelete = false;
  }

  function endBody(): void {
    if (hunk !== null) {
      while (hunk.body.length > 0) {
        const lastBody = hunk.body[hunk.body.length - 1];
        if (lastBody.kind === 'ctx' && lastBody.text === '') hunk.body.pop();
        else break;
      }
      if (cur !== null) cur.hunks.push(hunk);
      hunk = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    if (state === 'outside') {
      if (line.startsWith('diff --git ')) {
        const m = diffRe.exec(line);
        if (m === null) return { sections, error: i + 1 };
        startSection(m[1], m[2]);
        state = 'header';
      } else if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
        startSection(null, null);
        pairOld = headerPath(line);
        pairNew = headerPath(next);
        pairSeen = true;
        i++;
        state = 'header';
      } else if (line.startsWith('@@')) {
        return { sections, error: i + 1 };
      }
    } else if (state === 'header') {
      if (line.startsWith('@@')) {
        const m = hunkRe.exec(line);
        if (m === null) return { sections, error: i + 1 };
        hunk = { a: parseInt(m[1], 10), body: [] };
        state = 'body';
      } else if (line.startsWith('diff --git ')) {
        const m = diffRe.exec(line);
        if (m === null) return { sections, error: i + 1 };
        finishSection();
        startSection(m[1], m[2]);
        state = 'header';
      } else if (line.startsWith('--- ')) {
        if (next !== null && next.startsWith('+++ ')) {
          if (!pairSeen) {
            pairOld = headerPath(line);
            pairNew = headerPath(next);
            pairSeen = true;
            i++;
          } else {
            finishSection();
            startSection(null, null);
            pairOld = headerPath(line);
            pairNew = headerPath(next);
            pairSeen = true;
            i++;
          }
          state = 'header';
        } else {
          return { sections, error: i + 2 };
        }
      } else if (line.startsWith('+++ ')) {
        if (pairNew === null) pairNew = headerPath(line);
      } else if (line.startsWith('rename from ')) {
        if (renFrom === null) renFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (renTo === null) renTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        isDelete = true;
      }
    } else if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        const m = diffRe.exec(line);
        if (m === null) return { sections, error: i + 1 };
        endBody();
        finishSection();
        startSection(m[1], m[2]);
        state = 'header';
      } else if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
        endBody();
        finishSection();
        startSection(null, null);
        pairOld = headerPath(line);
        pairNew = headerPath(next);
        pairSeen = true;
        i++;
        state = 'header';
      } else if (line.startsWith('@@')) {
        const m = hunkRe.exec(line);
        if (m === null) return { sections, error: i + 1 };
        endBody();
        hunk = { a: parseInt(m[1], 10), body: [] };
        state = 'body';
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (hunk !== null) {
          if (line === '') hunk.body.push({ kind: 'ctx', text: '' });
          else if (line[0] === ' ') hunk.body.push({ kind: 'ctx', text: line.slice(1) });
          else if (line[0] === '-') hunk.body.push({ kind: 'old', text: line.slice(1) });
          else if (line[0] === '+') hunk.body.push({ kind: 'new', text: line.slice(1) });
          else hunk.body.push({ kind: 'bs', text: line.slice(1) });
        }
      } else {
        endBody();
        state = 'between';
      }
    } else {
      if (line.startsWith('@@')) {
        const m = hunkRe.exec(line);
        if (m === null) return { sections, error: i + 1 };
        hunk = { a: parseInt(m[1], 10), body: [] };
        state = 'body';
      } else if (line.startsWith('diff --git ')) {
        const m = diffRe.exec(line);
        if (m === null) return { sections, error: i + 1 };
        finishSection();
        startSection(m[1], m[2]);
        state = 'header';
      } else if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
        finishSection();
        startSection(null, null);
        pairOld = headerPath(line);
        pairNew = headerPath(next);
        pairSeen = true;
        i++;
        state = 'header';
      }
    }
  }
  endBody();
  finishSection();
  return { sections, error: null };
}

/** Apply one section's hunks in order to a file's lines. */
function applyHunks(hunks: Hunk[], file: FileData): { failure: { code: string } | null; file: FileData } {
  let lines = [...file.lines];
  let brk = file.endBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitON(h.body);
    const noTrailing = hasBsAfterLastCtxOrNew(h.body);
    if (o.length === 0) {
      const oldLen = lines.length;
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > oldLen) pos = oldLen;
      const ins = n.map((e) => e.text);
      lines.splice(pos, 0, ...ins);
      if (pos === oldLen) brk = !noTrailing;
      d += ins.length;
    } else {
      const oldLen = lines.length;
      const oTexts = o.map((e) => e.text);
      const tier = firstTierWith(oTexts, lines, 0);
      if (tier < 0) return { failure: { code: 'no-match' }, file };
      const occs = findOccurrences(oTexts, lines, tier, 0);
      const target = h.a - 1 + d;
      let best = occs[0];
      let bestDist = Math.abs(occs[0] - target);
      for (const p of occs) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(n, lines, best, tier, oTexts);
      lines.splice(best, o.length, ...repl);
      if (best + o.length === oldLen) brk = !noTrailing;
      if (lines.length === 0) brk = false;
      d += repl.length - o.length;
    }
  }
  return { failure: null, file: { brk: file.brk, lines, endBreak: brk } };
}

function applyUnifiedSection(sec: UniSection, tree: Tree): RunResult {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  if (sec.isCreate || oldP === null) {
    if (newP === null) return ok();
    if (oldP !== null && !isSafePath(oldP)) return fail('unsafe', oldP);
    if (!isSafePath(newP)) return fail('unsafe', newP);
    if (tree.has(newP)) return fail('exists', newP);
    const lines: string[] = [];
    let lastPlusHasBs = false;
    let hasPlus = false;
    for (const h of sec.hunks) {
      for (let bi = 0; bi < h.body.length; bi++) {
        const b = h.body[bi];
        if (b.kind === 'new') {
          lines.push(b.text);
          hasPlus = true;
          lastPlusHasBs = bi + 1 < h.body.length && h.body[bi + 1].kind === 'bs';
        }
      }
    }
    tree.set(newP, { brk: '\n', lines, endBreak: hasPlus ? !lastPlusHasBs : false });
    return ok();
  }
  if (sec.isDelete || newP === null) {
    if (oldP === null) return ok();
    if (!isSafePath(oldP)) return fail('unsafe', oldP);
    if (newP !== null && !isSafePath(newP)) return fail('unsafe', newP);
    if (!tree.has(oldP)) return fail('missing', oldP);
    tree.delete(oldP);
    return ok();
  }
  const oldPath = oldP as string;
  const newPath = newP as string;
  if (oldPath !== newPath) {
    if (!isSafePath(oldPath)) return fail('unsafe', oldPath);
    if (!isSafePath(newPath)) return fail('unsafe', newPath);
    if (!tree.has(oldPath)) return fail('missing', oldPath);
    if (tree.has(newPath)) return fail('exists', newPath);
    const file = tree.get(oldPath) as FileData;
    const res = applyHunks(sec.hunks, file);
    if (res.failure !== null) return fail(res.failure.code, oldPath);
    tree.delete(oldPath);
    tree.set(newPath, res.file);
    return ok({ from: oldPath, to: newPath });
  }
  if (!isSafePath(oldPath)) return fail('unsafe', oldPath);
  if (!tree.has(oldPath)) return fail('missing', oldPath);
  const file = tree.get(oldPath) as FileData;
  const res = applyHunks(sec.hunks, file);
  if (res.failure !== null) return fail(res.failure.code, oldPath);
  tree.set(oldPath, res.file);
  return ok();
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7 of SPEC.md)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): { blocks: SRBlock[]; error: number | null } {
  const blocks: SRBlock[] = [];
  const isMarker = (l: string, m: string): boolean => l.replace(/[ \t]+$/, '') === m;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isMarker(lines[i], '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    const sIdx = i;
    let j = sIdx + 1;
    let foundEq = -1;
    while (j < lines.length) {
      if (isMarker(lines[j], '=======')) {
        foundEq = j;
        break;
      }
      if (isMarker(lines[j], '>>>>>>> REPLACE') || isMarker(lines[j], '<<<<<<< SEARCH')) break;
      j++;
    }
    if (foundEq === -1) return { blocks, error: sIdx + 1 };
    let k = foundEq + 1;
    let foundRep = -1;
    while (k < lines.length) {
      if (isMarker(lines[k], '>>>>>>> REPLACE')) {
        foundRep = k;
        break;
      }
      if (isMarker(lines[k], '<<<<<<< SEARCH')) break;
      k++;
    }
    if (foundRep === -1) return { blocks, error: sIdx + 1 };
    const oldLines = lines.slice(sIdx + 1, foundEq);
    const newLines = lines.slice(foundEq + 1, foundRep);
    let path: string | null = null;
    for (let p = sIdx - 1; p > prevEnd; p--) {
      const t = lines[p].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) return { blocks, error: sIdx + 1 };
      path = prevPath;
    }
    blocks.push({ path, oldLines, newLines });
    prevPath = path;
    prevEnd = foundRep;
    i = foundRep + 1;
  }
  return { blocks, error: null };
}

function applySRBlock(b: SRBlock, tree: Tree): RunResult {
  if (!isSafePath(b.path)) return fail('unsafe', b.path);
  if (b.oldLines.length === 0) {
    if (tree.has(b.path)) return fail('exists', b.path);
    const lines = [...b.newLines];
    tree.set(b.path, { brk: '\n', lines, endBreak: lines.length > 0 });
    return ok();
  }
  const file = tree.get(b.path);
  if (file === undefined) return fail('missing', b.path);
  const tier = firstTierWith(b.oldLines, file.lines, 0);
  if (tier < 0) return fail('no-match', b.path);
  const occs = findOccurrences(b.oldLines, file.lines, tier, 0);
  if (occs.length !== 1) return fail('ambiguous', b.path);
  const pos = occs[0];
  const nLines: NLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
  const repl = buildReplacement(nLines, file.lines, pos, tier, b.oldLines);
  const lines = [...file.lines];
  lines.splice(pos, b.oldLines.length, ...repl);
  tree.set(b.path, { brk: file.brk, lines, endBreak: file.endBreak });
  return ok();
}

// ---------------------------------------------------------------------------
// V4A patches (section 8 of SPEC.md)
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4AChunk[];
}

function parseV4A(lines: string[]): { sections: V4ASection[]; error: number | null } {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return { sections: [], error: 1 };
  if (lines[first].trim() !== '*** Begin Patch') return { sections: [], error: first + 1 };
  if (lines[last].trim() !== '*** End Patch') return { sections: [], error: lines.length + 1 };
  const sections: V4ASection[] = [];
  const headerKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const kind = headerKind(line);
    if (kind === null) return { sections, error: i + 1 };
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const rawStart = i + 1;
    let j = rawStart;
    while (j < last && headerKind(lines[j]) === null) j++;
    const raw = lines.slice(rawStart, j);
    while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k];
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else return { sections, error: rawStart + k + 1 };
      }
      sections.push({ kind: 'add', path, moveTo: null, lines: fileLines, chunks: [] });
    } else if (kind === 'delete') {
      if (raw.length > 0) return { sections, error: rawStart + 1 };
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (idx < raw.length && raw[idx].startsWith('*** Move to: ')) {
        moveTo = raw[idx].slice('*** Move to: '.length).trim();
        idx++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      for (; idx < raw.length; idx++) {
        const l = raw[idx];
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
        } else if (l === '*** End of File') {
          if (cur === null) return { sections, error: rawStart + idx + 1 };
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
            } else {
              return { sections, error: rawStart + idx + 1 };
            }
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
          else cur.body.push({ kind: 'new', text: l.slice(1) });
        } else {
          return { sections, error: rawStart + idx + 1 };
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) return { sections, error: i + 1 };
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks });
    }
    i = j;
  }
  if (sections.length === 0) return { sections, error: 1 };
  return { sections, error: null };
}

function applyV4ASection(sec: V4ASection, tree: Tree): RunResult {
  if (sec.kind === 'add') {
    if (!isSafePath(sec.path)) return fail('unsafe', sec.path);
    if (tree.has(sec.path)) return fail('exists', sec.path);
    const lines = [...sec.lines];
    tree.set(sec.path, { brk: '\n', lines, endBreak: lines.length > 0 });
    return ok();
  }
  if (sec.kind === 'delete') {
    if (!isSafePath(sec.path)) return fail('unsafe', sec.path);
    if (!tree.has(sec.path)) return fail('missing', sec.path);
    tree.delete(sec.path);
    return ok();
  }
  if (!isSafePath(sec.path)) return fail('unsafe', sec.path);
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return fail('unsafe', sec.moveTo);
  const file = tree.get(sec.path);
  if (file === undefined) return fail('missing', sec.path);
  if (sec.moveTo !== null && tree.has(sec.moveTo)) return fail('exists', sec.moveTo);
  let lines = [...file.lines];
  let cursor = 0;
  for (const ch of sec.chunks) {
    if (ch.anchor !== null) {
      let found = -1;
      const top = strictMode ? 0 : 2;
      for (let t = 0; t <= top && found === -1; t++) {
        for (let idx = cursor; idx < lines.length; idx++) {
          if (normLine(lines[idx], t) === normLine(ch.anchor as string, t)) {
            found = idx;
            break;
          }
        }
      }
      if (found === -1) return fail('no-match', sec.path);
      cursor = found + 1;
    }
    const { o, n } = splitON(ch.body);
    if (o.length === 0) {
      const pos = ch.eof ? lines.length : cursor;
      const ins = n.map((e) => e.text);
      lines.splice(pos, 0, ...ins);
      cursor = pos + ins.length;
    } else {
      const oTexts = o.map((e) => e.text);
      let tier = -1;
      let pos = -1;
      const top = strictMode ? 0 : 2;
      for (let t = 0; t <= top; t++) {
        const occs = findOccurrences(oTexts, lines, t, cursor);
        const good = ch.eof ? occs.filter((p) => p + o.length === lines.length) : occs;
        if (good.length > 0) {
          tier = t;
          pos = good[0];
          break;
        }
      }
      if (tier < 0) return fail('no-match', sec.path);
      const repl = buildReplacement(n, lines, pos, tier, oTexts);
      lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }
  }
  const newFile: FileData = { brk: file.brk, lines, endBreak: file.endBreak };
  if (sec.moveTo !== null) {
    tree.delete(sec.path);
    tree.set(sec.moveTo, newFile);
    return ok({ from: sec.path, to: sec.moveTo });
  }
  tree.set(sec.path, newFile);
  return ok();
}

// ---------------------------------------------------------------------------
// JSON edits (section 9 of SPEC.md)
// ---------------------------------------------------------------------------

interface JsonEdit {
  command: 'create' | 'str_replace' | 'insert';
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
}

function validateJsonEdit(v: unknown): JsonEdit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const cmd = o.command;
  if (cmd === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, file_text: o.file_text };
  }
  if (cmd === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { command: 'str_replace', path: o.path, old_str: o.old_str, new_str: typeof o.new_str === 'string' ? o.new_str : '' };
  }
  if (cmd === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { command: 'insert', path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function parseJsonPatch(lines: string[], text: string): { edits: JsonEdit[]; error: number | null } {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return { edits: [], error: 1 };
  const firstChar = lines[firstIdx].trimStart()[0];
  if (firstChar === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      return { edits: [], error: firstIdx + 1 };
    }
    if (!Array.isArray(arr)) return { edits: [], error: firstIdx + 1 };
    const edits: JsonEdit[] = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (e === null) return { edits: [], error: firstIdx + 1 };
      edits.push(e);
    }
    if (edits.length === 0) return { edits: [], error: 1 };
    return { edits, error: null };
  }
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      return { edits: [], error: i + 1 };
    }
    const e = validateJsonEdit(obj);
    if (e === null) return { edits: [], error: i + 1 };
    edits.push(e);
  }
  if (edits.length === 0) return { edits: [], error: 1 };
  return { edits, error: null };
}

/** Count occurrences of needle in text, allowing overlaps. */
function countOccurrences(text: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const at = text.indexOf(needle, idx);
    if (at === -1) break;
    count++;
    idx = at + 1;
  }
  return count;
}

/** Split an insert's new_str the way a patch's lines are split. */
function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function applyJsonEdit(e: JsonEdit, tree: Tree): RunResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (e.command === 'create') {
    if (tree.has(e.path)) return fail('exists', e.path);
    tree.set(e.path, parseFile(e.file_text !== undefined ? e.file_text : ''));
    return ok();
  }
  const file = tree.get(e.path);
  if (file === undefined) return fail('missing', e.path);
  if (e.command === 'str_replace') {
    const oldStr = e.old_str !== undefined ? e.old_str : '';
    const newStr = e.new_str !== undefined ? e.new_str : '';
    if (file.brk === '\r\n') {
      const textN = renderFile(file).replace(/\r\n/g, '\n');
      const oldN = oldStr.replace(/\r\n/g, '\n');
      const newN = newStr.replace(/\r\n/g, '\n');
      const count = countOccurrences(textN, oldN);
      if (count === 0) return fail('no-match', e.path);
      if (count > 1) return fail('ambiguous', e.path);
      const replaced = textN.replace(oldN, () => newN);
      tree.set(e.path, parseFile(replaced.replace(/\n/g, '\r\n')));
      return ok();
    }
    const text = renderFile(file);
    const count = countOccurrences(text, oldStr);
    if (count === 0) return fail('no-match', e.path);
    if (count > 1) return fail('ambiguous', e.path);
    tree.set(e.path, parseFile(text.replace(oldStr, () => newStr)));
    return ok();
  }
  const insLines = splitNewStr(e.new_str !== undefined ? e.new_str : '');
  const pos = e.insert_line !== undefined ? e.insert_line : 0;
  if (pos < 0 || pos > file.lines.length) return fail('no-match', e.path);
  const lines = [...file.lines];
  lines.splice(pos, 0, ...insLines);
  tree.set(e.path, { brk: file.brk, lines, endBreak: file.endBreak });
  return ok();
}

// ---------------------------------------------------------------------------
// Format detection and the main flow (sections 2, 4 and 10 of SPEC.md)
// ---------------------------------------------------------------------------

/** Detect the patch format (section 4), or null when none holds. */
function detectFormat(lines: string[]): string | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank === -1) return null;
  const first = lines[firstNonBlank];
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const firstChar = first.trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function runCli(argv: string[]): { exit: number; stdout: string } {
  const opts = parseArgs(argv);
  if (opts === null) return { exit: 2, stdout: 'error: usage\n' };
  strictMode = opts.strict;
  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(opts.patch, 'utf8');
    } catch {
      return { exit: 2, stdout: 'error: no-patch\n' };
    }
  }
  const lines = patchLines(patchText);
  let format = opts.format;
  if (format === 'auto') {
    const det = detectFormat(lines);
    if (det === null) return { exit: 2, stdout: 'error: format\n' };
    format = det;
  }
  let edits: Edit[] = [];
  if (format === 'unified') {
    const r = parseUnified(lines);
    if (r.error !== null) return { exit: 2, stdout: `error: parse ${r.error}\n` };
    if (r.sections.length === 0) return { exit: 2, stdout: 'error: parse 1\n' };
    edits = r.sections.map((s) => ({ run: (t: Tree) => applyUnifiedSection(s, t) }));
  } else if (format === 'search-replace') {
    const r = parseSearchReplace(lines);
    if (r.error !== null) return { exit: 2, stdout: `error: parse ${r.error}\n` };
    if (r.blocks.length === 0) return { exit: 2, stdout: 'error: parse 1\n' };
    edits = r.blocks.map((b) => ({ run: (t: Tree) => applySRBlock(b, t) }));
  } else if (format === 'v4a') {
    const r = parseV4A(lines);
    if (r.error !== null) return { exit: 2, stdout: `error: parse ${r.error}\n` };
    if (r.sections.length === 0) return { exit: 2, stdout: 'error: parse 1\n' };
    edits = r.sections.map((s) => ({ run: (t: Tree) => applyV4ASection(s, t) }));
  } else if (format === 'json') {
    const r = parseJsonPatch(lines, patchText);
    if (r.error !== null) return { exit: 2, stdout: `error: parse ${r.error}\n` };
    if (r.edits.length === 0) return { exit: 2, stdout: 'error: parse 1\n' };
    edits = r.edits.map((e) => ({ run: (t: Tree) => applyJsonEdit(e, t) }));
  } else {
    return { exit: 2, stdout: 'error: usage\n' };
  }
  const initial = loadTree(process.cwd());
  const tree: Tree = new Map();
  for (const [p, f] of initial) tree.set(p, { brk: f.brk, lines: [...f.lines], endBreak: f.endBreak });
  const failures: EditFailure[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const e of edits) {
    const res = e.run(tree);
    if (res.failure !== null) failures.push(res.failure);
    else if (res.move !== null) moves.push(res.move);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    return { exit: 1, stdout: out };
  }
  const changes = diffTrees(initial, tree, moves);
  let out = '';
  for (const c of changes) out += c + '\n';
  out += changes.length === 1 ? 'ok: 1 file\n' : `ok: ${changes.length} files\n`;
  if (!opts.check) writeTree(initial, tree);
  return { exit: 0, stdout: out };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl) {
  await runTrial(envUrl);
} else {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exitCode = result.exit;
}

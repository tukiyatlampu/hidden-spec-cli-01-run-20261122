// mend: one patch tool for every AI edit format.
//
// Applies unified diffs (with wrong line numbers), SEARCH/REPLACE blocks,
// V4A patches and JSON tool calls to a tree of text files, exactly as
// SPEC.md (version 1) says. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse fault: the patch cannot be read in its format at line `line`. */
class ParseErr {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit failed: `code` on the file `path`. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed each, and the
 * empty piece after a final `\n` dropped. Patch line numbers count these. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 * `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A file's lines under SPEC.md section 3: its break is CRLF when its first
 * line feed follows a carriage return, LF otherwise; it ends with a break
 * when its text ends with that break; an empty file has no lines. */
interface FileText {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk; `moves` records successful move edits so the
 * output can print one `R old -> new` line for each. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

/** One line of a replacement: `ctx` lines are context (written as the
 * file's own matched line), the rest are added lines. `oIdx` is the line's
 * index inside O, for context lines. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Tier keys (SPEC.md section 5): tier 0 exact, tier 1 trailing spaces and
 * tabs removed, tier 2 leading and trailing spaces and tabs removed. */
function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimWs(s);
}

interface Match {
  tier: number;
  positions: number[];
}

/** The first tier at which `old` occurs in `lines` at or after `from`,
 * with every occurrence position at that tier. `strict` tries tier 0 only. */
function matchLines(lines: string[], old: string[], strict: boolean, from: number): Match | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + old.length <= lines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < old.length; k += 1) {
        if (tierKey(lines[i + k]!, tier) !== tierKey(old[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to `single` at the first tier
 * with one (both sides a single line). */
function matchSingle(lines: string[], single: string, strict: boolean, from: number): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (tierKey(lines[i]!, tier) === tierKey(single, tier)) return { tier, pos: i };
    }
  }
  return null;
}

/** Re-indent one non-context line of N at tier 2: let F be the leading
 * spaces and tabs of the file's first matched line and P those of O's first
 * line; a line that is not empty and not only whitespace, and starts with P,
 * has that P replaced by F; any other line is written as it is. */
function reindent(line: string, tier: number, firstFile: string, firstOld: string): string {
  if (tier !== 2) return line;
  if (line === '' || trimWs(line) === '') return line;
  const f = leadWs(firstFile);
  const p = leadWs(firstOld);
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** Build the replacement lines for a matched O at `pos`: context lines are
 * the file's own matched lines, other lines are re-indented at tier 2. */
function buildNew(cur: string[], pos: number, old: string[], n: NewLine[], tier: number): string[] {
  const out: string[] = [];
  for (const item of n) {
    if (item.ctx) out.push(cur[pos + item.oIdx]!);
    else out.push(reindent(item.text, tier, cur[pos]!, old[0]!));
  }
  return out;
}

/** Replace `old.length` lines at `pos` of `cur` by the new lines. */
function spliceAt(cur: string[], pos: number, oldLen: number, added: string[]): string[] {
  return [...cur.slice(0, pos), ...added, ...cur.slice(pos + oldLen)];
}

/** Detect the patch format (SPEC.md section 4): the first of v4a, json,
 * search-replace, unified that holds, else null. */
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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safePath(p)) throw new EditFail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      // In a CRLF file the text and both strings are read with every
      // `\r\n` as `\n`, and the result is written back with `\r\n`.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
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
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new EditFail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

/** The JSON edits of a patch: one JSON array of edit objects, or JSON
 * Lines with one edit object a line and blank lines ignored. In array form
 * any fault is `error: parse <the line where the array starts>`; in JSON
 * Lines form a line that does not hold one valid edit object is
 * `error: parse <that line>`. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseErr(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseErr(first + 1);
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
    if (e === null) throw new ParseErr(i + 1);
    edits.push(e);
  });
  return edits;
}

/** A unified-diff hunk body line: context, old, or new, with its index in
 * the hunk's body lines (for the `\` rule). */
interface HunkItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  bodyIdx: number;
}

interface Hunk {
  a: number;
  items: HunkItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
}

interface UniSection {
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string;
  renameNew?: string;
  diffOld?: string;
  diffNew?: string;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: the text after the four
 * characters, up to the first tab, with surrounding spaces removed;
 * `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parse a unified diff into its sections (SPEC.md section 6). */
function parseUnifiedSections(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  const blankSection = (): UniSection => ({ createFlag: false, deleteFlag: false, hunks: [] });
  let cur: UniSection | null = null;
  let state: 'outside' | 'header' | 'hunks' = 'outside';
  let i = 0;
  /** Start a section at a `diff --git` line; throws when malformed. */
  const startDiff = (line: string, at: number): void => {
    const m = DIFF_RE.exec(line);
    if (m === null) throw new ParseErr(at + 1);
    cur = blankSection();
    cur.diffOld = m[1]!;
    cur.diffNew = m[2]!;
    sections.push(cur);
    state = 'header';
  };
  /** Read one hunk at `at` (a line starting with `@@`); returns the line
   * after its body. */
  const readHunk = (at: number): number => {
    const m = HUNK_RE.exec(lines[at]!);
    if (m === null) throw new ParseErr(at + 1);
    const body: string[] = [];
    let j = at + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        body.push(l);
        j += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const items: HunkItem[] = [];
    body.forEach((bl, idx) => {
      if (bl === '') items.push({ kind: 'ctx', text: '', bodyIdx: idx });
      else if (bl[0] === ' ') items.push({ kind: 'ctx', text: bl.slice(1), bodyIdx: idx });
      else if (bl[0] === '-') items.push({ kind: 'old', text: bl.slice(1), bodyIdx: idx });
      else if (bl[0] === '+') items.push({ kind: 'new', text: bl.slice(1), bodyIdx: idx });
    });
    const followsBackslash = (idx: number): boolean => (body[idx + 1] ?? '').startsWith('\\');
    // A `\` line refers to the body line before it: the hunk ends without a
    // line break when one follows its last context or `+` line (and a
    // created file when one follows its last `+` line).
    const lastCtxNew = [...items].reverse().find((it) => it.kind === 'ctx' || it.kind === 'new');
    const lastNew = [...items].reverse().find((it) => it.kind === 'new');
    const noEol = lastCtxNew !== undefined && followsBackslash(lastCtxNew.bodyIdx);
    const noEolPlus = lastNew !== undefined && followsBackslash(lastNew.bodyIdx);
    cur!.hunks.push({ a: Number(m[1]), items, noEol, noEolPlus });
    state = 'hunks';
    return j;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      if (cur === null) throw new ParseErr(i + 1);
      i = readHunk(i);
      continue;
    }
    if (l.startsWith('diff --git ')) {
      startDiff(l, i);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (state === 'header' && cur !== null && cur.pairOld === undefined) {
          cur.pairOld = headerPath(l);
          cur.pairNew = headerPath(lines[i + 1]!);
        } else {
          cur = blankSection();
          cur.pairOld = headerPath(l);
          cur.pairNew = headerPath(lines[i + 1]!);
          sections.push(cur);
          state = 'header';
        }
        i += 2;
        continue;
      }
      if (state === 'header') throw new ParseErr(i + 2);
      i += 1;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.createFlag = true;
      else if (l.startsWith('deleted file mode')) cur.deleteFlag = true;
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line are ignored.
    }
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text. `d` is the drift so
 * far: the sum over hunks applied of (N's length minus O's length). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const old: string[] = [];
    const added: NewLine[] = [];
    let oIdx = 0;
    for (const it of h.items) {
      if (it.kind === 'ctx') {
        old.push(it.text);
        added.push({ text: it.text, ctx: true, oIdx });
        oIdx += 1;
      } else if (it.kind === 'old') {
        old.push(it.text);
        oIdx += 1;
      } else {
        added.push({ text: it.text, ctx: false, oIdx: -1 });
      }
    }
    if (old.length === 0) {
      const raw = h.a + d;
      const at = Math.min(Math.max(raw, 0), f.lines.length);
      const lines = added.map((n) => n.text);
      f.lines = spliceAt(f.lines, at, 0, lines);
      if (raw >= f.lines.length - lines.length) f.final = !h.noEol;
      d += added.length;
      continue;
    }
    const m = matchLines(f.lines, old, strict, 0);
    if (m === null) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let best = m.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of m.positions) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const touchesEnd = best + old.length === f.lines.length;
    f.lines = spliceAt(f.lines, best, old.length, buildNew(f.lines, best, old, added, m.tier));
    if (touchesEnd) f.final = !h.noEol;
    d += added.length - old.length;
  }
  return joinFile(f);
}

/** One unified-diff section as a single edit (SPEC.md section 6). */
function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.diffOld !== undefined ? s.diffOld : null;
  const newP = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.diffNew !== undefined ? s.diffNew : null;
  const isCreate = oldP === null || s.createFlag;
  const isDelete = !isCreate && (newP === null || s.deleteFlag);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      const target = newP ?? oldP;
      if (target === null) return;
      if (!safePath(target)) throw new EditFail('unsafe', target);
      if (tree.get(target) !== null) throw new EditFail('exists', target);
      const plus: string[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      if (plus.length === 0) {
        tree.now.set(target, '');
        return;
      }
      let lastPlus: Hunk | undefined;
      for (const h of s.hunks) if (h.items.some((it) => it.kind === 'new')) lastPlus = h;
      tree.now.set(target, plus.join('\n') + (lastPlus !== undefined && lastPlus.noEolPlus ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (!safePath(target)) throw new EditFail('unsafe', target);
      if (tree.get(target) === null) throw new EditFail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (isMove) {
      if (!safePath(oldP!)) throw new EditFail('unsafe', oldP!);
      if (!safePath(newP!)) throw new EditFail('unsafe', newP!);
      const cur = tree.get(oldP!);
      if (cur === null) throw new EditFail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new EditFail('exists', newP!);
      tree.move(oldP!, newP!, applyHunks(cur, s.hunks, strict, oldP!));
      return;
    }
    const target = oldP!;
    if (!safePath(target)) throw new EditFail('unsafe', target);
    const cur = tree.get(target);
    if (cur === null) throw new EditFail('missing', target);
    tree.now.set(target, applyHunks(cur, s.hunks, strict, target));
  };
}

/** The unified-diff edits of a patch. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnifiedSections(lines);
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
interface SrBlock {
  path: string;
  old: string[];
  next: string[];
  searchLine: number;
}

/** Parse SEARCH/REPLACE blocks. The path is the nearest line before the
 * `<<<<<<< SEARCH` line, and after the previous block's `>>>>>>> REPLACE`
 * line (or the start of the patch), that is not blank and does not start
 * with three backticks; with no such line the block takes the previous
 * block's path, and the first block with none is a parse fault at its
 * SEARCH line. A SEARCH line with no `=======` and then `>>>>>>> REPLACE`
 * after it is a parse fault at the SEARCH line. */
function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseErr(searchLine + 1);
    }
    let sep = -1;
    let k = i + 1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      k += 1;
    }
    if (sep < 0) throw new ParseErr(searchLine + 1);
    let end = -1;
    k = sep + 1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      k += 1;
    }
    if (end < 0) throw new ParseErr(searchLine + 1);
    blocks.push({ path, old: lines.slice(i + 1, sep), next: lines.slice(sep + 1, end), searchLine });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return blocks;
}

/** One SEARCH/REPLACE block as an edit. */
function srBlockEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(b.path)) throw new EditFail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new EditFail('exists', b.path);
      tree.now.set(b.path, b.next.length === 0 ? '' : `${b.next.join('\n')}\n`);
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new EditFail('missing', b.path);
    const f = splitFile(cur);
    const m = matchLines(f.lines, b.old, strict, 0);
    if (m === null) throw new EditFail('no-match', b.path);
    if (m.positions.length > 1) throw new EditFail('ambiguous', b.path);
    const pos = m.positions[0]!;
    const added = b.next.map((t) => reindent(t, m.tier, f.lines[pos]!, b.old[0]!));
    f.lines = spliceAt(f.lines, pos, b.old.length, added);
    tree.now.set(b.path, joinFile(f));
  };
}

/** The SEARCH/REPLACE edits of a patch. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  if (blocks.length === 0) throw new ParseErr(1);
  return blocks.map((b) => srBlockEdit(b, strict));
}

/** A V4A chunk: an optional anchor, body lines, and whether `*** End of
 * File` closed it (anchoring it to the end of the file). */
interface V4aChunk {
  anchor: string | null;
  items: HunkItem[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  newPath?: string;
  lines?: string[];
  chunks?: V4aChunk[];
}

/** Parse a V4A patch (SPEC.md section 8). */
function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const isBody = (x: string): boolean => x === '' || x[0] === ' ' || x[0] === '-' || x[0] === '+';
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const sectionAt = i;
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(l);
    if (m === null) throw new ParseErr(i + 1);
    const kind = m[1]!;
    const path = m[2]!.trim();
    i += 1;
    if (kind === 'Add File' || kind === 'Delete File') {
      const collected: Array<{ text: string; at: number }> = [];
      while (i < last) {
        const cl = lines[i]!;
        if (isSectionStart(cl) || cl.trim() === '*** End Patch') break;
        collected.push({ text: cl, at: i });
        i += 1;
      }
      while (collected.length > 0 && blank(collected[collected.length - 1]!.text)) collected.pop();
      if (kind === 'Add File') {
        const flines: string[] = [];
        for (const c of collected) {
          if (c.text === '') flines.push('');
          else if (c.text.startsWith('+')) flines.push(c.text.slice(1));
          else throw new ParseErr(c.at + 1);
        }
        sections.push({ kind: 'add', path, lines: flines });
      } else {
        for (const c of collected) if (!blank(c.text)) throw new ParseErr(c.at + 1);
        sections.push({ kind: 'delete', path });
      }
      continue;
    }
    // Update File.
    let newPath: string | undefined;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      newPath = lines[i]!.slice(13).trim();
      i += 1;
    }
    const chunks: V4aChunk[] = [];
    while (i < last) {
      const cl = lines[i]!;
      if (blank(cl)) {
        if (chunks.length === 0) {
          // A blank line starts the first chunk, as an empty context line.
          chunks.push({ anchor: null, items: [], eof: false });
        } else {
          // Blank lines between chunks are separators.
          i += 1;
          continue;
        }
      } else if (cl.startsWith('@@')) {
        const anchor = cl.slice(2).trim();
        chunks.push({ anchor: anchor === '' ? null : anchor, items: [], eof: false });
        i += 1;
      } else if (chunks.length === 0 && isBody(cl)) {
        chunks.push({ anchor: null, items: [], eof: false });
      } else if (isSectionStart(cl) || cl.trim() === '*** End Patch') {
        break;
      } else {
        throw new ParseErr(i + 1);
      }
      const ch = chunks[chunks.length - 1]!;
      while (i < last) {
        const bl = lines[i]!;
        if (bl === '') {
          ch.items.push({ kind: 'ctx', text: '', bodyIdx: ch.items.length });
          i += 1;
        } else if (bl[0] === ' ') {
          ch.items.push({ kind: 'ctx', text: bl.slice(1), bodyIdx: ch.items.length });
          i += 1;
        } else if (bl[0] === '-') {
          ch.items.push({ kind: 'old', text: bl.slice(1), bodyIdx: ch.items.length });
          i += 1;
        } else if (bl[0] === '+') {
          ch.items.push({ kind: 'new', text: bl.slice(1), bodyIdx: ch.items.length });
          i += 1;
        } else if (bl.trim() === '*** End of File') {
          ch.eof = true;
          i += 1;
          break;
        } else break;
      }
    }
    // Blank lines at the end of a section are not part of it: drop trailing
    // empty context lines from the last chunk, unless `*** End of File`
    // closed it.
    const lastCh = chunks[chunks.length - 1];
    if (lastCh !== undefined && !lastCh.eof) {
      while (lastCh.items.length > 0) {
        const t = lastCh.items[lastCh.items.length - 1]!;
        if (t.kind === 'ctx' && t.text === '') lastCh.items.pop();
        else break;
      }
    }
    if (chunks.length === 0 && newPath === undefined) throw new ParseErr(sectionAt + 1);
    sections.push({ kind: 'update', path, newPath, chunks });
  }
  if (sections.length === 0) throw new ParseErr(1);
  return sections;
}

/** Apply an Update File section's chunks in order, with a cursor that
 * starts at line 0. */
function applyV4aChunks(text: string, chunks: V4aChunk[], strict: boolean, path: string): string {
  let f = splitFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const a = matchSingle(f.lines, ch.anchor, strict, cursor);
      if (a === null) throw new EditFail('no-match', path);
      cursor = a.pos + 1;
    }
    const old: string[] = [];
    const added: NewLine[] = [];
    let oIdx = 0;
    for (const it of ch.items) {
      if (it.kind === 'ctx') {
        old.push(it.text);
        added.push({ text: it.text, ctx: true, oIdx });
        oIdx += 1;
      } else if (it.kind === 'old') {
        old.push(it.text);
        oIdx += 1;
      } else {
        added.push({ text: it.text, ctx: false, oIdx: -1 });
      }
    }
    if (old.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      f.lines = spliceAt(f.lines, at, 0, added.map((n) => n.text));
      cursor = at + added.length;
      continue;
    }
    const m = matchLines(f.lines, old, strict, cursor);
    if (m === null) throw new EditFail('no-match', path);
    let pos = m.positions[0]!;
    if (ch.eof) {
      const ok = m.positions.find((p) => p + old.length === f.lines.length);
      if (ok === undefined) throw new EditFail('no-match', path);
      pos = ok;
    }
    f.lines = spliceAt(f.lines, pos, old.length, buildNew(f.lines, pos, old, added, m.tier));
    cursor = pos + added.length;
  }
  return joinFile(f);
}

/** One V4A section as an edit. */
function v4aSectionEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(s.path)) throw new EditFail('unsafe', s.path);
    if (s.newPath !== undefined && !safePath(s.newPath)) throw new EditFail('unsafe', s.newPath);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new EditFail('exists', s.path);
      const ls = s.lines!;
      tree.now.set(s.path, ls.length === 0 ? '' : `${ls.join('\n')}\n`);
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new EditFail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new EditFail('missing', s.path);
    if (s.newPath !== undefined) {
      if (tree.get(s.newPath) !== null) throw new EditFail('exists', s.newPath);
      tree.move(s.path, s.newPath, applyV4aChunks(cur, s.chunks!, strict, s.path));
    } else {
      tree.now.set(s.path, applyV4aChunks(cur, s.chunks!, strict, s.path));
    }
  };
}

/** The V4A edits of a patch. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((s) => v4aSectionEdit(s, strict));
}

/** Run the CLI on `args`. Returns the exit code and the stdout lines. */
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
    if (edits.length === 0) throw new ParseErr(1);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // One line per changed path, in byte order of the paths (UTF-8). A move
  // that succeeded prints one `R <old> -> <new>` line, sorted by `<new>`,
  // replacing that pair's `D` and `A` lines.
  const rows: Array<{ key: string; text: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // Writes for a move pair's paths happen above (the new path is written,
  // the old one removed); a moved path that also changed is covered by its
  // `R` line, so write it here when it was not written above.
  if (!check) {
    for (const [oldP, newP] of tree.moves) {
      if (!movedOld.has(oldP) || !movedNew.has(newP)) continue;
      rmSync(oldP, { force: true });
      const content = tree.now.get(newP)!;
      mkdirSync(dirname(newP), { recursive: true });
      writeFileSync(newP, content);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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

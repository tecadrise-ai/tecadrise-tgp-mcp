// Shared helpers: errors, ids, locking, atomic writes, templating, glob.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export class TgpError extends Error {
  constructor(code, message, hint = '', httpStatus = 400) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.httpStatus = httpStatus;
  }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

export const nowIso = () => new Date().toISOString();
export const IS_WIN = process.platform === 'win32';
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function tgpHome() {
  return path.resolve(process.env.TGP_HOME || path.join(os.homedir(), '.tgp'));
}

// Optional machine settings in $TGP_HOME/config.json, for example {"port": 8788}.
// Environment variables win over the file.
export function tgpConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(tgpHome(), 'config.json'), 'utf8').replace(/^\uFEFF/, '')) || {}; }
  catch { return {}; }
}

export function defaultPort() {
  return Number(process.env.TGP_PORT || tgpConfig().port || 8787);
}

export function publicUrl() {
  return (process.env.TGP_PUBLIC_URL || tgpConfig().public_url || `http://localhost:${defaultPort()}`).replace(/\/+$/, '');
}

export function shortId(n = 6) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms) { Atomics.wait(sleepBuf, 0, 0, ms); }

// Cross-process mutex based on atomic mkdir. Stale locks (crashed holder) expire.
export function withLock(dir, fn, { timeoutMs = 20000, staleMs = 30000 } = {}) {
  const lp = path.join(dir, '.lock');
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lp);
      try { fs.writeFileSync(path.join(lp, 'owner'), String(process.pid)); } catch { /* ignore */ }
      break;
    } catch (e) {
      if (e.code === 'ENOENT') throw new TgpError('RUN_NOT_FOUND', `Run directory ${dir} does not exist.`, 'Check the run id with: tgp runs', 404);
      // Windows reports EPERM when the lock dir is being deleted by another process at this moment
      if (e.code !== 'EEXIST' && !(IS_WIN && TRANSIENT.has(e.code))) throw e;
      try {
        const st = fs.statSync(lp);
        if (Date.now() - st.mtimeMs > staleMs) { try { fs.rmSync(lp, { recursive: true, force: true }); } catch { /* another process got it */ } continue; }
      } catch { continue; }
      if (Date.now() - start > timeoutMs) {
        throw new TgpError('LOCK_TIMEOUT', 'Could not acquire the run lock in time.', 'Another process is busy with this run. Retry the same command in a few seconds.', 503);
      }
      sleepSync(10 + Math.floor(Math.random() * 15));
    }
  }
  try { return fn(); } finally { retryFs(() => fs.rmSync(lp, { recursive: true, force: true })); }
}

// Windows: rename over a file that another process has open (the server polling
// run.json, an antivirus scanner) fails briefly with EPERM, EACCES or EBUSY. Retry.
export function retryFs(fn, { tries = IS_WIN ? 60 : 3, delayMs = 15 } = {}) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (!TRANSIENT.has(e.code) || i >= tries - 1) throw e;
      sleepSync(delayMs + Math.floor(Math.random() * delayMs));
    }
  }
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${shortId(4)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { retryFs(() => fs.renameSync(tmp, file)); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
}

export function readJson(file) { return JSON.parse(retryFs(() => fs.readFileSync(file, 'utf8'))); }

// ---------- templating ----------
// Supported: {{run_id}} {{workdir}} {{<param>}} {{params.<p>}} {{tgp_home}} {{tmp}}
//            {{tasks.<id>.outputs.<k>}} {{tasks.<id>.result}}
const REF = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

export function lookupRef(expr, ctx) {
  if (expr === 'run_id') return ctx.run_id;
  if (expr === 'tgp_home') return ctx.tgp_home;
  if (expr === 'tmp') return ctx.tmp ?? os.tmpdir();
  const parts = expr.split('.');
  if (parts[0] === 'params' && parts.length === 2) return ctx.params?.[parts[1]];
  if (parts[0] === 'tasks' && parts.length >= 3) {
    const t = ctx.tasks?.[parts[1]];
    if (!t) return undefined;
    if (parts[2] === 'result' && parts.length === 3) return t.status === 'completed' ? (t.result ?? undefined) : undefined;
    if (parts[2] === 'outputs' && parts.length === 4) {
      if (t.status !== 'completed') return undefined;
      return t.outputs?.[parts[3]];
    }
    return undefined;
  }
  if (parts.length === 1 && ctx.params && Object.prototype.hasOwnProperty.call(ctx.params, expr)) return ctx.params[expr];
  return undefined;
}

export function subst(value, ctx, missing = []) {
  if (typeof value === 'string') {
    return value.replace(REF, (m, expr) => {
      const v = lookupRef(expr, ctx);
      if (v === undefined || v === null) { missing.push(m); return m; }
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map(v => subst(v, ctx, missing));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = subst(v, ctx, missing);
    return o;
  }
  return value;
}

export function refsIn(value, out = []) {
  if (typeof value === 'string') { for (const m of value.matchAll(REF)) out.push(m[1]); }
  else if (Array.isArray(value)) value.forEach(v => refsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => refsIn(v, out));
  return out;
}

// ---------- glob (no fs.globSync on Node 20) ----------
export function globToRegex(pattern) {
  let re = '';
  let inClass = false;
  let braceDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (inClass) { if (c === ']') inClass = false; re += c === '\\' ? '\\\\' : c; continue; }
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const atSegStart = i === 0 || pattern[i - 1] === '/';
        if (pattern[i + 2] === '/' && atSegStart) { re += '(?:[^/]*/)*'; i += 2; continue; }
        re += '.*'; i += 1; continue;
      }
      re += '[^/]*'; continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') { inClass = true; re += '['; if (pattern[i + 1] === '!') { re += '^'; i++; } continue; }
    if (c === '{') { braceDepth++; re += '(?:'; continue; }
    if (c === '}' && braceDepth > 0) { braceDepth--; re += ')'; continue; }
    if (c === ',' && braceDepth > 0) { re += '|'; continue; }
    re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

// Patterns always use forward slashes. On Windows backslashes in the pattern or cwd
// are treated as separators and matching is case insensitive. Returns native paths.
export function globSync(pattern, cwd = process.cwd(), { includeDirs = false, maxEntries = 200000 } = {}) {
  const toFwd = p => (IS_WIN ? p.replace(/\\/g, '/') : p);
  const abs = toFwd(path.resolve(cwd, IS_WIN ? pattern.replace(/\\/g, '/') : pattern));
  const segs = abs.split('/');
  let baseSegs = [];
  for (const s of segs) { if (/[*?[{]/.test(s)) break; baseSegs.push(s); }
  let base = baseSegs.join('/') || '/';
  if (/^[A-Za-z]:$/.test(base)) base += '/';
  let re = globToRegex(abs);
  if (IS_WIN) re = new RegExp(re.source, 'i');
  const native = p => (IS_WIN ? p.replace(/\//g, '\\') : p);
  const out = [];
  if (baseSegs.length === segs.length) {
    try { const st = fs.statSync(abs); if (st.isFile() || includeDirs) out.push(native(abs)); } catch { /* none */ }
    return out;
  }
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 40 || seen > maxEntries) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      seen++;
      const p = dir.endsWith('/') ? dir + e.name : dir + '/' + e.name;
      const isDir = e.isDirectory();
      if ((!isDir || includeDirs) && re.test(p)) out.push(native(p));
      if (isDir) walk(p, depth + 1);
    }
  };
  walk(base, 0);
  return out.sort();
}

export function truncate(s, n = 2000) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `... [${s.length - n} more chars]` : s;
}

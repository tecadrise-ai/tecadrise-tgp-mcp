// Gate evaluation. The engine runs these itself on every `done` report.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { subst, globSync, truncate, IS_WIN } from './util.js';

// Shells for command gates. "node" runs the text as a Node.js script (fed on stdin),
// which is the portable choice for templates that must work on Linux, macOS and Windows.
// "default" is bash on Linux and macOS and cmd.exe on Windows; TGP_SHELL overrides it.
export const SHELLS = ['default', 'node', 'bash', 'sh', 'cmd', 'powershell', 'pwsh'];

function gitBash() {
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (!base) continue;
    const p = path.join(base, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function resolveShell(name) {
  let sh = name || 'default';
  if (sh === 'default') sh = process.env.TGP_SHELL || (IS_WIN ? 'cmd' : 'bash');
  if (!SHELLS.includes(sh) || sh === 'default') throw new Error(`unknown shell "${sh}". Use one of: ${SHELLS.join(', ')}`);
  return sh;
}

// Returns [file, args, extraSpawnOptions]
function shellCommand(sh, run) {
  switch (sh) {
    case 'node': return [process.execPath, ['-'], { input: run }];
    case 'bash':
      // On Windows C:\Windows\System32\bash.exe is WSL, which would run in a different
      // filesystem. Prefer Git Bash, which understands Windows paths.
      return [IS_WIN ? (gitBash() || 'bash') : 'bash', ['-c', run], {}];
    case 'sh': return [IS_WIN ? (gitBash() || 'sh') : 'sh', ['-c', run], {}];
    case 'cmd': return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${run}"`], { windowsVerbatimArguments: true }];
    case 'powershell':
    case 'pwsh': {
      const exe = sh === 'pwsh' ? 'pwsh' : (IS_WIN ? 'powershell.exe' : 'pwsh');
      // -EncodedCommand avoids every quoting problem with nested quotes in run
      const enc = Buffer.from(`$ErrorActionPreference = 'Continue'\n${run}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`, 'utf16le').toString('base64');
      return [exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {}];
    }
    default: throw new Error(`unknown shell ${sh}`);
  }
}

const DEFAULT_HINTS = {
  file_exists: 'Create the file or directory at exactly this path (files need enough content), then report done again.',
  glob_count: 'Make sure the expected number of files match the pattern, then report done again.',
  json_has_keys: 'Write valid JSON containing every required key (and expected values), then report done again.',
  regex_in_file: 'Make the file contain text matching the pattern, then report done again.',
  command: 'Fix whatever the check command verifies, then report done again. The command output is in the gate detail.',
  media_duration: 'Produce a media file whose duration is inside the allowed range, then report done again.',
  result_matches: 'Your --result text must contain evidence matching the pattern. Report done again with a better --result.',
  manual: 'A human must approve this task on the canvas or with tgp approve.',
};

export function describeGate(g) {
  switch (g.type) {
    case 'file_exists': return `file_exists ${g.path}${g.min_bytes ? ` (at least ${g.min_bytes} bytes)` : ''}${g.kind && g.kind !== 'any' ? ` [${g.kind}]` : ''}`;
    case 'glob_count': {
      const c = g.eq !== undefined ? `exactly ${g.eq}` : [g.min !== undefined ? `>= ${g.min}` : '', g.max !== undefined ? `<= ${g.max}` : ''].filter(Boolean).join(' and ') || '>= 1';
      return `glob_count ${g.pattern} matches ${c}`;
    }
    case 'json_has_keys': return `json_has_keys ${g.path}${g.keys ? ` keys [${g.keys.join(', ')}]` : ''}${g.equals ? ` equals ${JSON.stringify(g.equals)}` : ''}`;
    case 'regex_in_file': return `regex_in_file ${g.path} matches /${g.pattern}/${g.flags ?? ''}${g.min_matches > 1 ? ` at least ${g.min_matches} times` : ''}`;
    case 'command': return `command${g.shell && g.shell !== 'default' ? ` (${g.shell})` : ''} exits ${g.expect_exit ?? 0}: ${String(g.run).trim().split('\n').length > 1 ? String(g.run).trim().split('\n')[0] + ' ...' : String(g.run).trim()}`;
    case 'media_duration': return `media_duration ${g.path} between ${g.min_s ?? 0}s and ${g.max_s ?? 'any'}s`;
    case 'result_matches': return `result_matches /${g.pattern}/${g.flags ?? ''}`;
    case 'manual': return `manual approval by a human${g.prompt ? `: ${g.prompt}` : ''}`;
    default: return g.type;
  }
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const k of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

function looseEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' || typeof b === 'number') return String(a) === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

function countMatches(text, pattern, flags = '') {
  const f = flags.includes('g') ? flags : flags + 'g';
  return [...text.matchAll(new RegExp(pattern, f))].length;
}

// Evaluate one gate that has already been substituted. ctx: {workdir, result, logFile, env}
function evalGate(g, ctx) {
  const resolvePath = p => path.resolve(ctx.workdir || process.cwd(), p);
  switch (g.type) {
    case 'file_exists': {
      const p = resolvePath(g.path);
      let st;
      try { st = fs.statSync(p); } catch { return [false, `${p} does not exist`]; }
      const kind = g.kind ?? (g.min_bytes ? 'file' : 'any');
      if (kind === 'file' && !st.isFile()) return [false, `${p} exists but is not a regular file`];
      if (kind === 'dir' && !st.isDirectory()) return [false, `${p} exists but is not a directory`];
      if (g.min_bytes && st.size < g.min_bytes) return [false, `${p} has ${st.size} bytes, needs at least ${g.min_bytes}`];
      return [true, `${p} exists${st.isFile() ? ` (${st.size} bytes)` : ' (directory)'}`];
    }
    case 'glob_count': {
      const cwd = g.cwd ? resolvePath(g.cwd) : (ctx.workdir || process.cwd());
      const files = globSync(g.pattern, cwd, { includeDirs: !!g.include_dirs });
      const n = files.length;
      const okEq = g.eq === undefined || n === Number(g.eq);
      const min = g.min ?? (g.eq === undefined && g.max === undefined ? 1 : undefined);
      const okMin = min === undefined || n >= Number(min);
      const okMax = g.max === undefined || n <= Number(g.max);
      const sample = files.slice(0, 5).map(f => path.basename(f)).join(', ');
      return [okEq && okMin && okMax, `${n} file(s) match ${g.pattern}${sample ? ` (${sample}${n > 5 ? ', ...' : ''})` : ''}`];
    }
    case 'json_has_keys': {
      const p = resolvePath(g.path);
      let data;
      try { data = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
        return [false, e.code === 'ENOENT' ? `${p} does not exist` : `${p} is not valid JSON: ${e.message}`];
      }
      const missing = (g.keys ?? []).filter(k => !getPath(data, k).found);
      if (missing.length) return [false, `${p} is missing key(s): ${missing.join(', ')}`];
      const wrong = [];
      for (const [k, want] of Object.entries(g.equals ?? {})) {
        const got = getPath(data, k);
        if (!got.found) wrong.push(`${k} is missing`);
        else if (!looseEqual(got.value, want)) wrong.push(`${k} is ${JSON.stringify(got.value)}, expected ${JSON.stringify(want)}`);
      }
      if (wrong.length) return [false, `${p}: ${wrong.join('; ')}`];
      return [true, `${p} has all required keys${g.equals ? ' and values' : ''}`];
    }
    case 'regex_in_file': {
      const p = resolvePath(g.path);
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { return [false, `${p} does not exist or is unreadable`]; }
      // Windows editors and PowerShell write CRLF; normalize so ^...$ with flag m behaves the same everywhere
      text = text.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
      const n = countMatches(text, g.pattern, g.flags ?? '');
      const need = g.min_matches ?? 1;
      return [n >= need, `${p}: ${n} match(es) of /${g.pattern}/${g.flags ?? ''}, need ${need}`];
    }
    case 'result_matches': {
      const r = ctx.result ?? '';
      const ok = new RegExp(g.pattern, g.flags ?? '').test(r);
      return [ok, ok ? `result matches /${g.pattern}/` : `result "${truncate(r, 120)}" does not match /${g.pattern}/${g.flags ?? ''}`];
    }
    case 'command': {
      let cwd = g.cwd ? resolvePath(g.cwd) : ctx.workdir;
      if (!cwd || !fs.existsSync(cwd)) cwd = ctx.fallbackCwd || process.cwd();
      const timeoutMs = Math.round((g.timeout_s ?? 60) * 1000);
      const t0 = Date.now();
      const sh = resolveShell(g.shell);
      const [file, args, extra] = shellCommand(sh, g.run);
      const r = spawnSync(file, args, { cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...ctx.env }, windowsHide: true, ...extra });
      const out = `${r.stdout ?? ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim();
      const ms = Date.now() - t0;
      if (ctx.logFile) {
        try { fs.mkdirSync(path.dirname(ctx.logFile), { recursive: true }); fs.writeFileSync(ctx.logFile, `$ ${g.run}\n# shell: ${sh}\n# cwd: ${cwd}\n# exit: ${r.status} signal: ${r.signal ?? ''} ms: ${ms}\n${out}\n`); } catch { /* ignore */ }
      }
      const expect = g.expect_exit ?? 0;
      if (r.error && r.error.code === 'ETIMEDOUT') return [false, `command timed out after ${g.timeout_s ?? 60}s`, out];
      if (r.error) return [false, `command could not run: ${r.error.message}`, out];
      const ok = r.status === expect;
      return [ok, `exit ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}, expected ${expect}, ${ms} ms${out ? `. Output: ${truncate(out, 400)}` : ''}`, out];
    }
    case 'media_duration': {
      const p = resolvePath(g.path);
      if (!fs.existsSync(p)) return [false, `${p} does not exist`];
      const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', p], { encoding: 'utf8', timeout: 30000 });
      if (r.error) return [false, r.error.code === 'ENOENT' ? 'ffprobe is not installed or not on PATH (it ships with ffmpeg)' : `ffprobe could not run: ${r.error.message}`];
      const d = parseFloat(String(r.stdout).trim());
      if (!Number.isFinite(d)) return [false, `ffprobe could not read a duration from ${p}: ${truncate((r.stderr || r.stdout || '').trim(), 200)}`];
      const okMin = g.min_s === undefined || d >= g.min_s;
      const okMax = g.max_s === undefined || d <= g.max_s;
      return [okMin && okMax, `${p} duration ${d.toFixed(2)}s, allowed ${g.min_s ?? 0}s to ${g.max_s ?? 'any'}s`];
    }
    default:
      return [false, `unknown gate type ${g.type}`];
  }
}

// Evaluate all automatic gates of a task. Manual gates are reported as pending.
// Returns { passed, needs_manual, results: [...] }
export function evaluateGates(task, substCtx, runtime) {
  const results = [];
  let needsManual = false;
  task.gates.forEach((rawGate, i) => {
    const missing = [];
    const g = subst(rawGate, substCtx, missing);
    const base = { index: i, type: g.type, label: g.label || describeGate(g), hint: g.hint || DEFAULT_HINTS[g.type] };
    if (g.type === 'manual') { needsManual = true; results.push({ ...base, passed: null, detail: 'waiting for human approval' }); return; }
    if (missing.length) { results.push({ ...base, passed: false, detail: `unresolved reference(s): ${[...new Set(missing)].join(', ')}`, hint: 'A referenced output was not reported by an earlier task. Ask the human, the template may be wrong.' }); return; }
    let r;
    try {
      r = evalGate(g, { ...runtime, logFile: runtime.logDir ? path.join(runtime.logDir, `${task.task_id}.a${runtime.attempt}.g${i}.log`) : null });
    } catch (e) { r = [false, `gate error: ${e.message}`]; }
    const res = { ...base, passed: !!r[0], detail: r[1] };
    if (r[2] !== undefined) res.output = truncate(r[2], 2000);
    if (res.passed) delete res.hint;
    results.push(res);
  });
  const auto = results.filter(r => r.passed !== null);
  return { passed: auto.every(r => r.passed), needs_manual: needsManual, results };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from './helpers.js';
import { evaluateGates } from '../src/gates.js';

const W = tmpdir('tgp-gates-');
fs.writeFileSync(path.join(W, 'a.txt'), 'hello world\nsecond line\n');
fs.writeFileSync(path.join(W, 'empty.txt'), '');
fs.writeFileSync(path.join(W, 'd.json'), JSON.stringify({ run_id: 'r1', n: 55, nested: { k: 'v' } }));
fs.writeFileSync(path.join(W, 'bad.json'), '{nope');
fs.writeFileSync(path.join(W, 'bom.json'), '\uFEFF{\r\n  "run_id": "r1"\r\n}\r\n');
fs.mkdirSync(path.join(W, 'parts'));
for (const i of [1, 2, 3]) fs.writeFileSync(path.join(W, 'parts', `p${i}.txt`), 'x');
const LOGS = path.join(W, 'logs');

const ctx = { run_id: 'r1', params: { workdir: W }, tasks: { prev: { status: 'completed', outputs: { n: '55' }, result: 'ok' }, later: { status: 'pending', outputs: {} } } };
function check(gate, result = 'done') {
  const r = evaluateGates({ task_id: 't', gates: [gate] }, ctx, { workdir: W, result, logDir: LOGS, attempt: 1, env: {} });
  return r;
}
const pass = (g, res) => { const r = check(g, res); assert.equal(r.passed, true, JSON.stringify(r.results)); return r; };
const fail = (g, res) => { const r = check(g, res); assert.equal(r.passed, false, JSON.stringify(r.results)); assert.ok(r.results[0].hint, 'failed gate needs a hint'); assert.ok(r.results[0].detail); return r; };

test('file_exists', () => {
  pass({ type: 'file_exists', path: '{{workdir}}/a.txt', min_bytes: 5 });
  fail({ type: 'file_exists', path: '{{workdir}}/missing.txt' });
  fail({ type: 'file_exists', path: '{{workdir}}/empty.txt', min_bytes: 1 });
  pass({ type: 'file_exists', path: '{{workdir}}', kind: 'dir' });
  fail({ type: 'file_exists', path: '{{workdir}}/a.txt', kind: 'dir' });
});

test('glob_count', () => {
  pass({ type: 'glob_count', pattern: 'parts/p*.txt', cwd: '{{workdir}}', eq: 3 });
  pass({ type: 'glob_count', pattern: '{{workdir}}/**/*.txt', min: 4 });
  fail({ type: 'glob_count', pattern: 'parts/p*.txt', cwd: '{{workdir}}', eq: 4 });
  fail({ type: 'glob_count', pattern: 'parts/*.md', cwd: '{{workdir}}', min: 1 });
  fail({ type: 'glob_count', pattern: 'parts/p*.txt', cwd: '{{workdir}}', max: 2 });
});

test('json_has_keys', () => {
  pass({ type: 'json_has_keys', path: '{{workdir}}/d.json', keys: ['run_id', 'n', 'nested.k'], equals: { run_id: '{{run_id}}', n: '{{tasks.prev.outputs.n}}' } });
  fail({ type: 'json_has_keys', path: '{{workdir}}/d.json', keys: ['missing'] });
  fail({ type: 'json_has_keys', path: '{{workdir}}/d.json', equals: { n: 54 } });
  pass({ type: 'json_has_keys', path: '{{workdir}}/bom.json', keys: ['run_id'], equals: { run_id: '{{run_id}}' } });
  fail({ type: 'json_has_keys', path: '{{workdir}}/bad.json', keys: ['a'] });
  fail({ type: 'json_has_keys', path: '{{workdir}}/none.json', keys: ['a'] });
});

test('regex_in_file', () => {
  pass({ type: 'regex_in_file', path: '{{workdir}}/a.txt', pattern: '^second line$', flags: 'm' });
  pass({ type: 'regex_in_file', path: '{{workdir}}/a.txt', pattern: 'l', min_matches: 3 });
  fail({ type: 'regex_in_file', path: '{{workdir}}/a.txt', pattern: '^second line$' });
  fail({ type: 'regex_in_file', path: '{{workdir}}/missing.txt', pattern: 'x' });
});

test('command (shell: node, portable): exit code, timeout, output logged, cwd is workdir', () => {
  const r = pass({ type: 'command', shell: 'node', run: "console.log('out-' + process.env.TGP_X); process.exit(require('fs').existsSync('a.txt') ? 0 : 1)", timeout_s: 5 });
  assert.ok(fs.readdirSync(LOGS).some(f => f.startsWith('t.a1.g0')), 'command output log written');
  const f = fail({ type: 'command', shell: 'node', run: "console.error('boom'); process.exit(4)" });
  assert.match(f.results[0].output || f.results[0].detail, /boom/);
  const t = fail({ type: 'command', shell: 'node', run: 'setTimeout(() => {}, 5000)', timeout_s: 1 });
  assert.match(t.results[0].detail, /timed out|timeout/i);
  pass({ type: 'command', shell: 'node', run: 'process.exit(3)', expect_exit: 3 });
  pass({ type: 'command', shell: 'node', run: "const s = 'it\\'s \"quoted\" $HOME %PATH%';\nif (!s.includes('quoted')) process.exit(1)" });
});

const IS_WIN = process.platform === 'win32';
test(`command (default shell: ${IS_WIN ? 'cmd' : 'bash'})`, () => {
  if (IS_WIN) {
    pass({ type: 'command', run: 'echo out & if not exist a.txt exit /b 1', timeout_s: 10 });
    const f = fail({ type: 'command', run: 'echo boom 1>&2 & exit /b 4', timeout_s: 10 });
    assert.match(f.results[0].output || f.results[0].detail, /boom/);
    pass({ type: 'command', run: 'exit /b 3', expect_exit: 3, timeout_s: 10 });
  } else {
    pass({ type: 'command', run: 'echo out-$TGP_X; test -f a.txt', timeout_s: 5 });
    const f = fail({ type: 'command', run: 'echo boom >&2; exit 4' });
    assert.match(f.results[0].output || f.results[0].detail, /boom/);
    const t = fail({ type: 'command', run: 'sleep 5', timeout_s: 1 });
    assert.match(t.results[0].detail, /timed out|timeout/i);
    pass({ type: 'command', run: 'exit 3', expect_exit: 3 });
  }
});

const hasPwsh = spawnSync(IS_WIN ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
test('command (shell: powershell)', { skip: !hasPwsh && 'PowerShell not installed' }, () => {
  pass({ type: 'command', shell: 'powershell', run: 'if (-not (Test-Path a.txt)) { exit 1 }; Write-Output "it\'s ok"', timeout_s: 30 });
  pass({ type: 'command', shell: 'powershell', run: 'exit 3', expect_exit: 3, timeout_s: 30 });
});

test('unknown shell fails the gate with a clear message', () => {
  const r = fail({ type: 'command', shell: 'fish', run: 'true' });
  assert.match(r.results[0].detail, /unknown shell/);
});

test('glob_count with native and backslash paths', () => {
  pass({ type: 'glob_count', pattern: path.join(W, 'parts', 'p*.txt'), eq: 3 });
  if (IS_WIN) pass({ type: 'glob_count', pattern: 'parts\\p*.txt', cwd: '{{workdir}}', eq: 3 });
  pass({ type: 'glob_count', pattern: 'parts/{p1,p2}.txt', cwd: '{{workdir}}', eq: 2 });
});

test('regex_in_file treats CRLF like LF', () => {
  fs.writeFileSync(path.join(W, 'crlf.txt'), 'hello tgp\r\nline two\r\n');
  pass({ type: 'regex_in_file', path: '{{workdir}}/crlf.txt', pattern: '^hello tgp$', flags: 'm' });
  pass({ type: 'regex_in_file', path: '{{workdir}}/crlf.txt', pattern: '^line two$', flags: 'm' });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
function wav(file, seconds) {
  const rate = 8000, n = rate * seconds, buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40);
  buf.fill(128, 44);
  fs.writeFileSync(file, buf);
}
const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;
test('media_duration (ffprobe)', { skip: !hasFfprobe && 'ffprobe not installed' }, () => {
  wav(path.join(W, 'two.wav'), 2);
  pass({ type: 'media_duration', path: '{{workdir}}/two.wav', min_s: 1.5, max_s: 2.5 });
  fail({ type: 'media_duration', path: '{{workdir}}/two.wav', min_s: 3 });
  fail({ type: 'media_duration', path: '{{workdir}}/two.wav', max_s: 1 });
  fail({ type: 'media_duration', path: '{{workdir}}/a.txt', min_s: 1 });
});

test('result_matches', () => {
  pass({ type: 'result_matches', pattern: '\\b55\\b' }, 'the sum is 55');
  fail({ type: 'result_matches', pattern: '\\b55\\b' }, 'the sum is 555');
  pass({ type: 'result_matches', pattern: 'READY', flags: 'i' }, 'ready');
});

test('manual gate is pending, not passed or failed', () => {
  const r = evaluateGates({ task_id: 't', gates: [{ type: 'result_matches', pattern: 'x' }, { type: 'manual', prompt: 'p' }] }, ctx, { workdir: W, result: 'x', env: {} });
  assert.equal(r.passed, true);
  assert.equal(r.needs_manual, true);
  assert.equal(r.results[1].passed, null);
});

test('refs to tasks that are not completed are unresolved and fail the gate', () => {
  const r = fail({ type: 'result_matches', pattern: '{{tasks.later.outputs.n}}' }, 'anything');
  assert.match(r.results[0].detail, /unresolved/);
});

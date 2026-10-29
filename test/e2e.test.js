// End to end: drive workflows/dummy-12.yaml through the real CLI to done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from './helpers.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tgp.js');
const HOME = tmpdir('tgp-e2e-home-');
const env = { ...process.env, TGP_HOME: HOME };
delete env.TGP_TEMPLATES;
function tgp(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  let json; try { json = JSON.parse(r.stdout); } catch { throw new Error(`non JSON output (exit ${r.status}): ${r.stdout}\n${r.stderr}`); }
  return { code: r.status, json };
}

test('dummy-12 end to end through the CLI', () => {
  const s = tgp('start', 'dummy-12');
  assert.equal(s.code, 0);
  const R = s.json.run_id, W = path.join(os.tmpdir(), 'tgp-dummy', R);
  assert.deepEqual(s.json.tasks.map(t => t.task_id), ['make_workdir']);
  assert.ok(!JSON.stringify(s.json).includes('summary.json'), 'future step leaked');

  // premature done on a locked task: rejected
  const pre = tgp('done', R, 'write_summary', '--result', 'wrote summary.json');
  assert.equal(pre.code, 1);
  assert.equal(pre.json.state, 'rejected');
  assert.equal(pre.json.error.code, 'TASK_NOT_AVAILABLE');
  assert.deepEqual(pre.json.tasks.map(t => t.task_id), ['make_workdir']);

  // done before the work exists: gate fails, task stays open
  fs.rmSync(W, { recursive: true, force: true });
  const gf = tgp('done', R, 'make_workdir', '--result', 'created');
  assert.equal(gf.code, 3);
  assert.equal(gf.json.state, 'gate_failed');
  assert.equal(gf.json.tasks[0].task_id, 'make_workdir');

  const ok = (task, ...extra) => {
    const r = tgp('done', R, task, ...extra);
    assert.equal(r.code, 0, `${task}: ${JSON.stringify(r.json.report || r.json.error)}`);
    return r.json;
  };
  fs.mkdirSync(W, { recursive: true });
  ok('make_workdir', '--result', 'mkdir -p');
  fs.writeFileSync(`${W}/hello.txt`, 'hello tgp\n'); ok('write_hello', '--result', 'wrote');
  // a failing done in the middle as well
  fs.writeFileSync(`${W}/hello.txt`, 'hello tgp\nline 2\n');
  const gf2 = tgp('done', R, 'append_line', '--result', 'appended');
  assert.equal(gf2.json.state, 'gate_failed');
  assert.ok(gf2.json.report.gate_results[0].output !== undefined || gf2.json.report.gate_results[0].detail);
  // CRLF line endings (Windows editors, PowerShell) are accepted too
  fs.writeFileSync(`${W}/hello.txt`, 'hello tgp\r\nline two\r\n'); ok('append_line', '--result', 'appended');
  fs.writeFileSync(`${W}/nums.txt`, Array.from({ length: 10 }, (_, i) => i + 1).join('\n') + '\n'); ok('write_nums', '--result', 'seq');
  fs.writeFileSync(`${W}/sum.txt`, '55\n'); ok('write_sum', '--result', 'sum 55');
  const par = tgp('next', R).json;
  assert.deepEqual(par.tasks.map(t => t.task_id).sort(), ['count_words', 'make_upper']);
  fs.writeFileSync(`${W}/upper.txt`, 'HELLO TGP\nLINE TWO\n'); ok('make_upper', '--result', 'upper');
  fs.writeFileSync(`${W}/count.txt`, '4\n'); ok('count_words', '--result', '4 words', '--output', 'words=4');
  fs.mkdirSync(`${W}/parts`); for (const i of [1, 2, 3]) fs.writeFileSync(`${W}/parts/part${i}.txt`, 'p');
  ok('make_parts', '--result', 'parts');
  fs.writeFileSync(`${W}/meta.json`, JSON.stringify({ run_id: R, name: 'dummy-12', files: [] })); ok('write_meta', '--result', 'meta');
  const hr = ok('human_review', '--result', 'ready for review');
  assert.equal(hr.state, 'awaiting_approval');
  assert.equal(tgp('next', R).json.state, 'awaiting_approval');
  assert.equal(tgp('approve', R, 'human_review').code, 0);
  assert.deepEqual(tgp('next', R).json.tasks.map(t => t.task_id), ['write_report']);
  fs.writeFileSync(`${W}/report.md`, '# Report\nsum: 55\nwords: 4\n'); ok('write_report', '--result', 'report');
  fs.writeFileSync(`${W}/summary.json`, JSON.stringify({ run_id: R, sum: 55, words: 4, status: 'ok', files: fs.readdirSync(W) }));
  const fin = ok('write_summary', '--result', 'wrote summary.json', '--artifact', `${W}/summary.json`);
  assert.equal(fin.state, 'done');
  assert.equal(fin.progress.completed, 12);
  const st = tgp('status', R).json;
  assert.equal(st.state, 'done');
  fs.rmSync(W, { recursive: true, force: true });
});

test('CLI usage errors are structured', () => {
  const r = tgp('done');
  assert.equal(r.code, 2);
  assert.ok(r.json.error.code && r.json.error.message && r.json.error.hint);
  const v = tgp('validate', path.resolve(path.dirname(BIN), '..', 'workflows', 'dummy-12.yaml'));
  assert.equal(v.json.valid, true);
  assert.equal(v.json.template.tasks, 12);
});

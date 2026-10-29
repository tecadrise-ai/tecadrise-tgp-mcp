import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tpl, HOME } from './helpers.js';
import * as E from '../src/engine.js';
import * as N from '../src/notify.js';

tpl('notify1', `
id: notify1
title: Notify template
settings: { stop_on_fail: true, max_attempts: 2 }
stages:
  - tasks:
      - id: first
        title: First step
        gates: [{ type: result_matches, pattern: ok }]
  - tasks:
      - id: review
        title: Review step for {{run_id}}
        gates: [{ type: result_matches, pattern: ready }, { type: manual, prompt: look }]
`);

const sent = [];
const mock = t => { sent.push(t); };
const cfgFile = path.join(HOME, 'config.json');
function withNotify(cfg) {
  sent.length = 0;
  process.env.TGP_NOTIFY = '1';
  if (cfg === undefined) fs.rmSync(cfgFile, { force: true }); else fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  N.setSender(mock);
}
afterEach(() => { N.setSender(null); process.env.TGP_NOTIFY = '0'; fs.rmSync(cfgFile, { force: true }); });

test('approval toast fires once when a task enters awaiting_approval, with run title, step title and canvas url', () => {
  withNotify(undefined);
  const { run_id } = E.startRun('notify1', { title: 'My run' });
  E.done(run_id, 'first', { result: 'ok' });
  assert.equal(sent.length, 0, 'no toast for a normal completion');
  E.next(run_id);
  E.done(run_id, 'review', { result: 'ready for review' });
  assert.equal(sent.length, 1);
  const t = sent[0];
  assert.equal(t.kind, 'approval');
  assert.match(t.title, /My run/);
  assert.match(t.body, new RegExp(`Review step for ${run_id}`));
  assert.match(t.body, /needs your approval/);
  assert.equal(t.url, `http://localhost:8787/r/${run_id}`);
  assert.doesNotMatch(t.title + t.body, /[\u2013\u2014]/);
  E.next(run_id); // repeated polling must not re-notify
  assert.equal(sent.length, 1);
  E.approve(run_id, 'review', { via: 'cli' });
  assert.equal(sent.length, 1, 'done toast is off by default');
});

test('done toast when enabled, and port from config goes into the url', () => {
  withNotify({ port: 8788, notify: { approval: false, done: true } });
  const { run_id } = E.startRun('notify1', { title: 'Done run' });
  E.done(run_id, 'first', { result: 'ok' });
  E.next(run_id);
  E.done(run_id, 'review', { result: 'ready' });
  assert.equal(sent.length, 0, 'approval toast disabled in config');
  E.approve(run_id, 'review', {});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'done');
  assert.equal(sent[0].url, `http://localhost:8788/r/${run_id}`);
});

test('failed toast when a gate failure uses all attempts under stop_on_fail', () => {
  withNotify(undefined);
  const { run_id } = E.startRun('notify1', { title: 'Fail run' });
  E.done(run_id, 'first', { result: 'nope' });
  assert.equal(sent.length, 0, 'first gate failure with attempts left: no toast');
  E.done(run_id, 'first', { result: 'nope again' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'failed');
  assert.match(sent[0].body, /First step/);
  assert.match(sent[0].body, /2 attempts/);
});

test('TGP_NOTIFY=0 and notify:false disable everything', () => {
  withNotify(undefined);
  process.env.TGP_NOTIFY = '0';
  let r = E.startRun('notify1');
  E.done(r.run_id, 'first', { result: 'ok' }); E.next(r.run_id); E.done(r.run_id, 'review', { result: 'ready' });
  assert.equal(sent.length, 0);
  withNotify({ notify: false });
  r = E.startRun('notify1');
  E.done(r.run_id, 'first', { result: 'ok' }); E.next(r.run_id); E.done(r.run_id, 'review', { result: 'ready' });
  assert.equal(sent.length, 0);
  assert.equal(N.notifySettings().enabled, false);
});

test('a broken notifier never breaks the run', () => {
  withNotify(undefined);
  N.setSender(() => { throw new Error('toast exploded'); });
  const { run_id } = E.startRun('notify1');
  E.done(run_id, 'first', { result: 'ok' });
  E.next(run_id);
  const env = E.done(run_id, 'review', { result: 'ready' });
  assert.equal(env.report.status, 'awaiting_approval');
  assert.match(fs.readFileSync(N.logFile(), 'utf8'), /toast failed: toast exploded/);
  N.setSender(() => Promise.reject(new Error('async boom')));
  assert.doesNotThrow(() => N.notify({ title: 'x', body: 'y' }));
});

test('defaults: approval and failed on, done off; test runs are off without TGP_NOTIFY=1', () => {
  fs.rmSync(cfgFile, { force: true });
  delete process.env.TGP_NOTIFY;
  assert.equal(N.notifySettings().enabled, !process.env.NODE_TEST_CONTEXT);
  process.env.TGP_NOTIFY = '1';
  assert.deepEqual(N.notifySettings(), { enabled: true, approval: true, failed: true, done: false });
});

test('notify-test on Linux only logs, through the CLI', async () => {
  const { main } = await import('../src/cli.js');
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = s => { out += s; return true; };
  N.setSender((t, o) => Promise.resolve({ ok: true, shown: false, kind: t.kind, wait: o?.wait }));
  try { await main(['notify-test']); } finally { process.stdout.write = orig; }
  const env = JSON.parse(out);
  assert.equal(env.state, 'ok');
  assert.equal(env.notify.app_id, 'com.tecadrise.tgp');
  process.exitCode = 0;
});

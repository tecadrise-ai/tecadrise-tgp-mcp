import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tpl, ids, tmpdir, expectCode, HOME } from './helpers.js';
import * as E from '../src/engine.js';

// A 3 stage template: s1 single, s2 two parallel lanes, s3 single with a SECRET title.
tpl('three', `
id: three
title: Three stages
params:
  workdir: { default: ${JSON.stringify(path.join(HOME, 'w', '{{run_id}}'))} }
stages:
  - title: First stage
    tasks:
      - id: a
        title: Task A
        gates: [{ type: result_matches, pattern: ok }]
  - title: Parallel stage
    tasks:
      - id: b1
        title: Task B1
        gates: [{ type: result_matches, pattern: ok }]
      - id: b2
        title: Task B2
        skippable: true
        outputs: [n]
        gates: [{ type: result_matches, pattern: ok }]
  - title: Zebra hidden stage
    tasks:
      - id: c
        title: Zebra secret final task
        description: "uses {{tasks.b2.outputs.n}}"
        gates:
          - type: result_matches
            pattern: "^n={{tasks.b2.outputs.n}}$"
`);

test('start returns only stage 1 and hides future stages', () => {
  const env = E.startRun('three');
  assert.equal(env.state, 'work');
  assert.deepEqual(ids(env), ['a']);
  const s = JSON.stringify(env) + JSON.stringify(E.next(env.run_id)) + JSON.stringify(E.status(env.run_id));
  assert.ok(!s.includes('Zebra'), 'locked stage title leaked');
  assert.ok(!s.includes('Task B1'), 'locked task title leaked');
  assert.ok(!s.includes('Parallel stage'), 'locked stage title leaked');
  for (const k of ['run_id', 'state', 'tasks', 'progress', 'instruction']) assert.ok(k in env, 'envelope key ' + k);
});

test('stage gate: locked and unknown tasks are rejected identically', () => {
  const { run_id } = E.startRun('three');
  const e1 = expectCode(() => E.done(run_id, 'c', { result: 'ok' }), 'TASK_NOT_AVAILABLE');
  const e2 = expectCode(() => E.done(run_id, 'nope', { result: 'ok' }), 'TASK_NOT_AVAILABLE');
  assert.equal(e1.message.replace('"c"', 'X'), e2.message.replace('"nope"', 'X'));
  assert.ok(!e1.hint.includes('Zebra'));
  expectCode(() => E.fail(run_id, 'b1', { error: 'x' }), 'TASK_NOT_AVAILABLE');
  expectCode(() => E.skip(run_id, 'b2', { reason: 'x' }), 'TASK_NOT_AVAILABLE');
});

test('next without a report is idempotent', () => {
  const { run_id } = E.startRun('three');
  const a = E.next(run_id), b = E.next(run_id), c = E.next(run_id);
  assert.deepEqual(ids(a), ids(b));
  assert.deepEqual(ids(b), ids(c));
  assert.equal(a.tasks[0].status, 'in_progress');
  const w1 = E.next(run_id, { worker: 'w1' });
  assert.equal(w1.state, 'wait', 'task held by agent, another worker waits');
});

test('parallel lanes: two workers get one lane each, next stage opens only when both are done', () => {
  const { run_id } = E.startRun('three', { worker: 'w1' });
  E.done(run_id, 'a', { result: 'ok', worker: 'w1' });
  const s1 = E.next(run_id, { worker: 'w1' });
  const s2 = E.next(run_id, { worker: 'w2' });
  assert.equal(s1.tasks.length, 1);
  assert.equal(s2.tasks.length, 1);
  assert.notEqual(s1.tasks[0].task_id, s2.tasks[0].task_id);
  assert.deepEqual([s1.tasks[0].task_id, s2.tasks[0].task_id].sort(), ['b1', 'b2']);
  const byW = { [s1.tasks[0].task_id]: 'w1', [s2.tasks[0].task_id]: 'w2' };
  expectCode(() => E.done(run_id, 'b1', { result: 'ok', worker: byW.b1 === 'w1' ? 'w2' : 'w1' }), 'LEASED_TO_OTHER');
  E.done(run_id, 'b1', { result: 'ok', worker: byW.b1 });
  expectCode(() => E.done(run_id, 'c', { result: 'n=1', worker: byW.b1 }), 'TASK_NOT_AVAILABLE');
  const after = E.next(run_id, { worker: byW.b1 });
  assert.equal(after.state, 'wait', 'stage not finished, other lane still running');
  const r = E.done(run_id, 'b2', { result: 'ok', worker: byW.b2, outputs: { n: '7' } });
  assert.equal(r.report.status, 'completed');
});

test('default worker claims all parallel lanes at once', () => {
  const { run_id } = E.startRun('three');
  const env = E.done(run_id, 'a', { result: 'ok' });
  assert.deepEqual(ids(env), ['b1', 'b2']);
});

test('output refs are substituted into later descriptions and gates; required outputs enforced', () => {
  const { run_id } = E.startRun('three');
  E.done(run_id, 'a', { result: 'ok' });
  E.done(run_id, 'b1', { result: 'ok' });
  expectCode(() => E.done(run_id, 'b2', { result: 'ok' }), 'OUTPUT_REQUIRED');
  const env = E.done(run_id, 'b2', { result: 'ok', outputs: { n: '42' } });
  assert.deepEqual(ids(env), ['c']);
  assert.match(env.tasks[0].description, /uses 42/);
  const bad = E.done(run_id, 'c', { result: 'n=41' });
  assert.equal(bad.state, 'gate_failed');
  const good = E.done(run_id, 'c', { result: 'n=42' });
  assert.equal(good.state, 'done');
  assert.equal(good.progress.completed, 4);
  expectCode(() => E.done(run_id, 'c', { result: 'n=42' }), 'RUN_DONE');
});

test('failed gate keeps task open, max_attempts fails it, stop on fail blocks, retry unblocks', () => {
  const { run_id } = E.startRun('three');
  for (let i = 1; i <= 2; i++) {
    const r = E.done(run_id, 'a', { result: 'bad' });
    assert.equal(r.state, 'gate_failed');
    assert.equal(r.report.gate_failed, true);
    assert.equal(r.tasks[0].task_id, 'a');
    assert.equal(r.tasks[0].status, 'in_progress');
    assert.equal(r.tasks[0].attempts, i);
    assert.ok(r.report.gate_results[0].hint);
  }
  const r3 = E.done(run_id, 'a', { result: 'bad' });
  assert.equal(r3.state, 'blocked');
  assert.equal(E.next(run_id).state, 'blocked');
  expectCode(() => E.done(run_id, 'a', { result: 'ok' }), 'TASK_FAILED');
  E.retry(run_id, 'a');
  const n = E.next(run_id);
  assert.equal(n.state, 'work');
  assert.equal(E.done(run_id, 'a', { result: 'ok' }).state, 'work');
});

test('agent fail blocks the run (stop on fail); human skip unblocks', () => {
  const { run_id } = E.startRun('three');
  const r = E.fail(run_id, 'a', { error: 'cannot do it' });
  assert.equal(r.state, 'blocked');
  E.skip(run_id, 'a', { actor: 'human', reason: 'not needed' });
  assert.deepEqual(ids(E.next(run_id)), ['b1', 'b2']);
});

test('agent skip only for skippable tasks and needs a reason', () => {
  const { run_id } = E.startRun('three');
  expectCode(() => E.skip(run_id, 'a', { reason: 'lazy' }), 'NOT_SKIPPABLE');
  E.done(run_id, 'a', { result: 'ok' });
  expectCode(() => E.skip(run_id, 'b2', {}), 'REASON_REQUIRED');
  const r = E.skip(run_id, 'b2', { reason: 'not relevant' });
  assert.deepEqual(ids(r), ['b1']);
});

test('result is required on done', () => {
  const { run_id } = E.startRun('three');
  expectCode(() => E.done(run_id, 'a', { result: '  ' }), 'RESULT_REQUIRED');
});

tpl('manual1', `
id: manual1
title: Manual
stages:
  - tasks:
      - id: m
        title: Needs a human
        gates: [{ type: result_matches, pattern: ready }, { type: manual, prompt: look }]
  - tasks:
      - id: z
        title: After review
        gates: [{ type: result_matches, pattern: ok }]
`);

test('manual gate: awaiting_approval until approved; reject sends it back', () => {
  const { run_id } = E.startRun('manual1');
  const r = E.done(run_id, 'm', { result: 'ready' });
  assert.equal(r.state, 'awaiting_approval');
  assert.equal(E.next(run_id).state, 'awaiting_approval');
  expectCode(() => E.done(run_id, 'z', { result: 'ok' }), 'TASK_NOT_AVAILABLE');
  E.reject(run_id, 'm', { note: 'redo' });
  const back = E.next(run_id);
  assert.equal(back.tasks[0].task_id, 'm');
  assert.equal(back.tasks[0].status, 'in_progress');
  E.done(run_id, 'm', { result: 'ready again' });
  E.approve(run_id, 'm', { note: 'fine' });
  assert.deepEqual(ids(E.next(run_id)), ['z']);
  const evs = E.snapshot(run_id).events.map(e => e.type);
  assert.ok(evs.includes('approved'));
});

test('pause stops claims and reports, resume continues, abort ends', () => {
  const { run_id } = E.startRun('manual1');
  E.pause(run_id);
  assert.equal(E.next(run_id).state, 'paused');
  expectCode(() => E.done(run_id, 'm', { result: 'ready' }), 'RUN_PAUSED');
  E.resume(run_id);
  assert.equal(E.next(run_id).state, 'work');
  E.abort(run_id);
  assert.equal(E.next(run_id).state, 'aborted');
  expectCode(() => E.done(run_id, 'm', { result: 'ready' }), 'RUN_ABORTED');
});

test('expired lease returns the task to pending and it can be reclaimed', () => {
  tpl('lease', `
id: lease
title: Lease
settings: { lease_s: 1 }
stages:
  - tasks:
      - { id: l, title: L, gates: [{ type: result_matches, pattern: ok }] }
`);
  const { run_id } = E.startRun('lease', { worker: 'w1' });
  const runFile = path.join(HOME, 'runs', run_id, 'run.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  run.stages[0].tasks[0].lease_expires_at = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(runFile, JSON.stringify(run));
  const w2 = E.next(run_id, { worker: 'w2' });
  assert.deepEqual(ids(w2), ['l']);
  expectCode(() => E.done(run_id, 'l', { result: 'ok', worker: 'w1' }), 'LEASED_TO_OTHER');
});

test('snapshot (human view) shows locked stages flagged, agent views never do', () => {
  const { run_id } = E.startRun('three');
  const snap = E.snapshot(run_id);
  assert.equal(snap.stages.length, 3);
  assert.equal(snap.stages[2].locked, true);
  assert.equal(snap.stages[0].locked, false);
});

test('event log records the run history', () => {
  const { run_id } = E.startRun('three');
  E.done(run_id, 'a', { result: 'bad' });
  E.done(run_id, 'a', { result: 'ok' });
  const types = E.snapshot(run_id).events.map(e => e.type);
  for (const t of ['run_started', 'task_leased', 'task_reported', 'gate_failed', 'gate_passed', 'task_completed']) assert.ok(types.includes(t), 'missing event ' + t);
});

test('TGP_WORKFLOWS: platform separated dir list, first match wins, {{tmp}} resolves to the OS temp dir', () => {
  const d1 = tmpdir('tgp-wf1-'), d2 = tmpdir('tgp-wf2-');
  const body = (title, wd) => `id: wfx\ntitle: ${title}\nparams:\n  workdir: { default: "${wd}" }\ntasks:\n  - id: t\n    title: T\n    gates: [{ type: result_matches, pattern: ok }]\n`;
  fs.writeFileSync(path.join(d1, 'wfx.yaml'), body('From d1', '{{tmp}}/tgp-wfx/{{run_id}}'));
  fs.writeFileSync(path.join(d2, 'wfx.yaml'), body('From d2', '{{tmp}}/x'));
  fs.writeFileSync(path.join(d2, 'only2.yml'), body('Only d2', '{{tmp}}/y').replace('id: wfx', 'id: only2'));
  const prev = process.env.TGP_WORKFLOWS;
  process.env.TGP_WORKFLOWS = [d1, d2].join(path.delimiter);
  try {
    const names = E.listTemplates().templates.map(t => t.name);
    assert.ok(names.includes('wfx') && names.includes('only2') && names.includes('dummy-12'), JSON.stringify(names));
    const r = E.startRun('wfx', {});
    assert.equal(r.title, 'From d1');
    assert.equal(r.workdir, path.join(os.tmpdir(), 'tgp-wfx', r.run_id));
    E.startRun('only2', {});
  } finally {
    if (prev === undefined) delete process.env.TGP_WORKFLOWS; else process.env.TGP_WORKFLOWS = prev;
  }
});

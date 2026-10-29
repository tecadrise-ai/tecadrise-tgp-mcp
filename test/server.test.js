import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tpl } from './helpers.js';
import * as E from '../src/engine.js';
import { createServer } from '../src/server.js';

tpl('srv', `
id: srv
title: Server test
stages:
  - tasks:
      - { id: s1, title: S1, gates: [{ type: result_matches, pattern: ok }, { type: manual }] }
  - tasks:
      - { id: s2, title: S2, gates: [{ type: result_matches, pattern: ok }] }
`);

test('REST, canvas and SSE reflect CLI actions quickly', async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { run_id } = E.startRun('srv');
    const html = await (await fetch(`${base}/r/${run_id}`)).text();
    assert.match(html, /TGP/);
    assert.match(await (await fetch(base + '/')).text(), /TGP/);
    const snap = await (await fetch(`${base}/api/v1/runs/${run_id}`)).json();
    assert.equal(snap.stages.length, 2);
    const nf = await fetch(`${base}/api/v1/runs/nope`);
    assert.equal(nf.status, 404);
    assert.equal((await nf.json()).error.code, 'RUN_NOT_FOUND');

    // SSE: first snapshot immediately, then an update within about a second of an engine action
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/v1/runs/${run_id}/events`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const nextSnap = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const i = buf.indexOf('\n\n');
        if (i >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const d = chunk.split('\n').find(l => l.startsWith('data: ')); if (d) return JSON.parse(d.slice(6)); continue; }
        const r = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r(null), deadline - Date.now()))]);
        if (!r || r.done) break;
        buf += dec.decode(r.value);
      }
      return null;
    };
    const first = await nextSnap(2000);
    assert.equal(first.run_id, run_id);
    const t0 = Date.now();
    E.done(run_id, 's1', { result: 'ok' });
    let s;
    do { s = await nextSnap(1500); } while (s && s.stages[0].tasks[0].status !== 'awaiting_approval');
    assert.ok(s, 'no SSE update');
    assert.ok(Date.now() - t0 < 1200, 'update took too long');

    // canvas actions
    const ap = await fetch(`${base}/api/v1/runs/${run_id}/tasks/s1/approve`, { method: 'POST', body: '{}' });
    assert.equal(ap.status, 200);
    assert.equal((await ap.json()).stages[0].tasks[0].status, 'completed');
    assert.equal((await (await fetch(`${base}/api/v1/runs/${run_id}/pause`, { method: 'POST' })).json()).state, 'paused');
    assert.equal(E.next(run_id).state, 'paused');
    await fetch(`${base}/api/v1/runs/${run_id}/resume`, { method: 'POST' });
    const ag = await (await fetch(`${base}/api/v1/runs/${run_id}/agent`)).json();
    assert.equal(ag.state, 'work');
    const evs = E.snapshot(run_id).events.filter(e => e.type === 'approved');
    assert.match(evs[0].message, /canvas/);
    ctrl.abort();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tpl } from './helpers.js';
import { handle } from '../src/mcp.js';

tpl('mcp1', `
id: mcp1
title: MCP
stages:
  - tasks: [{ id: x, title: X, gates: [{ type: result_matches, pattern: ok }] }]
  - tasks: [{ id: y, title: Hidden Y, gates: [{ type: result_matches, pattern: ok }] }]
`);
const call = (name, args) => JSON.parse(handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).result.content[0].text);

test('mcp wrapper exposes the gated loop', () => {
  assert.equal(handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }).result.serverInfo.name, 'tgp');
  assert.ok(handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools.some(t => t.name === 'tgp_done'));
  const s = call('tgp_start', { template: 'mcp1' });
  assert.deepEqual(s.tasks.map(t => t.task_id), ['x']);
  assert.equal(call('tgp_done', { run_id: s.run_id, task_id: 'y', result: 'ok' }).error.code, 'TASK_NOT_AVAILABLE');
  assert.equal(call('tgp_done', { run_id: s.run_id, task_id: 'x', result: 'no' }).state, 'gate_failed');
  assert.deepEqual(call('tgp_done', { run_id: s.run_id, task_id: 'x', result: 'ok' }).tasks.map(t => t.task_id), ['y']);
});

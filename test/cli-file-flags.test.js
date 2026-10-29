import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../src/cli.js';

test('--note-file reads text verbatim, keeps quotes, strips BOM and final newline', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-ff-')), 'n.txt');
  fs.writeFileSync(f, '\uFEFFchris_reply <a@b>: "B"\r\n');
  const { flags } = parseArgs(['approve', 'r', 't', '--note-file', f]);
  assert.equal(flags.note, 'chris_reply <a@b>: "B"');
  assert.equal(flags['note-file'], undefined);
});

test('--result-file works and conflicts with --result', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-ff-')), 'r.txt');
  fs.writeFileSync(f, 'line "one"\nline two');
  assert.equal(parseArgs(['done', 'r', 't', `--result-file=${f}`]).flags.result, 'line "one"\nline two');
  assert.throws(() => parseArgs(['done', 'r', 't', '--result', 'x', '--result-file', f]));
});

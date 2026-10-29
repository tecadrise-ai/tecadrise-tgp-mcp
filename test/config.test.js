import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultPort, publicUrl } from '../src/util.js';

test('port and public url come from env, then $TGP_HOME/config.json, then 8787', () => {
  const saved = { h: process.env.TGP_HOME, p: process.env.TGP_PORT, u: process.env.TGP_PUBLIC_URL };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-cfg-'));
  try {
    process.env.TGP_HOME = home;
    delete process.env.TGP_PORT; delete process.env.TGP_PUBLIC_URL;
    assert.equal(defaultPort(), 8787);
    assert.equal(publicUrl(), 'http://localhost:8787');
    fs.writeFileSync(path.join(home, 'config.json'), '\uFEFF{"port": 8788}');
    assert.equal(defaultPort(), 8788);
    assert.equal(publicUrl(), 'http://localhost:8788');
    process.env.TGP_PORT = '9001';
    assert.equal(defaultPort(), 9001);
    process.env.TGP_PUBLIC_URL = 'http://pc.local:9001/';
    assert.equal(publicUrl(), 'http://pc.local:9001');
  } finally {
    for (const [k, v] of [['TGP_HOME', saved.h], ['TGP_PORT', saved.p], ['TGP_PUBLIC_URL', saved.u]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

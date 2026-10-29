// Shared test setup: every test file gets its own temporary TGP_HOME and template dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-test-home-'));
export const TPL = path.join(HOME, 'tpl');
fs.mkdirSync(TPL, { recursive: true });
process.env.TGP_HOME = HOME;
process.env.TGP_TEMPLATES = TPL;
process.env.TGP_NOTIFY = '0'; // never pop real toasts from tests (child processes inherit this)

export function tpl(name, yamlText) {
  const f = path.join(TPL, name + '.yaml');
  fs.writeFileSync(f, yamlText);
  return name;
}
export const ids = env => env.tasks.map(t => t.task_id).sort();
export function tmpdir(prefix = 'tgp-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
export function expectCode(fn, code) {
  try { fn(); } catch (e) { if (e.code === code) return e; throw new Error(`expected ${code}, got ${e.code}: ${e.message}`); }
  throw new Error(`expected error ${code}, but call succeeded`);
}

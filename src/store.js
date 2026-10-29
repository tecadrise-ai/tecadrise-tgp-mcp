// File-based run store under TGP_HOME. One directory per run:
//   runs/<run_id>/run.json      full state (rewritten atomically, version bumped per mutation)
//   runs/<run_id>/events.jsonl  append-only event log
//   runs/<run_id>/logs/         command gate output
// All mutations happen inside a cross-process lock, so several agents can share runs.
import fs from 'node:fs';
import path from 'node:path';
import { TgpError, tgpHome, withLock, writeJsonAtomic, readJson, nowIso } from './util.js';
import { onEvents as notifyEvents } from './notify.js';

export const runsDir = () => path.join(tgpHome(), 'runs');
export const runDir = id => path.join(runsDir(), id);
const runFile = id => path.join(runDir(id), 'run.json');
const eventsFile = id => path.join(runDir(id), 'events.jsonl');
export const logDir = id => path.join(runDir(id), 'logs');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,120}$/;

export function assertRunId(id) {
  if (!id || !ID_RE.test(String(id))) throw new TgpError('BAD_RUN_ID', `"${id ?? ''}" is not a valid run id.`, 'List runs with: tgp runs', 400);
}

export function runExists(id) {
  return ID_RE.test(String(id)) && fs.existsSync(runFile(id));
}

export function loadRun(id) {
  assertRunId(id);
  try { return readJson(runFile(id)); } catch (e) {
    if (e.code === 'ENOENT') throw new TgpError('RUN_NOT_FOUND', `Run "${id}" does not exist.`, 'List runs with: tgp runs. Start one with: tgp start <template>', 404);
    throw e;
  }
}

export function createRunDir(id) {
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.mkdirSync(runDir(id));
  fs.mkdirSync(logDir(id));
}

export function saveRun(run) {
  run.version = (run.version ?? 0) + 1;
  run.updated_at = nowIso();
  writeJsonAtomic(runFile(run.run_id), run);
}

export function appendEvents(run, events) {
  if (!events.length) return;
  const lines = events.map(e => {
    run.event_seq = (run.event_seq ?? 0) + 1;
    return JSON.stringify({ seq: run.event_seq, ts: nowIso(), run_id: run.run_id, ...e });
  });
  fs.appendFileSync(eventsFile(run.run_id), lines.join('\n') + '\n');
}

export function readEvents(id, { sinceSeq = 0, limit = 2000 } = {}) {
  let text = '';
  try { text = fs.readFileSync(eventsFile(id), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e.seq > sinceSeq) out.push(e); } catch { /* skip torn line */ }
  }
  return out.slice(-limit);
}

// Run fn(run, emit) under the run lock, then persist run and events.
// After the lock is released, saved events go to the notifier (fire and forget).
export function mutate(id, fn) {
  assertRunId(id);
  if (!fs.existsSync(runDir(id))) loadRun(id); // throws RUN_NOT_FOUND
  let saved = null;
  try {
    return lockedMutate(id, fn, (run, events) => { saved = { run, events }; });
  } finally {
    if (saved) notifyEvents(saved.run, saved.events);
  }
}

function lockedMutate(id, fn, onSaved) {
  return withLock(runDir(id), () => {
    const run = loadRun(id);
    const events = [];
    const emit = (type, message, extra = {}) => events.push({ type, message, ...extra });
    let out, thrown;
    try { out = fn(run, emit); } catch (e) { thrown = e; }
    if (events.length || !thrown) {
      appendEvents(run, events);
      saveRun(run);
      onSaved(run, events);
    }
    if (thrown) throw thrown;
    return out;
  });
}

export function listRunIds() {
  let ents = [];
  try { ents = fs.readdirSync(runsDir(), { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory() && fs.existsSync(runFile(e.name))).map(e => e.name);
}

// Cheap change key for live updates (atomic rename gives a new inode each save).
export function changeKey(id) {
  try { const st = fs.statSync(runFile(id)); return `${st.ino}:${st.mtimeMs}:${st.size}`; } catch { return 'missing'; }
}
export function runsDirKey() {
  try { const st = fs.statSync(runsDir()); return `${st.mtimeMs}`; } catch { return 'none'; }
}

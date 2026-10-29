// Desktop notifications for the moments a run needs a human.
// Windows: native toast through Windows PowerShell and the built-in WinRT
// ToastNotificationManager (no extra dependency), branded like TecAdRiseBot
// (AppUserModelID com.tecadrise.*, TecAdRise toast icon). Elsewhere: log only.
// Everything here is fire and forget: errors are caught and logged, never thrown,
// and the toast process is detached so a CLI call or the server never waits for it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tgpHome, tgpConfig, publicUrl, subst, nowIso } from './util.js';

export const APP_USER_MODEL_ID = 'com.tecadrise.tgp';
export const APP_DISPLAY_NAME = 'TGP Task Gate';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOAST_SCRIPT = path.join(ROOT, 'scripts', 'toast.ps1');
export const TOAST_ICON = path.join(ROOT, 'resources', 'toast-icon.png');
const DEFAULTS = { approval: true, failed: true, done: false };

export const logFile = () => path.join(tgpHome(), 'notify.log');

export function log(msg) {
  try {
    const f = logFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { if (fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.1'); } catch { /* no log yet */ }
    fs.appendFileSync(f, `${nowIso()} [${process.pid}] ${msg}\n`);
  } catch { /* logging must never break a run */ }
}

// TGP_NOTIFY=0 turns everything off. Test runs (node --test sets NODE_TEST_CONTEXT)
// are off unless a test sets TGP_NOTIFY=1 with a mocked sender.
export function notifySettings() {
  const env = process.env.TGP_NOTIFY;
  let cfg = {};
  try { cfg = tgpConfig().notify; } catch { cfg = {}; }
  if (env === '0' || env === 'false' || env === 'off') return { enabled: false, ...DEFAULTS };
  if (process.env.NODE_TEST_CONTEXT && env !== '1') return { enabled: false, ...DEFAULTS };
  if (cfg === false) return { enabled: false, ...DEFAULTS };
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const pick = k => (typeof c[k] === 'boolean' ? c[k] : DEFAULTS[k]);
  return { enabled: c.enabled !== false, approval: pick('approval'), failed: pick('failed'), done: pick('done') };
}

const clean = s => String(s ?? '').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

// Default sender: Windows toast in a detached, hidden powershell.exe. Returns the child (or null).
// Runs in the detached helper process: start the toast script, wait for it (max 20 s), log spawn errors.
const TRAMPOLINE = `const { spawn } = require('child_process'); const fs = require('fs');
const [cmd, logPath] = [JSON.parse(process.argv[1]), process.argv[2]];
const say = m => { try { fs.appendFileSync(logPath, new Date().toISOString() + ' [toast helper ' + process.pid + '] ' + m + '\\n'); } catch {} };
const c = spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', windowsHide: true });
const t = setTimeout(() => { say('toast script timed out after 20s'); try { c.kill(); } catch {} process.exit(1); }, 20000);
c.on('error', e => { clearTimeout(t); say('toast spawn failed: ' + e.message); process.exit(1); });
c.on('exit', code => { clearTimeout(t); if (code) say('toast script exit code ' + code); process.exit(code ? 1 : 0); });`;

function windowsSender(toast, { wait = false } = {}) {
  if (process.platform !== 'win32') {
    log(`toast (not shown, platform ${process.platform}): ${toast.title} | ${toast.body}`);
    return wait ? Promise.resolve({ ok: true, shown: false }) : null;
  }
  const payload = JSON.stringify({ ...toast, aumid: APP_USER_MODEL_ID, appName: APP_DISPLAY_NAME, icon: fs.existsSync(TOAST_ICON) ? TOAST_ICON : '', log: logFile() });
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = [fs.existsSync(exe) ? exe : 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', TOAST_SCRIPT];
  const env = { ...process.env, TGP_TOAST_JSON: payload };
  if (!wait) {
    // powershell.exe started directly with detached (DETACHED_PROCESS, no console) exits
    // silently, and a non-detached child is killed with node's job object when the CLI exits.
    // So a detached node trampoline runs powershell as a normal hidden child and waits for it.
    const child = spawn(process.execPath, ['-e', TRAMPOLINE, JSON.stringify(cmd), logFile()],
      { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', e => log(`toast spawn failed: ${e.message}`));
    child.unref();
    return child;
  }
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', windowsHide: true, env });
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ ok: false, error: 'toast script timed out after 20s' }); }, 20000);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('exit', code => { clearTimeout(timer); resolve(code === 0 ? { ok: true, shown: true } : { ok: false, error: `toast script exit code ${code}, see ${logFile()}` }); });
  });
}

let sender = windowsSender;
// Tests swap in a mock. Returns the previous sender.
export function setSender(fn) { const prev = sender; sender = fn || windowsSender; return prev; }

// Fire one toast. Never throws, never blocks.
export function notify(toast) {
  try {
    const t = { title: clip(clean(toast.title), 120), body: clip(clean(toast.body), 240), url: toast.url || '', kind: toast.kind || 'info', tag: String(toast.tag || '').slice(0, 64) };
    log(`notify ${t.kind}: ${t.title} | ${t.body}${t.url ? ` | ${t.url}` : ''}`);
    const r = sender(t);
    if (r && typeof r.catch === 'function') r.catch(e => log(`toast failed: ${e?.message || e}`));
  } catch (e) {
    log(`toast failed: ${e?.message || e}`);
  }
}

// Used by tgp notify-test: waits for the toast script and reports the outcome.
export async function sendTest() {
  const toast = { kind: 'test', title: 'TGP test notification', body: 'Notifications work. Approval requests will pop up like this.', url: `${publicUrl()}/`, tag: 'test' };
  log(`notify-test: ${toast.title}`);
  try {
    const r = sender === windowsSender ? await windowsSender(toast, { wait: true }) : await sender(toast, { wait: true });
    const res = r && typeof r === 'object' ? r : { ok: true };
    if (!res.ok) log(`notify-test failed: ${res.error}`);
    return { ...res, platform: process.platform, settings: notifySettings(), log: logFile(), app_id: APP_USER_MODEL_ID };
  } catch (e) {
    log(`notify-test failed: ${e?.message || e}`);
    return { ok: false, error: String(e?.message || e), platform: process.platform, log: logFile() };
  }
}

const runUrl = run => `${publicUrl()}/r/${run.run_id}`;
function stepTitle(run, taskId) {
  const t = run.stages?.flatMap(s => s.tasks).find(x => x.task_id === taskId);
  if (!t) return { title: taskId, task: null };
  let title = t.title || taskId;
  try { title = subst(title, { run_id: run.run_id, params: run.params || {}, tasks: {} }); } catch { /* keep raw */ }
  return { title, task: t };
}

// Turn the events of one committed mutation into toasts. Called by the store after
// every save, in whichever process (CLI, server, MCP) made the change.
export function toastsFor(run, events, settings = notifySettings()) {
  const out = [];
  if (!settings.enabled) return out;
  const runTitle = run.title || run.run_id;
  for (const e of events) {
    if (e.type === 'awaiting_approval' && settings.approval) {
      const { title } = stepTitle(run, e.task_id);
      out.push({ kind: 'approval', title: `${runTitle}: needs your approval`, body: `Step "${title}" needs your approval.`, url: runUrl(run), tag: `${e.task_id}` });
    } else if (e.type === 'task_failed' && settings.failed && run.settings?.stop_on_fail && run.status !== 'cancelled') {
      const { title, task } = stepTitle(run, e.task_id);
      const tries = task?.attempts ? ` after ${task.attempts} attempt${task.attempts === 1 ? '' : 's'}` : '';
      out.push({ kind: 'failed', title: `${runTitle}: blocked`, body: `Step "${title}" failed${tries}. The run is stopped and needs you to retry or skip it.`, url: runUrl(run), tag: `${e.task_id}` });
    } else if (e.type === 'run_completed' && settings.done) {
      out.push({ kind: 'done', title: `${runTitle}: done`, body: 'All steps are complete.', url: runUrl(run), tag: 'done' });
    }
  }
  return out;
}

export function onEvents(run, events) {
  try {
    if (!events?.length) return;
    if (!events.some(e => e.type === 'awaiting_approval' || e.type === 'task_failed' || e.type === 'run_completed')) return;
    for (const t of toastsFor(run, events)) notify(t);
  } catch (e) {
    log(`notify hook failed: ${e?.message || e}`);
  }
}

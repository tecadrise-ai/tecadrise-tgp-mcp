// TGP core: run state machine, stage gate, leases, gate evaluation, response envelope.
// Every public function returns the same envelope shape (or throws TgpError).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TgpError, nowIso, shortId, tgpHome, publicUrl, subst, truncate } from './util.js';
import { loadTemplate, listTemplateFiles, validateFile as validateTemplateFile } from './template.js';
import { evaluateGates, describeGate } from './gates.js';
import * as store from './store.js';

export const DEFAULT_WORKER = 'agent';
const DONE = new Set(['completed', 'skipped']);
const RETRY = { wait: 10, awaiting_approval: 15, paused: 30, blocked: 30 };

// ---------- helpers ----------
const allTasks = run => run.stages.flatMap(s => s.tasks);
const findTask = (run, id) => allTasks(run).find(t => t.task_id === id) || null;
export function openStageIndex(run) { return run.stages.findIndex(s => s.tasks.some(t => !DONE.has(t.status))); }
const maxAttempts = (run, t) => t.max_attempts ?? run.settings.max_attempts;
const q = s => (/^[A-Za-z0-9_@%+=:,./\-]+$/.test(s) ? s : `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`);
const wflag = w => (w && w !== DEFAULT_WORKER ? ` --worker ${q(w)}` : '');
export const canvasUrl = id => `${publicUrl()}/r/${id}`;

function substCtx(run) {
  const tasks = {};
  for (const t of allTasks(run)) tasks[t.task_id] = { status: t.status, outputs: t.outputs || {}, result: t.result };
  return { run_id: run.run_id, tgp_home: tgpHome(), tmp: os.tmpdir(), params: run.params, tasks };
}

function progress(run) {
  const ts = allTasks(run);
  const completed = ts.filter(t => DONE.has(t.status)).length;
  const os = openStageIndex(run);
  return {
    completed,
    skipped: ts.filter(t => t.status === 'skipped').length,
    failed: ts.filter(t => t.status === 'failed').length,
    total: ts.length,
    stage: os === -1 ? run.stages.length : os + 1,
    stages_total: run.stages.length,
    percent: ts.length ? Math.round((completed / ts.length) * 100) : 0,
  };
}

function expireLeases(run, emit) {
  const now = Date.now();
  for (const t of allTasks(run)) {
    if (t.evaluating && Date.parse(t.evaluating.until) < now) t.evaluating = null;
    if (t.status === 'in_progress' && t.lease_expires_at && Date.parse(t.lease_expires_at) < now && !t.evaluating) {
      emit('lease_expired', `Lease of ${t.worker} on ${t.task_id} expired, task returned to pending`, { task_id: t.task_id, worker: t.worker });
      t.status = 'pending';
      t.worker = null;
      t.lease_expires_at = null;
      t.lease_expiries = (t.lease_expiries ?? 0) + 1;
    }
  }
}

function lease(run, t, worker) {
  t.lease_expires_at = new Date(Date.now() + run.settings.lease_s * 1000).toISOString();
  t.worker = worker;
}

function stageBlocked(run, os) {
  return os >= 0 && run.settings.stop_on_fail && run.stages[os].tasks.some(t => t.status === 'failed');
}

function claim(run, worker, explicit, emit) {
  if (run.status !== 'active') return;
  const os = openStageIndex(run);
  if (os < 0 || stageBlocked(run, os)) return;
  const stage = run.stages[os].tasks;
  const pending = stage.filter(t => t.status === 'pending');
  const holdsActive = stage.some(t => t.worker === worker && t.status === 'in_progress');
  const toClaim = explicit ? (holdsActive ? [] : pending.slice(0, 1)) : pending;
  for (const t of toClaim) {
    t.status = 'in_progress';
    t.started_at = t.started_at || nowIso();
    lease(run, t, worker);
    emit('task_leased', `${worker} claimed ${t.task_id}`, { task_id: t.task_id, worker });
  }
}

function checkCompletion(run, emit) {
  if (run.status !== 'completed' && allTasks(run).every(t => DONE.has(t.status))) {
    run.status = 'completed';
    run.finished_at = nowIso();
    emit('run_completed', 'All tasks complete, run finished');
  }
}

// Agent-facing view of one task. Only ever called for tasks in unlocked stages.
function taskView(run, t, ctx, worker) {
  const r = s => subst(s, ctx);
  const v = {
    task_id: t.task_id,
    stage: t.stage,
    lane: t.lane,
    title: r(t.title),
    description: r(t.description),
    done_when: r(t.done_when),
    status: t.status,
    worker: t.worker,
    attempts: t.attempts,
    max_attempts: maxAttempts(run, t),
    skippable: t.skippable,
    outputs_required: t.outputs_required,
    gates: t.gates.map(g => (g.label ? subst(g.label, ctx) : describeGate(subst(g, ctx)))),
  };
  if (t.lease_expires_at) v.lease_expires_at = t.lease_expires_at;
  if (t.last_gate && t.last_gate.passed === false) v.last_gate = t.last_gate;
  if (t.error) v.error = t.error;
  if (t.status === 'in_progress') {
    v.report_with = `tgp done ${run.run_id} ${t.task_id} --result "<evidence of what you did>"`
      + t.outputs_required.map(k => ` --output ${k}=<value>`).join('') + wflag(worker || t.worker);
  }
  return v;
}

// Compute agent state for a worker without changing anything.
function computeState(run, worker) {
  if (run.status === 'cancelled') return { state: 'aborted', tasks: [] };
  if (run.status === 'completed') return { state: 'done', tasks: [] };
  const os = openStageIndex(run);
  if (os < 0) return { state: 'done', tasks: [] };
  const stage = run.stages[os].tasks;
  const failed = stage.filter(t => t.status === 'failed');
  const mineActive = stage.filter(t => t.worker === worker && t.status === 'in_progress');
  const mineAwait = stage.filter(t => t.worker === worker && t.status === 'awaiting_approval');
  if (run.status === 'paused') return { state: 'paused', tasks: [] };
  if (failed.length && run.settings.stop_on_fail) return { state: 'blocked', tasks: failed };
  if (mineActive.length) return { state: 'work', tasks: [...mineActive, ...mineAwait] };
  const othersBusy = stage.filter(t => t.status === 'in_progress');
  const pending = stage.filter(t => t.status === 'pending');
  const awaiting = stage.filter(t => t.status === 'awaiting_approval');
  if (mineAwait.length && !pending.length) return { state: 'awaiting_approval', tasks: mineAwait };
  if (pending.length) return { state: 'work', tasks: [], claimable: pending.length };
  if (othersBusy.length) return { state: 'wait', tasks: [] };
  if (awaiting.length) return { state: 'awaiting_approval', tasks: awaiting };
  if (failed.length) return { state: 'blocked', tasks: failed };
  return { state: 'wait', tasks: [] };
}

function instructionFor(run, state, tasks, worker, extra = {}) {
  const id = run.run_id;
  const nextCmd = `tgp next ${id}${wflag(worker)}`;
  const url = canvasUrl(id);
  switch (state) {
    case 'work': {
      if (!tasks.some(t => t.status === 'in_progress')) return `There is open work but none is claimed by you yet. Run: ${nextCmd}`;
      const ids = tasks.filter(t => t.status === 'in_progress').map(t => t.task_id);
      return `Do ONLY these task(s) now: ${ids.join(', ')}. Do not work ahead, later steps are hidden and locked. `
        + `When a task is finished, report it with the command in its report_with field, giving concrete evidence in --result`
        + `${tasks.some(t => t.outputs_required.length) ? ' and every required --output' : ''}. The engine checks the gates itself. `
        + `If you cannot complete a task, run: tgp fail ${id} <task_id> --error "<why>"${wflag(worker)}. After any context loss, run: ${nextCmd}`;
    }
    case 'gate_failed': {
      const t = tasks.find(x => x.task_id === extra.task_id) || {};
      const fails = (extra.gate_results || []).filter(g => g.passed === false);
      return `Gate check FAILED for ${extra.task_id} (attempt ${t.attempts} of ${t.max_attempts}). The task is NOT done and stays open. `
        + `Failed: ${fails.map(f => `${f.label}: ${f.detail}`).join(' | ')}. `
        + `Hint: ${fails.map(f => f.hint).filter(Boolean).join(' ')} Fix the problem, then report again with: ${t.report_with || `tgp done ${id} ${extra.task_id} --result "..."`}. Do not move on to anything else.`;
    }
    case 'awaiting_approval':
      return `Waiting for a human to approve ${tasks.map(t => t.task_id).join(', ')}. Do nothing else. Tell the human to review and approve at ${url} (or with tgp approve ${id} <task_id>). Then wait about ${RETRY.awaiting_approval} seconds and run: ${nextCmd}`;
    case 'wait':
      return `Other workers hold the remaining tasks of this stage. Do nothing else. Wait about ${RETRY.wait} seconds, then run: ${nextCmd}`;
    case 'blocked': {
      const f = tasks.map(t => `${t.task_id} (${truncate(t.error || 'failed', 200)})`).join(', ');
      const skippable = tasks.filter(t => t.skippable).map(t => t.task_id);
      return `Run is BLOCKED because a task failed: ${f}. Stop and do not work around it. Tell the human, who can retry or skip it on the canvas at ${url}. `
        + `${skippable.length ? `The template allows skipping ${skippable.join(', ')} with: tgp skip ${id} <task_id> --reason "<why>". ` : ''}`
        + `To give up, the human can run: tgp abort ${id}. After a decision, run: ${nextCmd}`;
    }
    case 'paused':
      return `A human paused this run. Do nothing. Wait about ${RETRY.paused} seconds, then run: ${nextCmd}`;
    case 'done':
      return `The workflow is finished, all ${allTasks(run).length} tasks are complete. Do not run more steps. Summarize the results (see tgp status ${id}) and share the canvas link ${url} with the human.`;
    case 'aborted':
      return `This run was aborted. Stop all work on it. Do not continue the workflow.`;
    case 'rejected':
      return `Your last command was rejected: ${extra.error?.message} ${extra.error?.hint || ''} Your current tasks are listed in tasks. If unsure, run: ${nextCmd}`.trim();
    default:
      return `Run: ${nextCmd}`;
  }
}

function envelope(run, worker, extra = {}) {
  const ctx = substCtx(run);
  const st = computeState(run, worker);
  let state = extra.state || st.state;
  let tasks = st.tasks;
  if (extra.tasks) tasks = extra.tasks;
  const views = tasks.map(t => taskView(run, t, ctx, worker));
  const env = {
    tgp: 1,
    run_id: run.run_id,
    title: run.title,
    template: run.template_id,
    state,
    tasks: views,
    progress: progress(run),
    instruction: '',
    canvas_url: canvasUrl(run.run_id),
    workdir: run.params.workdir,
    worker,
  };
  if (RETRY[state]) env.retry_after_s = RETRY[state];
  if (extra.report) env.report = extra.report;
  if (extra.error) env.error = extra.error;
  if (extra.history) env.history = extra.history;
  env.instruction = instructionFor(run, state, views, worker, { ...extra, ...(extra.report || {}) });
  return env;
}

// Error envelope: identical shape, state "rejected", nothing leased or changed.
export function errorEnvelope(runId, worker, err) {
  const e = err instanceof TgpError ? err.toJSON() : { code: 'INTERNAL', message: String(err?.message || err), hint: 'Retry the command. If it keeps failing, tell the human.' };
  let run = null;
  try { if (runId && store.runExists(runId)) run = store.loadRun(runId); } catch { run = null; }
  if (!run) {
    return { tgp: 1, run_id: runId || null, state: 'rejected', tasks: [], progress: null, instruction: `Command rejected: ${e.message} ${e.hint}`.trim(), error: e };
  }
  const w = worker || DEFAULT_WORKER;
  const st = computeState(run, w);
  return envelope(run, w, { state: 'rejected', error: e, tasks: st.state === 'work' ? st.tasks : [] });
}

function agentTouch(run, worker) { run.last_agent_at = nowIso(); run.last_agent = worker; }

// Throws the same "not available" error for unknown and locked tasks so nothing leaks.
function availableTask(run, taskId) {
  const t = findTask(run, taskId);
  const os = openStageIndex(run);
  if (!t || os < 0 || t.stage - 1 > os) {
    throw new TgpError('TASK_NOT_AVAILABLE', `Task "${taskId}" is not available to you right now.`,
      `Only the tasks returned by tgp next ${run.run_id} may be worked on or reported. Future steps stay locked until the current stage passes its gates. Run: tgp next ${run.run_id}`, 409);
  }
  return t;
}

function assertRunWritable(run) {
  if (run.status === 'cancelled') throw new TgpError('RUN_ABORTED', 'This run was aborted.', 'Stop working on it. Start a new run if needed: tgp start <template>', 409);
  if (run.status === 'completed') throw new TgpError('RUN_DONE', 'This run is already finished.', 'Nothing more to report. See tgp status ' + run.run_id, 409);
}

function assertAgentTask(run, t, worker, verb) {
  if (DONE.has(t.status)) throw new TgpError('TASK_ALREADY_DONE', `Task ${t.task_id} is already ${t.status}.`, `Run: tgp next ${run.run_id}${wflag(worker)}`, 409);
  if (t.status === 'awaiting_approval') throw new TgpError('AWAITING_APPROVAL', `Task ${t.task_id} already passed its automatic gates and waits for human approval.`, `Wait, then run: tgp next ${run.run_id}${wflag(worker)}`, 409);
  if (t.status === 'failed') throw new TgpError('TASK_FAILED', `Task ${t.task_id} has failed and blocks the run.`, `A human must retry or skip it on the canvas ${canvasUrl(run.run_id)}.`, 409);
  if (t.status === 'pending') throw new TgpError('NOT_LEASED', `Task ${t.task_id} is not claimed by you${t.lease_expiries ? ' (your lease expired)' : ''}.`, `Claim it first with: tgp next ${run.run_id}${wflag(worker)}, do the work, then ${verb}.`, 409);
  if (t.worker !== worker) throw new TgpError('LEASED_TO_OTHER', `Task ${t.task_id} is held by worker "${t.worker}", not "${worker}".`, `Pass --worker ${t.worker} if that is you, otherwise run: tgp next ${run.run_id}${wflag(worker)}`, 409);
  if (t.evaluating && Date.parse(t.evaluating.until) > Date.now()) throw new TgpError('GATE_IN_PROGRESS', `Gates for ${t.task_id} are being evaluated right now.`, 'Wait for the previous report to finish, then run tgp next.', 409);
}

// ---------- public API ----------
export function listTemplates() {
  const out = [];
  for (const [name, file] of listTemplateFiles()) {
    try {
      const t = loadTemplate(file);
      out.push({ name, id: t.id, title: t.title, description: t.description, file, stages: t.stages.length, tasks: t.stages.reduce((n, s) => n + s.tasks.length, 0),
        params: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { default: v.default, required: v.required, description: v.description }])) });
    } catch (e) { out.push({ name, file, error: e.message }); }
  }
  return { tgp: 1, run_id: null, state: 'ok', tasks: [], progress: null, templates: out, instruction: 'Start a run with: tgp start <name> [--param key=value]. Then follow the instruction field of every response.' };
}

export function startRun(templateRef, { params = {}, title, worker } = {}) {
  const tpl = loadTemplate(templateRef);
  for (const k of Object.keys(params)) {
    if (!tpl.params[k]) throw new TgpError('UNKNOWN_PARAM', `Template ${tpl.id} has no parameter "${k}".`, `Known parameters: ${Object.keys(tpl.params).join(', ')}`);
  }
  let runId;
  for (let i = 0; i < 20; i++) {
    runId = `${tpl.id}-${shortId(6)}`;
    try { store.createRunDir(runId); break; } catch (e) { if (e.code !== 'EEXIST' || i === 19) throw e; }
  }
  const ctx = { run_id: runId, tgp_home: tgpHome(), tmp: os.tmpdir(), params: {} };
  for (const [k, spec] of Object.entries(tpl.params)) {
    const raw = params[k] ?? spec.default;
    if ((raw === null || raw === undefined || raw === '') && spec.required) {
      fs.rmSync(store.runDir(runId), { recursive: true, force: true });
      throw new TgpError('PARAM_REQUIRED', `Parameter "${k}" is required${spec.description ? ` (${spec.description})` : ''}.`, `Pass it with: tgp start ${tpl.id} --param ${k}=<value>`);
    }
    const missing = [];
    ctx.params[k] = raw === null || raw === undefined ? '' : subst(String(raw), { ...ctx }, missing);
  }
  if (ctx.params.workdir) ctx.params.workdir = path.resolve(ctx.params.workdir);
  const now = nowIso();
  const run = {
    schema: 1, run_id: runId, template_id: tpl.id, template_file: tpl.source, title: title || tpl.title, description: tpl.description,
    status: 'active', created_at: now, updated_at: now, finished_at: null, version: 0, event_seq: 0,
    params: ctx.params, settings: tpl.settings, last_agent_at: null, last_agent: null,
    stages: tpl.stages.map((s, si) => ({
      stage: si + 1, title: s.title,
      tasks: s.tasks.map((t, li) => ({
        ...t, stage: si + 1, lane: li + 1, status: 'pending', worker: null, lease_expires_at: null, attempts: 0, lease_expiries: 0,
        result: null, outputs: {}, artifacts: [], error: null, last_gate: null, gate_history: [], skip_reason: null, approval: null,
        started_at: null, finished_at: null, reported_at: null, evaluating: null,
      })),
    })),
  };
  store.appendEvents(run, [{ type: 'run_started', message: `Run started from template ${tpl.id}`, data: { params: run.params } }]);
  store.saveRun(run);
  return next(runId, { worker });
}

export function next(runId, { worker } = {}) {
  const explicit = !!worker && worker !== DEFAULT_WORKER;
  const w = worker || DEFAULT_WORKER;
  return store.mutate(runId, (run, emit) => {
    expireLeases(run, emit);
    agentTouch(run, w);
    claim(run, w, explicit, emit);
    return envelope(run, w);
  });
}

export function heartbeat(runId, taskId, { worker } = {}) {
  const w = worker || DEFAULT_WORKER;
  return store.mutate(runId, (run, emit) => {
    expireLeases(run, emit);
    assertRunWritable(run);
    const t = availableTask(run, taskId);
    assertAgentTask(run, t, w, 'send the heartbeat');
    lease(run, t, w);
    agentTouch(run, w);
    return envelope(run, w);
  });
}

function parseOutputs(outputs) {
  if (!outputs) return {};
  if (Array.isArray(outputs)) {
    const o = {};
    for (const kv of outputs) { const i = String(kv).indexOf('='); if (i < 1) throw new TgpError('BAD_OUTPUT', `Output "${kv}" must look like key=value.`, 'Example: --output words=4'); o[kv.slice(0, i)] = kv.slice(i + 1); }
    return o;
  }
  return { ...outputs };
}

export function done(runId, taskId, { result, artifacts = [], outputs, worker } = {}) {
  const w = worker || DEFAULT_WORKER;
  const outs = parseOutputs(outputs);
  const token = shortId(8);
  // phase 1: validate and mark evaluating
  const prep = store.mutate(runId, (run, emit) => {
    expireLeases(run, emit);
    assertRunWritable(run);
    if (run.status === 'paused') throw new TgpError('RUN_PAUSED', 'The run is paused by a human, reports are not accepted right now.', `Wait, then run: tgp next ${runId}${wflag(w)}`, 409);
    const t = availableTask(run, taskId);
    assertAgentTask(run, t, w, 'report done');
    if (!result || !String(result).trim()) throw new TgpError('RESULT_REQUIRED', 'A done report needs a non-empty --result with evidence.', `Say what you did and how it can be verified, for example: --result "wrote 10 lines to nums.txt"`);
    const missingOut = t.outputs_required.filter(k => outs[k] === undefined || outs[k] === '');
    if (missingOut.length) throw new TgpError('OUTPUT_REQUIRED', `Task ${t.task_id} requires output(s): ${missingOut.join(', ')}.`, `Add ${missingOut.map(k => `--output ${k}=<value>`).join(' ')} to the done command.`);
    const arts = artifacts.map(a => {
      const p = path.resolve(run.params.workdir && !path.isAbsolute(a) ? run.params.workdir : process.cwd(), a);
      let st; try { st = fs.statSync(p); } catch { throw new TgpError('ARTIFACT_NOT_FOUND', `Artifact ${p} does not exist.`, 'Only list files that exist. Create it or drop the --artifact flag.'); }
      return { path: p, bytes: st.size };
    });
    const budget = t.gates.reduce((n, g) => n + (g.type === 'command' ? (g.timeout_s ?? 60) : g.type === 'media_duration' ? 30 : 1), 0) + 60;
    t.evaluating = { token, since: nowIso(), until: new Date(Date.now() + budget * 1000).toISOString(), worker: w };
    t.attempt_no = (t.attempt_no ?? 0) + 1;
    lease(run, t, w);
    agentTouch(run, w);
    emit('task_reported', `${w} reported ${t.task_id} done: ${truncate(result, 300)}`, { task_id: t.task_id, worker: w, data: { result: truncate(result, 2000), outputs: outs, artifacts: arts } });
    const ctx = substCtx(run);
    ctx.tasks[t.task_id] = { status: 'completed', outputs: outs, result }; // a task may reference its own reported outputs
    return { task: JSON.parse(JSON.stringify(t)), ctx, arts, attemptNo: t.attempt_no, workdir: run.params.workdir };
  });

  // phase 2: evaluate gates without holding the lock (commands can be slow)
  let evalRes;
  try {
    evalRes = evaluateGates(prep.task, prep.ctx, {
      workdir: prep.workdir, result: String(result), logDir: store.logDir(runId), attempt: prep.attemptNo, fallbackCwd: store.runDir(runId),
      env: { TGP_RUN_ID: runId, TGP_TASK_ID: taskId, TGP_WORKDIR: prep.workdir || '', TGP_RESULT: String(result), TGP_HOME: tgpHome() },
    });
  } catch (e) {
    evalRes = { passed: false, needs_manual: false, results: [{ index: -1, type: 'engine', label: 'gate engine', passed: false, detail: e.message, hint: 'Report again. If this repeats, tell the human.' }] };
  }

  // phase 3: apply
  return store.mutate(runId, (run, emit) => {
    const t = findTask(run, taskId);
    if (!t || t.evaluating?.token !== token) {
      throw new TgpError('STALE_REPORT', `Task ${taskId} changed while its gates were evaluated.`, `Run: tgp next ${runId}${wflag(w)}`, 409);
    }
    t.evaluating = null;
    if (run.status !== 'active' && run.status !== 'paused') {
      throw new TgpError('RUN_ABORTED', 'The run was aborted while the gates ran.', 'Stop working on it.', 409);
    }
    const lastGate = { at: nowIso(), attempt: prep.attemptNo, passed: evalRes.passed, results: evalRes.results };
    t.last_gate = lastGate;
    t.gate_history = [...(t.gate_history || []), lastGate].slice(-10);
    t.reported_at = nowIso();
    const report = { task_id: taskId, accepted: false, gate_failed: !evalRes.passed, gate_results: evalRes.results };
    if (!evalRes.passed) {
      t.attempts += 1;
      const max = maxAttempts(run, t);
      const failText = evalRes.results.filter(r => r.passed === false).map(r => `${r.label}: ${r.detail}`).join(' | ');
      emit('gate_failed', `Gate failed for ${taskId} (attempt ${t.attempts}/${max}): ${truncate(failText, 400)}`, { task_id: taskId, worker: w, data: { results: evalRes.results } });
      if (t.attempts >= max) {
        t.status = 'failed';
        t.error = `Gate failed ${t.attempts} times. Last failure: ${truncate(failText, 600)}`;
        t.finished_at = nowIso();
        t.lease_expires_at = null;
        emit('task_failed', `${taskId} failed after ${t.attempts} attempts${run.settings.stop_on_fail ? ', run blocked (stop on fail)' : ''}`, { task_id: taskId });
        report.status = 'failed';
        const env = envelope(run, w, { report });
        return env;
      }
      report.status = 'gate_failed';
      const st = computeState(run, w);
      return envelope(run, w, { state: 'gate_failed', report, tasks: st.tasks.length ? st.tasks : [t] });
    }
    t.result = String(result);
    t.outputs = outs;
    t.artifacts = prep.arts;
    t.error = null;
    report.accepted = true;
    emit('gate_passed', `All automatic gates passed for ${taskId}`, { task_id: taskId, data: { results: evalRes.results } });
    if (evalRes.needs_manual) {
      t.status = 'awaiting_approval';
      t.lease_expires_at = null;
      report.status = 'awaiting_approval';
      emit('awaiting_approval', `${taskId} waits for human approval`, { task_id: taskId });
    } else {
      t.status = 'completed';
      t.finished_at = nowIso();
      t.lease_expires_at = null;
      report.status = 'completed';
      emit('task_completed', `${taskId} completed`, { task_id: taskId, worker: w });
      checkCompletion(run, emit);
    }
    claim(run, w, !!worker && worker !== DEFAULT_WORKER, emit);
    return envelope(run, w, { report });
  });
}

export function fail(runId, taskId, { error, worker } = {}) {
  const w = worker || DEFAULT_WORKER;
  return store.mutate(runId, (run, emit) => {
    expireLeases(run, emit);
    assertRunWritable(run);
    const t = availableTask(run, taskId);
    assertAgentTask(run, t, w, 'report the failure');
    if (!error || !String(error).trim()) throw new TgpError('ERROR_REQUIRED', 'A fail report needs a non-empty --error.', 'Explain what went wrong, for example: --error "site returned 403"');
    t.status = 'failed';
    t.error = String(error);
    t.finished_at = nowIso();
    t.lease_expires_at = null;
    agentTouch(run, w);
    emit('task_failed', `${w} reported ${taskId} failed: ${truncate(error, 300)}`, { task_id: taskId, worker: w });
    return envelope(run, w, { report: { task_id: taskId, accepted: true, status: 'failed' } });
  });
}

export function skip(runId, taskId, { reason, worker, actor = 'agent' } = {}) {
  const w = worker || DEFAULT_WORKER;
  const human = actor === 'human';
  return store.mutate(runId, (run, emit) => {
    expireLeases(run, emit);
    assertRunWritable(run);
    const t = availableTask(run, taskId);
    if (DONE.has(t.status)) throw new TgpError('TASK_ALREADY_DONE', `Task ${taskId} is already ${t.status}.`, `Run: tgp next ${runId}`, 409);
    if (!human) {
      if (!t.skippable) throw new TgpError('NOT_SKIPPABLE', `Task ${taskId} may not be skipped, the template requires it.`, `Do the task and report it with tgp done, or ask the human to decide on the canvas ${canvasUrl(runId)}.`, 409);
      if (t.status === 'in_progress' && t.worker !== w) throw new TgpError('LEASED_TO_OTHER', `Task ${taskId} is held by worker "${t.worker}".`, 'Only the holder may skip it.', 409);
      if (!reason || !String(reason).trim()) throw new TgpError('REASON_REQUIRED', 'Skipping needs a --reason.', 'Explain why the task is not needed.');
      agentTouch(run, w);
    }
    const prev = t.status;
    t.status = 'skipped';
    t.skip_reason = String(reason || 'skipped by human');
    t.finished_at = nowIso();
    t.lease_expires_at = null;
    emit('task_skipped', `${human ? 'Human' : w} skipped ${taskId} (was ${prev}): ${truncate(t.skip_reason, 300)}`, { task_id: taskId, actor });
    checkCompletion(run, emit);
    if (!human) claim(run, w, !!worker && worker !== DEFAULT_WORKER, emit);
    return envelope(run, w, { report: { task_id: taskId, accepted: true, status: 'skipped' } });
  });
}

export function approve(runId, taskId, { note = '', actor = 'human', via = 'cli' } = {}) {
  return store.mutate(runId, (run, emit) => {
    assertRunWritable(run);
    const t = availableTask(run, taskId);
    if (t.status !== 'awaiting_approval') throw new TgpError('NOT_AWAITING_APPROVAL', `Task ${taskId} is ${t.status}, not awaiting approval.`, 'Only tasks that passed their automatic gates and have a manual gate can be approved.', 409);
    t.status = 'completed';
    t.finished_at = nowIso();
    t.approval = { by: actor, via, at: nowIso(), note };
    if (t.last_gate) t.last_gate.results = t.last_gate.results.map(r => (r.type === 'manual' ? { ...r, passed: true, detail: `approved via ${via}${note ? `: ${note}` : ''}` } : r));
    emit('approved', `${taskId} approved via ${via}${note ? `: ${note}` : ''}`, { task_id: taskId, actor });
    emit('task_completed', `${taskId} completed`, { task_id: taskId });
    checkCompletion(run, emit);
    return envelope(run, t.worker || DEFAULT_WORKER, { report: { task_id: taskId, accepted: true, status: 'completed' } });
  });
}

export function reject(runId, taskId, { note = '', via = 'cli' } = {}) {
  return store.mutate(runId, (run, emit) => {
    assertRunWritable(run);
    const t = availableTask(run, taskId);
    if (t.status !== 'awaiting_approval') throw new TgpError('NOT_AWAITING_APPROVAL', `Task ${taskId} is ${t.status}, not awaiting approval.`, 'Only tasks awaiting approval can be rejected.', 409);
    t.attempts += 1;
    const msg = `Rejected by human${note ? `: ${note}` : ''}`;
    emit('rejected', `${taskId} rejected via ${via}${note ? `: ${note}` : ''}`, { task_id: taskId });
    if (t.attempts >= maxAttempts(run, t)) {
      t.status = 'failed'; t.error = msg; t.finished_at = nowIso();
      emit('task_failed', `${taskId} failed after ${t.attempts} attempts`, { task_id: taskId });
    } else {
      t.status = 'in_progress'; t.error = msg; lease(run, t, t.worker || DEFAULT_WORKER);
      t.last_gate = { ...(t.last_gate || {}), passed: false, results: (t.last_gate?.results || []).map(r => (r.type === 'manual' ? { ...r, passed: false, detail: msg, hint: 'Address the reviewer note, then report done again.' } : r)) };
    }
    return envelope(run, t.worker || DEFAULT_WORKER);
  });
}

export function retry(runId, taskId, { actor = 'human', via = 'cli' } = {}) {
  return store.mutate(runId, (run, emit) => {
    assertRunWritable(run);
    const t = availableTask(run, taskId);
    if (t.status !== 'failed') throw new TgpError('NOT_FAILED', `Task ${taskId} is ${t.status}, only failed tasks can be retried.`, 'Use retry on a failed task.', 409);
    t.status = 'pending'; t.attempts = 0; t.worker = null; t.lease_expires_at = null; t.finished_at = null;
    t.last_error = t.error; t.error = null;
    emit('retry', `${taskId} reset for retry via ${via}`, { task_id: taskId, actor });
    return envelope(run, DEFAULT_WORKER);
  });
}

function setStatus(runId, from, to, type, msg) {
  return store.mutate(runId, (run, emit) => {
    if (!from.includes(run.status)) throw new TgpError('BAD_RUN_STATE', `Run is ${run.status}, cannot ${type}.`, `Allowed when the run is ${from.join(' or ')}.`, 409);
    run.status = to;
    if (to === 'cancelled') run.finished_at = nowIso();
    emit(type, msg);
    return envelope(run, DEFAULT_WORKER);
  });
}
export const pause = (id, { via = 'cli' } = {}) => setStatus(id, ['active'], 'paused', 'paused', `Run paused via ${via}`);
export const resume = (id, { via = 'cli' } = {}) => setStatus(id, ['paused'], 'active', 'resumed', `Run resumed via ${via}`);
export const abort = (id, { via = 'cli', reason = '' } = {}) => setStatus(id, ['active', 'paused'], 'cancelled', 'aborted', `Run aborted via ${via}${reason ? `: ${reason}` : ''}`);

export function status(runId, { worker } = {}) {
  const w = worker || DEFAULT_WORKER;
  const run = store.loadRun(runId);
  const os = openStageIndex(run);
  const visibleStages = os < 0 ? run.stages : run.stages.slice(0, os + 1);
  const ctx = substCtx(run);
  const history = visibleStages.flatMap(s => s.tasks).filter(t => DONE.has(t.status) || t.status === 'failed').map(t => ({
    task_id: t.task_id, stage: t.stage, lane: t.lane, title: subst(t.title, ctx), status: t.status, result: t.result, outputs: t.outputs,
    ...(t.skip_reason ? { skip_reason: t.skip_reason } : {}), ...(t.error ? { error: t.error } : {}), finished_at: t.finished_at,
  }));
  const st = computeState(run, w);
  const env = envelope(run, w, { history });
  if (st.state === 'work' && !st.tasks.length) env.instruction = `Open work is waiting to be claimed. Run: tgp next ${runId}${wflag(w)}`;
  return env;
}

function displayState(run) {
  if (run.status === 'cancelled') return 'aborted';
  if (run.status === 'completed') return 'done';
  if (run.status === 'paused') return 'paused';
  const os = openStageIndex(run);
  if (os < 0) return 'done';
  const st = run.stages[os].tasks;
  if (st.some(t => t.status === 'failed') && (run.settings.stop_on_fail || !st.some(t => ['pending', 'in_progress'].includes(t.status)))) return 'blocked';
  if (st.some(t => t.status === 'awaiting_approval') && !st.some(t => ['pending', 'in_progress'].includes(t.status))) return 'awaiting_approval';
  return 'active';
}

export function listRuns() {
  const runs = [];
  for (const id of store.listRunIds()) {
    try {
      const r = store.loadRun(id);
      runs.push({ run_id: id, title: r.title, template: r.template_id, status: r.status, state: displayState(r), progress: progress(r), created_at: r.created_at, updated_at: r.updated_at, last_agent_at: r.last_agent_at, canvas_url: canvasUrl(id) });
    } catch { /* skip corrupt */ }
  }
  runs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { tgp: 1, run_id: null, state: 'ok', tasks: [], progress: null, runs, instruction: 'Resume a run with: tgp next <run_id>. Start a new one with: tgp start <template>.' };
}

// Human view: everything, including locked stages. Served to the canvas only.
export function snapshot(runId) {
  const run = store.loadRun(runId);
  const ctx = substCtx(run);
  const os = openStageIndex(run);
  return {
    run_id: run.run_id, title: run.title, description: run.description, template: run.template_id, template_file: run.template_file,
    status: run.status, state: displayState(run), version: run.version, created_at: run.created_at, updated_at: run.updated_at, finished_at: run.finished_at,
    last_agent_at: run.last_agent_at, last_agent: run.last_agent, params: run.params, settings: run.settings,
    progress: progress(run), open_stage: os < 0 ? null : os + 1, canvas_url: canvasUrl(run.run_id), server_time: nowIso(),
    stages: run.stages.map(s => ({
      stage: s.stage, title: s.title,
      locked: os >= 0 && s.stage - 1 > os,
      tasks: s.tasks.map(t => ({
        task_id: t.task_id, stage: t.stage, lane: t.lane, title: subst(t.title, ctx), description: subst(t.description, ctx), done_when: subst(t.done_when, ctx),
        status: t.status, worker: t.worker, attempts: t.attempts, max_attempts: maxAttempts(run, t), skippable: t.skippable, outputs_required: t.outputs_required,
        gates: t.gates.map(g => ({ type: g.type, label: g.label ? subst(g.label, ctx) : describeGate(subst(g, ctx)) })),
        last_gate: t.last_gate, result: t.result, outputs: t.outputs, artifacts: t.artifacts, error: t.error, last_error: t.last_error || null,
        skip_reason: t.skip_reason, approval: t.approval, lease_expires_at: t.lease_expires_at, started_at: t.started_at, finished_at: t.finished_at, reported_at: t.reported_at,
        evaluating: !!t.evaluating,
      })),
    })),
    events: store.readEvents(runId, { limit: 1000 }),
  };
}

export function validate(file) {
  const r = validateTemplateFile(file);
  const summary = r.template ? { id: r.template.id, title: r.template.title, stages: r.template.stages.length, tasks: r.template.stages.reduce((n, s) => n + s.tasks.length, 0), gate_types: [...new Set(r.template.stages.flatMap(s => s.tasks.flatMap(t => t.gates.map(g => g.type))))] } : null;
  return { tgp: 1, run_id: null, state: r.valid ? 'ok' : 'invalid', tasks: [], progress: null, file: r.file, valid: r.valid, errors: r.errors, template: summary,
    instruction: r.valid ? `Template is valid. Start it with: tgp start ${r.file}` : 'Fix the listed errors and validate again.' };
}

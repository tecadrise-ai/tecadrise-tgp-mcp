// tgp command line. JSON envelope on stdout by default, --pretty for humans.
import * as engine from './engine.js';
import { TgpError, defaultPort } from './util.js';
import { sendTest } from './notify.js';

const VALUE_FLAGS = new Set(['param', 'title', 'worker', 'result', 'artifact', 'output', 'error', 'reason', 'note', 'port', 'host']);
const MULTI = new Set(['param', 'artifact', 'output']);

export function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (VALUE_FLAGS.has(k)) {
        if (v === undefined) { v = argv[++i]; if (v === undefined) throw new TgpError('USAGE', `--${k} needs a value.`, 'See: tgp help'); }
        if (MULTI.has(k)) (flags[k] ||= []).push(v); else flags[k] = v;
      } else flags[k] = v === undefined ? true : v;
    } else if (a === '-h') flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

const HELP = `tgp, Task Gate Protocol. Gated, step-by-step workflows for LLM agents.

Usage: tgp <command> [args] [--pretty]

Agent loop:
  tgp templates                                  list workflow templates
  tgp start <template> [--param k=v]... [--title "..."] [--worker id]
  tgp next <run> [--worker id]                   get your current task(s). Safe to repeat.
  tgp done <run> <task> --result "..." [--artifact path]... [--output k=v]... [--worker id]
  tgp fail <run> <task> --error "..." [--worker id]
  tgp skip <run> <task> --reason "..."           only if the template marks the task skippable
  tgp heartbeat <run> <task> [--worker id]       extend the lease on a long task
  tgp status <run>                               progress and finished results, read only
  tgp runs                                       list runs

Human controls:
  tgp approve <run> <task> [--note "..."]        approve a task awaiting approval
  tgp reject <run> <task> [--note "..."]         send it back to the agent
  tgp retry <run> <task>                         reset a failed task
  tgp pause <run> | tgp resume <run> | tgp abort <run> [--reason "..."]

Other:
  tgp validate <file.yaml>                       check a workflow template
  tgp serve [--port 8787] [--host 127.0.0.1]     live canvas and REST API
  tgp mcp                                        stdio MCP server over the same core
  tgp notify-test                                fire a sample desktop notification (Windows toast)

Environment: TGP_HOME (data dir, default ~/.tgp, on Windows %USERPROFILE%\\.tgp), TGP_WORKER (default worker id),
  TGP_PORT (serve port, default 8787), TGP_PUBLIC_URL (canvas base, default http://localhost:<port>),
  TGP_WORKFLOWS (extra workflow dirs, separated by ";" on Windows and ":" elsewhere; TGP_TEMPLATES is the older
  name), TGP_SHELL (shell for command gates without shell:, default bash, cmd on Windows).
  $TGP_HOME/config.json may set {"port": 8788, "public_url": "..."} instead of the env vars.
  Notifications (Windows toasts): "notify": {"approval": true, "failed": true, "done": false} in config.json,
  TGP_NOTIFY=0 turns them off. Log: $TGP_HOME/notify.log.
Exit codes: 0 ok, 1 rejected or error, 2 usage error, 3 gate check failed.`;

function parseKv(list, flag) {
  const o = {};
  for (const kv of list || []) {
    const i = kv.indexOf('=');
    if (i < 1) throw new TgpError('USAGE', `--${flag} "${kv}" must look like key=value.`, `Example: --${flag} name=value`);
    o[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return o;
}

function need(v, what, usage) {
  if (v === undefined || v === true) throw new TgpError('USAGE', `Missing ${what}.`, `Usage: ${usage}`);
  return v;
}

export function pretty(env) {
  const L = [];
  if (env.templates) {
    L.push('Templates:');
    for (const t of env.templates) L.push(t.error ? `  ${t.name}  INVALID: ${t.error}` : `  ${t.name.padEnd(22)} ${t.tasks} tasks in ${t.stages} stages. ${t.title}`);
  } else if (env.runs) {
    L.push(env.runs.length ? 'Runs:' : 'No runs yet.');
    for (const r of env.runs) L.push(`  ${r.run_id.padEnd(28)} ${r.state.padEnd(18)} ${String(r.progress.completed).padStart(2)}/${r.progress.total}  ${r.title}`);
  } else if (env.file) {
    L.push(`${env.valid ? 'VALID' : 'INVALID'}: ${env.file}`);
    if (env.template) L.push(`  ${env.template.id}: ${env.template.tasks} tasks, ${env.template.stages} stages, gates: ${env.template.gate_types.join(', ')}`);
    for (const e of env.errors || []) L.push(`  - ${e}`);
  } else {
    const p = env.progress;
    L.push(`Run ${env.run_id ?? '-'}  [${env.state.toUpperCase()}]${p ? `  stage ${p.stage}/${p.stages_total}, ${p.completed}/${p.total} done` : ''}`);
    if (env.canvas_url) L.push(`Canvas: ${env.canvas_url}`);
    if (env.error) L.push(`ERROR ${env.error.code}: ${env.error.message}${env.error.hint ? `\n  hint: ${env.error.hint}` : ''}`);
    if (env.report) {
      L.push(`Report ${env.report.task_id}: ${env.report.status}`);
      for (const g of env.report.gate_results || []) L.push(`  ${g.passed === true ? 'PASS' : g.passed === false ? 'FAIL' : 'WAIT'}  ${g.label}\n        ${g.detail}`);
    }
    for (const t of env.tasks || []) {
      L.push(`\n  [${t.task_id}] ${t.title}  (${t.status}, stage ${t.stage} lane ${t.lane}, attempts ${t.attempts}/${t.max_attempts})`);
      if (t.description) L.push(`     ${t.description}`);
      if (t.done_when) L.push(`     done when: ${t.done_when}`);
      for (const g of t.gates) L.push(`     gate: ${g}`);
      if (t.outputs_required.length) L.push(`     required outputs: ${t.outputs_required.join(', ')}`);
      if (t.error) L.push(`     error: ${t.error}`);
      if (t.last_gate && !env.report) for (const g of t.last_gate.results.filter(x => x.passed === false)) L.push(`     last gate FAIL: ${g.label}: ${g.detail}`);
      if (t.report_with) L.push(`     report: ${t.report_with}`);
    }
    for (const h of env.history || []) L.push(`  done  [${h.task_id}] ${h.title}: ${h.status}${h.result ? `, ${h.result}` : ''}`);
  }
  if (env.instruction) L.push(`\n${env.instruction}`);
  return L.join('\n');
}

export async function main(argv) {
  let parsed;
  const out = (env, code = 0) => {
    const isPretty = parsed?.flags.pretty;
    process.stdout.write((isPretty ? pretty(env) : JSON.stringify(env, null, 2)) + '\n');
    process.exitCode = code;
  };
  let runId, worker;
  try {
    parsed = parseArgs(argv);
    const { pos, flags } = parsed;
    const [cmd, a1, a2] = pos;
    runId = a1;
    worker = flags.worker || process.env.TGP_WORKER || undefined;
    if (!cmd || flags.help || cmd === 'help') { process.stdout.write(HELP + '\n'); return; }
    const runUsage = `tgp ${cmd} <run>`;
    const taskUsage = `tgp ${cmd} <run> <task>`;
    let env;
    switch (cmd) {
      case 'templates': env = engine.listTemplates(); break;
      case 'start': runId = undefined; env = engine.startRun(need(a1, 'template name', 'tgp start <template>'), { params: parseKv(flags.param, 'param'), title: flags.title, worker }); break;
      case 'next': env = engine.next(need(a1, 'run id', runUsage), { worker }); break;
      case 'done': env = engine.done(need(a1, 'run id', taskUsage), need(a2, 'task id', taskUsage), { result: flags.result === true ? '' : flags.result, artifacts: flags.artifact || [], outputs: parseKv(flags.output, 'output'), worker }); break;
      case 'fail': env = engine.fail(need(a1, 'run id', taskUsage), need(a2, 'task id', taskUsage), { error: flags.error === true ? '' : flags.error, worker }); break;
      case 'skip': env = engine.skip(need(a1, 'run id', taskUsage), need(a2, 'task id', taskUsage), { reason: flags.reason === true ? '' : flags.reason, worker }); break;
      case 'heartbeat': env = engine.heartbeat(need(a1, 'run id', taskUsage), need(a2, 'task id', taskUsage), { worker }); break;
      case 'status': env = engine.status(need(a1, 'run id', runUsage), { worker }); break;
      case 'runs': env = engine.listRuns(); break;
      case 'approve': env = engine.approve(need(a1, 'run id', taskUsage), need(a2, 'task id', taskUsage), { note: flags.note || '', via: 'cli' }); break;
      case 'reject': env = engine.reject(need(a1, 'run id', taskUsage), need(a2, 'task id', taskUsage), { note: flags.note || '', via: 'cli' }); break;
      case 'retry': env = engine.retry(need(a1, 'run id', taskUsage), need(a2, 'task id', taskUsage), { via: 'cli' }); break;
      case 'pause': env = engine.pause(need(a1, 'run id', runUsage), { via: 'cli' }); break;
      case 'resume': env = engine.resume(need(a1, 'run id', runUsage), { via: 'cli' }); break;
      case 'abort': env = engine.abort(need(a1, 'run id', runUsage), { via: 'cli', reason: flags.reason || '' }); break;
      case 'validate': runId = undefined; env = engine.validate(need(a1, 'file', 'tgp validate <file.yaml>')); out(env, env.valid ? 0 : 1); return;
      case 'serve': { const { serve } = await import('./server.js'); await serve({ port: Number(flags.port || process.env.PORT || defaultPort()), host: flags.host || process.env.TGP_HOST || '127.0.0.1' }); return; }
      case 'mcp': { const { runMcp } = await import('./mcp.js'); await runMcp(); return; }
      case 'notify-test': {
        const r = await sendTest();
        const env = { state: r.ok ? 'ok' : 'error', notify: r,
          instruction: r.ok ? (r.shown === false ? `Not on Windows, the toast was only logged to ${r.log}.` : 'A test toast was sent. It should appear in the bottom right corner of the screen.') : `The toast failed: ${r.error}. See ${r.log}.` };
        process.stdout.write((parsed.flags.pretty ? `notify-test: ${env.state}\n${env.instruction}` : JSON.stringify(env, null, 2)) + '\n');
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
      default: throw new TgpError('USAGE', `Unknown command "${cmd}".`, 'Run: tgp help');
    }
    out(env, env.report?.gate_failed ? 3 : 0);
  } catch (e) {
    const env = engine.errorEnvelope(runId, worker, e);
    out(env, e instanceof TgpError && e.code === 'USAGE' ? 2 : 1);
  }
}

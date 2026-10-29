// tgp mcp: a minimal stdio MCP server (JSON-RPC 2.0, newline delimited) over the engine.
// Every tool returns the same envelope as the CLI, as JSON text.
import readline from 'node:readline';
import * as engine from './engine.js';
import { TgpError } from './util.js';

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const RUN = str('Run id returned by tgp_start');
const TASK = str('Task id from the tasks list of the last response');
const WORKER = str('Optional worker name, for parallel agents');
const MAP = d => ({ type: 'object', additionalProperties: { type: 'string' }, description: d });

const TOOLS = [
  { name: 'tgp_templates', description: 'List workflow templates that can be started.', inputSchema: S({}), run: () => engine.listTemplates() },
  { name: 'tgp_start', description: 'Start a run of a workflow template. Returns only the first open step. Then do ONLY the returned tasks.', inputSchema: S({ template: str('Template name, id or YAML path'), params: MAP('Template params'), title: str('Run title'), worker: WORKER }, ['template']),
    run: a => engine.startRun(a.template, { params: a.params || {}, title: a.title, worker: a.worker }) },
  { name: 'tgp_next', description: 'Get the tasks you must work on now. Safe to call repeatedly. Call it after any context loss.', inputSchema: S({ run_id: RUN, worker: WORKER }, ['run_id']), run: a => engine.next(a.run_id, { worker: a.worker }) },
  { name: 'tgp_done', description: 'Report a task as done with evidence. The engine checks the gates itself. On state gate_failed, fix the problem and report again.', inputSchema: S({ run_id: RUN, task_id: TASK, result: str('Concrete evidence of what you did'), outputs: MAP('Required outputs, key to value'), artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths of produced files' }, worker: WORKER }, ['run_id', 'task_id', 'result']),
    run: a => engine.done(a.run_id, a.task_id, { result: a.result, outputs: a.outputs || {}, artifacts: a.artifacts || [], worker: a.worker }) },
  { name: 'tgp_fail', description: 'Report that you cannot complete a task. This may block the run until a human acts.', inputSchema: S({ run_id: RUN, task_id: TASK, error: str('Why it failed'), worker: WORKER }, ['run_id', 'task_id', 'error']),
    run: a => engine.fail(a.run_id, a.task_id, { error: a.error, worker: a.worker }) },
  { name: 'tgp_skip', description: 'Skip a task that is marked skippable, with a reason.', inputSchema: S({ run_id: RUN, task_id: TASK, reason: str('Why it is skipped'), worker: WORKER }, ['run_id', 'task_id', 'reason']),
    run: a => engine.skip(a.run_id, a.task_id, { reason: a.reason, worker: a.worker }) },
  { name: 'tgp_status', description: 'Read only view of the run: open tasks and finished history. Never shows locked future steps.', inputSchema: S({ run_id: RUN, worker: WORKER }, ['run_id']), run: a => engine.status(a.run_id, { worker: a.worker }) },
  { name: 'tgp_runs', description: 'List runs, to find one to resume.', inputSchema: S({}), run: () => engine.listRuns() },
];

export function handle(msg) {
  const { id, method, params } = msg;
  const reply = result => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tgp', version: '0.1.0' },
        instructions: 'TGP gates multi step work. Loop: tgp_next, do ONLY the returned tasks, report each with tgp_done and evidence, follow the instruction field. Never work ahead.' });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params?.name);
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } };
      let env, isError = false;
      try { env = tool.run(params.arguments || {}); } catch (e) {
        isError = true;
        const err = e instanceof TgpError ? e : new TgpError('INTERNAL', String(e?.message || e), 'Report this to the human.');
        try { env = engine.errorEnvelope(params.arguments?.run_id, params.arguments?.worker, err); } catch { env = { state: 'rejected', error: err.toJSON() }; }
      }
      return reply({ content: [{ type: 'text', text: JSON.stringify(env, null, 2) }], isError });
    }
    default:
      if (id === undefined || id === null) return null; // notification
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export function runMcp() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
    const out = handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
  return new Promise(r => rl.on('close', r));
}

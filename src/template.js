// Workflow templates: YAML load, normalization and validation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { TgpError, tgpHome, refsIn } from './util.js';
import { SHELLS } from './gates.js';

export const GATE_TYPES = {
  file_exists: { required: ['path'], optional: ['min_bytes', 'kind'] },
  glob_count: { required: ['pattern'], optional: ['cwd', 'min', 'max', 'eq', 'include_dirs'] },
  json_has_keys: { required: ['path'], optional: ['keys', 'equals'] },
  regex_in_file: { required: ['path', 'pattern'], optional: ['flags', 'min_matches'] },
  command: { required: ['run'], optional: ['cwd', 'timeout_s', 'expect_exit', 'shell'] },
  media_duration: { required: ['path'], optional: ['min_s', 'max_s'] },
  result_matches: { required: ['pattern'], optional: ['flags'] },
  manual: { required: [], optional: ['prompt'] },
};
const COMMON_GATE_KEYS = ['type', 'hint', 'label'];
const BUILTIN_REFS = ['run_id', 'tgp_home', 'tmp'];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILTIN_WORKFLOWS = path.join(REPO_ROOT, 'workflows');

// Directory lists use the platform separator: ";" on Windows, ":" elsewhere.
const splitDirs = v => String(v || '').split(path.delimiter).map(s => s.trim()).filter(Boolean);

// Search order: TGP_WORKFLOWS, TGP_TEMPLATES (older name), $TGP_HOME/workflows, then the
// workflows/ folder of this project. The first file with a given name wins.
export function templateDirs() {
  const dirs = [];
  dirs.push(...splitDirs(process.env.TGP_WORKFLOWS));
  dirs.push(...splitDirs(process.env.TGP_TEMPLATES));
  dirs.push(path.join(tgpHome(), 'workflows'));
  dirs.push(BUILTIN_WORKFLOWS);
  return dirs.map(d => path.resolve(d));
}

export function listTemplateFiles() {
  const seen = new Map();
  for (const dir of templateDirs()) {
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch { continue; }
    for (const f of ents.sort()) {
      if (!/\.ya?ml$/i.test(f)) continue;
      const name = f.replace(/\.ya?ml$/i, '');
      if (!seen.has(name)) seen.set(name, path.join(dir, f));
    }
  }
  return seen;
}

export function resolveTemplate(ref) {
  if (!ref) throw new TgpError('TEMPLATE_REQUIRED', 'No template given.', 'Usage: tgp start <template>. List templates with: tgp templates');
  if (ref.includes('/') || ref.includes('\\') || path.isAbsolute(ref) || /\.ya?ml$/i.test(ref)) {
    const p = path.resolve(ref);
    if (!fs.existsSync(p)) throw new TgpError('TEMPLATE_NOT_FOUND', `Template file ${p} does not exist.`, 'Pass a template name from tgp templates, or a path to a YAML file.', 404);
    return p;
  }
  const files = listTemplateFiles();
  if (files.has(ref)) return files.get(ref);
  for (const [, p] of files) {
    try { if (parseFile(p).raw?.id === ref) return p; } catch { /* skip broken */ }
  }
  throw new TgpError('TEMPLATE_NOT_FOUND', `No template named "${ref}".`, `Available: ${[...files.keys()].join(', ') || 'none'}. Run: tgp templates`, 404);
}

function parseFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  let raw;
  try { raw = YAML.parse(text); } catch (e) {
    throw new TgpError('TEMPLATE_INVALID', `YAML parse error in ${file}: ${e.message}`, 'Fix the YAML syntax and run: tgp validate <file>');
  }
  return { raw, text };
}

// Returns { template, errors[] }. template is normalized even when errors exist (best effort).
export function normalizeTemplate(raw, source = '<inline>') {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { template: null, errors: ['template: must be a YAML mapping with id, title and stages'] };
  }
  const id = raw.id ?? path.basename(String(source)).replace(/\.ya?ml$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-]*$/.test(String(id))) err('id', 'must be letters, digits, dash or underscore');
  const settings = {
    stop_on_fail: raw.settings?.stop_on_fail ?? true,
    max_attempts: raw.settings?.max_attempts ?? 3,
    lease_s: raw.settings?.lease_s ?? 600,
  };
  if (!(Number.isInteger(settings.max_attempts) && settings.max_attempts >= 1)) err('settings.max_attempts', 'must be an integer >= 1');
  if (!(Number(settings.lease_s) > 0)) err('settings.lease_s', 'must be a positive number of seconds');

  const params = {};
  const rawParams = raw.params ?? {};
  if (typeof rawParams !== 'object' || Array.isArray(rawParams)) err('params', 'must be a mapping of name to {default, description, required}');
  else for (const [k, v] of Object.entries(rawParams)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) err(`params.${k}`, 'invalid parameter name');
    if (v !== null && typeof v === 'object') params[k] = { default: v.default ?? null, description: v.description ?? '', required: !!v.required };
    else params[k] = { default: v ?? null, description: '', required: false };
  }
  if (!params.workdir) params.workdir = { default: '{{tgp_home}}/work/{{run_id}}', description: 'Working directory for this run', required: false };

  let rawStages;
  if (Array.isArray(raw.stages)) rawStages = raw.stages;
  else if (Array.isArray(raw.tasks)) rawStages = raw.tasks.map(t => [t]);
  else { err('stages', 'missing. Provide stages (list of stages) or tasks (flat list, one task per stage)'); rawStages = []; }

  const stages = [];
  const taskStage = new Map();
  rawStages.forEach((s, si) => {
    const where = `stages[${si}]`;
    let title = '', rawTasks;
    if (Array.isArray(s)) rawTasks = s;
    else if (s && Array.isArray(s.tasks)) { rawTasks = s.tasks; title = s.title ?? ''; }
    else if (s && typeof s === 'object' && (s.title || s.gates)) rawTasks = [s];
    else { err(where, 'must be a list of tasks or {title, tasks}'); rawTasks = []; }
    if (!rawTasks.length) err(where, 'has no tasks');
    const tasks = rawTasks.map((t, li) => {
      const tw = `${where}.tasks[${li}]`;
      if (!t || typeof t !== 'object') { err(tw, 'must be a mapping'); return null; }
      const tid = String(t.id ?? `s${si + 1}_${li + 1}`);
      if (!/^[A-Za-z0-9][A-Za-z0-9_\-]*$/.test(tid)) err(tw, `task id "${tid}" must be letters, digits, dash or underscore`);
      if (taskStage.has(tid)) err(tw, `duplicate task id "${tid}"`);
      taskStage.set(tid, si);
      if (!t.title) err(tw, 'title is required');
      let gates = t.gates ?? (t.gate ? [t.gate] : []);
      if (!Array.isArray(gates)) { err(`${tw}.gates`, 'must be a list'); gates = []; }
      if (!gates.length) err(`${tw}.gates`, 'every task needs at least one gate, the engine checks completion itself');
      gates.forEach((g, gi) => {
        const gw = `${tw}.gates[${gi}]`;
        const spec = GATE_TYPES[g?.type];
        if (!spec) { err(gw, `unknown gate type "${g?.type}". Known: ${Object.keys(GATE_TYPES).join(', ')}`); return; }
        for (const r of spec.required) if (g[r] === undefined || g[r] === '') err(gw, `${g.type} needs "${r}"`);
        for (const k of Object.keys(g)) if (![...spec.required, ...spec.optional, ...COMMON_GATE_KEYS].includes(k)) err(gw, `unknown key "${k}" for ${g.type}`);
        if (g.pattern !== undefined && g.type !== 'glob_count') {
          try { new RegExp(g.pattern, g.flags ?? ''); } catch (e) { err(gw, `bad regex: ${e.message}`); }
        }
        if (g.type === 'json_has_keys' && !g.keys && !g.equals) err(gw, 'json_has_keys needs "keys" or "equals"');
        if (g.type === 'json_has_keys' && g.keys && !Array.isArray(g.keys)) err(gw, '"keys" must be a list');
        if (g.type === 'command' && g.shell !== undefined && !SHELLS.includes(g.shell)) err(gw, `shell must be one of ${SHELLS.join(', ')}`);
        if (g.type === 'command' && g.timeout_s !== undefined && !(g.timeout_s > 0 && g.timeout_s <= 3600)) err(gw, 'timeout_s must be between 0 and 3600');
        if (g.type === 'file_exists' && g.kind && !['file', 'dir', 'any'].includes(g.kind)) err(gw, 'kind must be file, dir or any');
      });
      const outputs = t.outputs ?? [];
      if (!Array.isArray(outputs)) err(`${tw}.outputs`, 'must be a list of output keys the agent must report');
      return {
        task_id: tid,
        title: String(t.title ?? ''),
        description: String(t.description ?? ''),
        done_when: String(t.done_when ?? ''),
        skippable: !!t.skippable,
        max_attempts: t.max_attempts ?? null,
        outputs_required: Array.isArray(outputs) ? outputs.map(String) : [],
        gates: gates.filter(g => GATE_TYPES[g?.type]),
      };
    }).filter(Boolean);
    stages.push({ title: String(title), tasks });
  });

  // reference checks: params must exist, task refs must point at earlier stages
  const pnames = new Set(Object.keys(params));
  stages.forEach((s, si) => s.tasks.forEach(t => {
    for (const ref of refsIn([t.title, t.description, t.done_when, t.gates])) {
      const p = ref.split('.');
      if (BUILTIN_REFS.includes(ref)) continue;
      if (p[0] === 'params') { if (!pnames.has(p[1])) err(`task ${t.task_id}`, `unknown param in {{${ref}}}`); continue; }
      if (p[0] === 'tasks') {
        const ts = taskStage.get(p[1]);
        if (ts === undefined) err(`task ${t.task_id}`, `{{${ref}}} references unknown task "${p[1]}"`);
        else if (ts >= si) err(`task ${t.task_id}`, `{{${ref}}} must reference a task in an earlier stage`);
        else if (p[2] === 'outputs') {
          const target = stages[ts]?.tasks.find(x => x.task_id === p[1]);
          if (target && !target.outputs_required.includes(p[3])) err(`task ${t.task_id}`, `{{${ref}}}: task "${p[1]}" does not declare output "${p[3]}" in outputs`);
        } else if (p[2] !== 'result') err(`task ${t.task_id}`, `{{${ref}}}: use tasks.<id>.outputs.<key> or tasks.<id>.result`);
        continue;
      }
      if (p.length === 1 && pnames.has(ref)) continue;
      err(`task ${t.task_id}`, `unknown reference {{${ref}}}`);
    }
  }));
  for (const [k, v] of Object.entries(params)) {
    for (const ref of refsIn(v.default)) if (!BUILTIN_REFS.includes(ref) && !pnames.has(ref.replace(/^params\./, ''))) err(`params.${k}`, `unknown reference {{${ref}}}`);
  }

  return {
    template: { tgp: 1, id: String(id), title: String(raw.title ?? id), description: String(raw.description ?? ''), params, settings, stages, source: String(source) },
    errors,
  };
}

export function loadTemplate(ref) {
  const file = resolveTemplate(ref);
  const { raw } = parseFile(file);
  const { template, errors } = normalizeTemplate(raw, file);
  if (errors.length) throw new TgpError('TEMPLATE_INVALID', `Template ${file} is invalid: ${errors.join('; ')}`, `Fix the template and run: tgp validate ${file}`);
  return template;
}

export function validateFile(file) {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) throw new TgpError('FILE_NOT_FOUND', `File ${p} does not exist.`, 'Pass the path to a workflow YAML file.', 404);
  let raw;
  try { raw = parseFile(p).raw; } catch (e) { return { file: p, valid: false, errors: [e.message], template: null }; }
  const { template, errors } = normalizeTemplate(raw, p);
  return { file: p, valid: errors.length === 0, errors, template };
}

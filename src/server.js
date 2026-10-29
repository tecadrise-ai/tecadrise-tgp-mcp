// tgp serve: REST API, SSE live updates and the canvas UI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from './engine.js';
import * as store from './store.js';
import { TgpError, tgpHome } from './util.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const POLL_MS = 150;

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}
function sendErr(res, e) {
  const err = e instanceof TgpError ? e : new TgpError('INTERNAL', String(e?.message || e), 'Check serve.log.', 500);
  send(res, err.httpStatus || 400, { error: err.toJSON() });
}
async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw new TgpError('BODY_TOO_LARGE', 'Request body too large.', '', 413); }
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw new TgpError('BAD_JSON', 'Body is not valid JSON.', 'Send application/json.'); }
}
const page = name => fs.readFileSync(path.join(WEB, name), 'utf8');

// One watcher per run, shared by all SSE clients of that run.
const watchers = new Map();
function subscribe(runId, res) {
  let w = watchers.get(runId);
  if (!w) {
    w = { clients: new Set(), key: store.changeKey(runId), timer: null };
    w.timer = setInterval(() => {
      const k = store.changeKey(runId);
      if (k === w.key) return;
      w.key = k;
      let snap;
      try { snap = engine.snapshot(runId); } catch { return; }
      const msg = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
      for (const c of w.clients) c.write(msg);
    }, POLL_MS);
    watchers.set(runId, w);
  }
  w.clients.add(res);
  return () => {
    w.clients.delete(res);
    if (!w.clients.size) { clearInterval(w.timer); watchers.delete(runId); }
  };
}

const listClients = new Set();
let listKey = '';
setInterval(() => {
  if (!listClients.size) return;
  const ids = store.listRunIds();
  const k = ids.map(id => id + store.changeKey(id)).join('|');
  if (k === listKey) return;
  listKey = k;
  const msg = `event: runs\ndata: ${JSON.stringify(engine.listRuns().runs)}\n\n`;
  for (const c of listClients) c.write(msg);
}, 400).unref();

function sseStart(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 1000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(ping));
}

const ACTIONS = {
  pause: (id, b) => engine.pause(id, { via: 'canvas' }),
  resume: (id, b) => engine.resume(id, { via: 'canvas' }),
  abort: (id, b) => engine.abort(id, { via: 'canvas', reason: b.reason || '' }),
};
const TASK_ACTIONS = {
  approve: (id, t, b) => engine.approve(id, t, { via: 'canvas', note: b.note || '' }),
  reject: (id, t, b) => engine.reject(id, t, { via: 'canvas', note: b.note || '' }),
  retry: (id, t, b) => engine.retry(id, t, { via: 'canvas' }),
  skip: (id, t, b) => engine.skip(id, t, { actor: 'human', reason: b.reason || 'skipped by human on the canvas' }),
};

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = (re) => p.match(re);
    let mm;
    try {
      if (req.method === 'GET' && p === '/') return send(res, 200, page('runs.html'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && (mm = m(/^\/r\/([^/]+)$/))) return send(res, 200, page('canvas.html'), 'text/html; charset=utf-8');
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, tgp_home: tgpHome(), runs: store.listRunIds().length });
      if (req.method === 'GET' && p === '/api/v1/templates') return send(res, 200, engine.listTemplates().templates);
      if (req.method === 'GET' && p === '/api/v1/runs') return send(res, 200, engine.listRuns().runs);
      if (req.method === 'GET' && p === '/api/v1/runs/stream') {
        sseStart(req, res);
        res.write(`event: runs\ndata: ${JSON.stringify(engine.listRuns().runs)}\n\n`);
        listClients.add(res); req.on('close', () => listClients.delete(res));
        return;
      }
      if (req.method === 'POST' && p === '/api/v1/runs') {
        const b = await readBody(req);
        return send(res, 201, engine.startRun(b.template, { params: b.params || {}, title: b.title, worker: b.worker }));
      }
      if ((mm = m(/^\/api\/v1\/runs\/([^/]+)$/)) && req.method === 'GET') return send(res, 200, engine.snapshot(decodeURIComponent(mm[1])));
      if ((mm = m(/^\/api\/v1\/runs\/([^/]+)\/agent$/)) && req.method === 'GET') return send(res, 200, engine.status(decodeURIComponent(mm[1]), { worker: url.searchParams.get('worker') || undefined }));
      if ((mm = m(/^\/api\/v1\/runs\/([^/]+)\/events$/)) && req.method === 'GET') {
        const id = decodeURIComponent(mm[1]);
        const snap = engine.snapshot(id); // throws 404 before SSE starts
        sseStart(req, res);
        res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
        const unsub = subscribe(id, res);
        req.on('close', unsub);
        return;
      }
      if ((mm = m(/^\/api\/v1\/runs\/([^/]+)\/(pause|resume|abort)$/)) && req.method === 'POST') {
        const b = await readBody(req);
        ACTIONS[mm[2]](decodeURIComponent(mm[1]), b);
        return send(res, 200, engine.snapshot(decodeURIComponent(mm[1])));
      }
      if ((mm = m(/^\/api\/v1\/runs\/([^/]+)\/tasks\/([^/]+)\/(approve|reject|retry|skip)$/)) && req.method === 'POST') {
        const b = await readBody(req);
        const id = decodeURIComponent(mm[1]);
        TASK_ACTIONS[mm[3]](id, decodeURIComponent(mm[2]), b);
        return send(res, 200, engine.snapshot(id));
      }
      if ((mm = m(/^\/api\/v1\/runs\/([^/]+)\/logs\/([^/]+)$/)) && req.method === 'GET') {
        const id = decodeURIComponent(mm[1]); store.assertRunId(id);
        const f = path.basename(decodeURIComponent(mm[2]));
        const fp = path.join(store.logDir(id), f);
        if (!fs.existsSync(fp)) throw new TgpError('NOT_FOUND', 'Log not found.', '', 404);
        return send(res, 200, fs.readFileSync(fp, 'utf8'), 'text/plain; charset=utf-8');
      }
      throw new TgpError('NOT_FOUND', `No route for ${req.method} ${p}.`, 'See README, HTTP API section.', 404);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      sendErr(res, e);
    }
  });
}

export function serve({ port = 8787, host = '127.0.0.1' } = {}) {
  const server = createServer();
  return new Promise(resolve => {
    server.listen(port, host, () => {
      console.log(`[tgp] serving on http://${host}:${port}  TGP_HOME=${tgpHome()}  (${new Date().toISOString()})`);
      resolve(server);
    });
  });
}
